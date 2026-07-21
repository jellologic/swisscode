// Inherited-environment hygiene.
//
// A variable the user exported months ago in a shell profile outranks nothing
// here — the profile always wins, because buildEnvPlan writes unconditionally.
// The problem is that winning SILENTLY is indistinguishable from not having
// been in conflict at all, and one of these conflicts spends real money.
//
// So: detect, report on stderr, change nothing. Every warning below describes a
// decision that was already made, which is why they are informational and why
// suppressing them is safe.
//
// PERFORMANCE CONTRACT (this runs on every launch):
// nothing here iterates the ambient environment. It walks the plan — a dozen
// keys the launch is already touching — and does a hash lookup per key. A clean
// environment therefore costs a dozen misses and produces zero warnings.
// Scanning process.env for ANTHROPIC_*/CLAUDE_CODE_* would be O(env size) for
// no extra signal: a variable we do not set cannot conflict with us.

import { TIER_ENV_VARS } from './tiers.ts'
import { SUFFIX, bareModelId, supportsExtendedContext } from './context.ts'
import type { Profile } from '../ports/config-store.ts'
import type { ProviderDescriptor } from '../ports/provider.ts'
import type { EnvMap } from '../ports/process.ts'

/** Highest-cost failure mode in the tool: it bills someone else's account. */
export const BILLING_KEY = 'ANTHROPIC_API_KEY'

/**
 * `high` and `medium` both surface; `info` is reported but never treated as a
 * conflict — core/doctor.ts maps it to an `ok` check rather than a warning, so
 * the distinction is load-bearing for the exit code.
 */
export type WarningSeverity = 'high' | 'medium' | 'info'

export type EnvWarning = {
  severity: WarningSeverity
  code: string
  message: string
}

/**
 * The two fields of a plan that hygiene actually reads. Narrower than the plan
 * env.ts builds, on purpose: this module inspects a decision that has already
 * been made and must not be able to reach into the rest of it.
 */
export type PlanFacts = {
  set: Record<string, string>
  unset: string[]
}

export type HygieneContext = {
  provider?: ProviderDescriptor | null
  profile?: Profile | null
}

const w = (severity: WarningSeverity, code: string, message: string): EnvWarning => ({
  severity,
  code,
  message,
})

export function inspectAmbient(
  plan: PlanFacts,
  ambientEnv: EnvMap = {},
  ctx: HygieneContext = {},
): EnvWarning[] {
  const warnings: EnvWarning[] = []
  const set = plan?.set ?? {}
  const unset = plan?.unset ?? []
  const seen = new Set<string>()

  // ---- 1. The billing one. Deliberately first and deliberately loud. -------
  // A stale ANTHROPIC_API_KEY makes Claude Code fall back to Anthropic and bill
  // that account for traffic the user believes is going to a gateway they have
  // already paid for. Nothing else in this tool costs money by being quiet.
  const staleKey = ambientEnv[BILLING_KEY]
  if (staleKey && unset.includes(BILLING_KEY)) {
    seen.add(BILLING_KEY)
    warnings.push(
      w(
        'high',
        'stale-anthropic-key',
        `a stale ${BILLING_KEY} was set in your environment. cuckoocode removed ` +
          'it for this launch so these requests are not billed to your Anthropic ' +
          `account. Unset it in your shell to silence this: unset ${BILLING_KEY}`,
      ),
    )
  } else if (staleKey && set[BILLING_KEY] !== undefined && set[BILLING_KEY] !== staleKey) {
    seen.add(BILLING_KEY)
    warnings.push(
      w(
        'high',
        'ambient-anthropic-key',
        `${BILLING_KEY} was already set in your environment and this profile ` +
          'replaced it. Requests are billed against the profile key, not the ' +
          'one in your shell.',
      ),
    )
  }

  // ---- 2. Base URL: the other way traffic goes somewhere unintended. -------
  const ambientUrl = ambientEnv.ANTHROPIC_BASE_URL
  if (ambientUrl) {
    seen.add('ANTHROPIC_BASE_URL')
    const effective = set.ANTHROPIC_BASE_URL
    if (effective === undefined && unset.includes('ANTHROPIC_BASE_URL')) {
      warnings.push(
        w(
          'high',
          'ambient-base-url',
          `ANTHROPIC_BASE_URL was set to ${ambientUrl} in your environment; this ` +
            'profile talks to Anthropic directly, so it was cleared for this launch.',
        ),
      )
    } else if (effective !== undefined && effective !== ambientUrl) {
      warnings.push(
        w(
          'high',
          'ambient-base-url',
          `ANTHROPIC_BASE_URL was set to ${ambientUrl} in your environment; this ` +
            `profile overrode it with ${effective}.`,
        ),
      )
    }
  }

  // ---- 3. Tier models. ----------------------------------------------------
  const clobberedTiers: string[] = []
  for (const v of TIER_ENV_VARS) {
    const ambient = ambientEnv[v]
    if (!ambient) continue
    seen.add(v)
    const effective = set[v]
    if (effective === ambient) continue
    clobberedTiers.push(effective === undefined ? `${v} (cleared)` : `${v}=${effective}`)
  }
  if (clobberedTiers.length > 0) {
    warnings.push(
      w(
        'medium',
        'ambient-tier-model',
        'model variables inherited from your environment were overridden for ' +
          `this launch: ${clobberedTiers.join(', ')}.`,
      ),
    )
  }

  // ---- 4. Everything else the profile and the shell both touch. -----------
  // Bounded by the plan, not by the environment.
  const alsoSet: string[] = []
  for (const key of Object.keys(set)) {
    if (seen.has(key) || !isClaudeVar(key)) continue
    if (ambientEnv[key] !== undefined && ambientEnv[key] !== set[key]) {
      alsoSet.push(key)
    }
  }
  for (const key of unset) {
    if (seen.has(key) || !isClaudeVar(key)) continue
    if (ambientEnv[key] !== undefined) alsoSet.push(`${key} (cleared)`)
  }
  if (alsoSet.length > 0) {
    warnings.push(
      w(
        'medium',
        'ambient-override',
        `these variables were set in your environment and this profile took ` +
          `precedence: ${alsoSet.sort().join(', ')}.`,
      ),
    )
  }

  // ---- 4b. The one variable worth looking up that we do not set. ----------
  // CLAUDE_CODE_DISABLE_1M_CONTEXT turns the extended-context window off
  // wholesale. Because cuckoocode never sets it, the plan-walk above cannot see
  // it — and a user who has it exported gets every [1m] this tool carefully
  // derived silently ignored, with a config that still reads as correct.
  //
  // That is worth one hash lookup. It is a targeted exception to the
  // walk-the-plan rule, not a licence to start scanning the environment.
  //
  // The name is confirmed present in the env-var table of claude 2.1.216; what
  // it does beyond gating the suffix check has not been verified here.
  if (ambientEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT && ctx.provider?.extendedContext?.supported) {
    warnings.push(
      w(
        'high',
        'extended-context-disabled',
        'CLAUDE_CODE_DISABLE_1M_CONTEXT is set in your environment, which turns ' +
          'off the extended context window this provider supports. The [1m] ' +
          'model suffix will have no effect until you unset it.',
      ),
    )
  }

  // ---- 5. The tripwire for the bug this whole phase exists to kill. -------
  // [1m] is read PER VARIABLE. Three suffixed tiers and one bare one is not a
  // partial win, it is a tier that silently runs at the assumed window while
  // everything looks configured. Structurally impossible to hit by omission now
  // that the tier loop is a table, but a user CAN pin one tier to a model the
  // provider does not serve at 1M, and that is worth saying out loud.
  const ec = ctx.provider?.extendedContext
  if (ec?.supported) {
    const bare: string[] = []
    for (const v of TIER_ENV_VARS) {
      const value = set[v]
      if (!value || String(value).endsWith(SUFFIX)) continue
      bare.push(`${v}=${value}`)
    }
    if (bare.length > 0) {
      warnings.push(
        w(
          'medium',
          'unsuffixed-tier',
          // `ctx.provider?.` rather than `ctx.provider.`: reaching `ec.supported`
          // already proves `ctx.provider` is present, but that runs through an
          // optional chain the compiler will not carry into a separate
          // reference. The two differ only on a path that cannot be taken.
          `${ctx.provider?.label ?? ctx.provider?.id} serves an extended context ` +
            `window, but ${bare.join(', ')} is not one of the models documented ` +
            `to support it, so that tier runs at the standard window. ` +
            `Extended-context models: ${ec.models.join(', ')}.`,
        ),
      )
    }
  }

  // ---- 6. Informational: what this launch changed about the gateway. ------
  const compat = Object.keys(set).filter(isCompatVar)
  if (compat.length > 0) {
    warnings.push(
      w(
        'info',
        'compat-flags-active',
        `gateway compatibility flags active: ${compat.sort().join(', ')}.`,
      ),
    )
  }

  return warnings
}

function isClaudeVar(key: string): boolean {
  return key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_')
}

function isCompatVar(key: string): boolean {
  return (
    key.startsWith('CLAUDE_CODE_DISABLE_') ||
    key.startsWith('CLAUDE_CODE_SKIP_') ||
    key === 'CLAUDE_CODE_ATTRIBUTION_HEADER' ||
    key === 'ENABLE_TOOL_SEARCH' ||
    key === 'API_FORCE_IDLE_TIMEOUT'
  )
}

/** A stored id whose `[1m]` suffix disagrees with what the provider documents. */
export type StaleStoredModel = {
  tier: string
  stored: string
  suggested: string
  reason: 'missing' | 'unsupported'
}

/**
 * A stored model id that a provider does not serve at 1M, reported so the
 * wizard and `config doctor` can offer a repair. Pure lookup, no rewrite:
 * buildEnvPlan already strips an unsupported suffix at launch, so this is
 * advice about stored data rather than a correctness fix.
 */
export function staleStoredModels(
  profile: Profile | null | undefined,
  provider: ProviderDescriptor | null | undefined,
): StaleStoredModel[] {
  const ec = provider?.extendedContext
  const out: StaleStoredModel[] = []
  for (const [tier, id] of Object.entries(profile?.models ?? {})) {
    if (!id) continue
    const hasSuffix = String(id).endsWith(SUFFIX)
    const supported = supportsExtendedContext(id, ec)
    if (supported && !hasSuffix) {
      out.push({ tier, stored: id, suggested: bareModelId(id) + SUFFIX, reason: 'missing' })
    } else if (!supported && hasSuffix) {
      out.push({ tier, stored: id, suggested: bareModelId(id), reason: 'unsupported' })
    }
  }
  return out
}
