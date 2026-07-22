// The Claude Code env-building algorithm. Pure: ambient env arrives as a
// parameter and nothing here reads process.env, which is what makes the two
// highest-cost failure modes in this tool assertable in a unit test.
//
// This is the heart of the Claude Code adapter — every ANTHROPIC_*/CLAUDE_CODE_*
// variable this tool emits is chosen here. The generic accumulator it is built
// on (makeEnvWriter, materializeEnv) is neutral and lives in core/env-plan.ts.

import { TIERS } from '../../../core/tiers.ts'
import { definedEntriesOf, makeEnvWriter, resolveCredential } from '../../../core/env-plan.ts'
import { TIER_ENV } from './tiers.ts'
import { autoCompactWindow, withExtendedContext } from './context.ts'
import { inspectAmbient } from './hygiene.ts'
import type { Profile } from '../../../ports/config-store.ts'
import type { ClaudeCodeCompatEnv, ClaudeCodeCompatFlag } from '../../../ports/claude-code.ts'
import type { ProviderDescriptor, ResolvedModels, Tier } from '../../../ports/provider.ts'
import type { EnvMap } from '../../../ports/process.ts'
import type { EnvWarning } from '../../../ports/agent.ts'

/**
 * CompatFlags -> env var. Descriptors never spell a variable name; they set a
 * boolean and this table decides what that means. Each entry below has a
 * documented symptom it addresses.
 *
 * `satisfies Record<ClaudeCodeCompatFlag, ...>` makes the table EXHAUSTIVE:
 * adding a flag to the port without adding its variable here is a compile error.
 * The `Record<string, ...>` annotation is what the lookups below need, since
 * they index with a key that came back from `Object.entries` (a plain string).
 *
 * A `consequence` marks a flag that TRADES SOMETHING AWAY. The loop below turns
 * one into an EnvWarning, which is what lets a flag like
 * disableNonessentialTraffic exist at all — see ports/claude-code.ts for why
 * that replaced a deny-list.
 */
export const COMPAT_ENV: Record<string, ClaudeCodeCompatEnv> = Object.freeze({
  // "400 Extra inputs are not permitted"
  disableExperimentalBetas: { env: 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', value: '1' },
  // "400 Input tag 'adaptive' found"
  disableAdaptiveThinking: { env: 'CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', value: '1' },
  // fast mode reported as "disabled by organization"
  skipFastModeOrgCheck: { env: 'CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK', value: '1' },
  // MCP tool search is off by default away from first-party
  enableToolSearch: { env: 'ENABLE_TOOL_SEARCH', value: '1' },
  // stalls on slow or locally hosted models
  forceIdleTimeoutOff: { env: 'API_FORCE_IDLE_TIMEOUT', value: '0' },
  // improves prompt-cache hit rate through gateways
  dropAttributionHeader: { env: 'CLAUDE_CODE_ATTRIBUTION_HEADER', value: '0' },
  // an endpoint that degrades under Claude Code's background requests — e.g.
  // Ollama, whose /v1/messages/count_tokens?beta=true 404s (ollama/ollama#13949)
  disableNonessentialTraffic: {
    env: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    value: '1',
    consequence:
      'gateway model discovery is disabled too, so Claude Code can no longer ask the ' +
      'endpoint which models it serves — pin every tier explicitly',
  },
}) satisfies Record<ClaudeCodeCompatFlag, ClaudeCodeCompatEnv>

/**
 * The finished plan, Claude-Code-internal shape. `set`/`unset` are the neutral
 * half (assignable to ports/agent.ts `EnvPlan`); `warnings` and `resolvedModels`
 * are extra context the adapter and its tests read.
 */
export type EnvPlan = {
  set: Record<string, string>
  unset: string[]
  warnings: EnvWarning[]
  /**
   * Every tier this launch answered for. `undefined` means "nothing pinned,
   * clear the variable".
   */
  resolvedModels: Partial<ResolvedModels>
}

export function buildEnvPlan(
  profile: Profile | null | undefined,
  provider: ProviderDescriptor | null | undefined,
  ambientEnv: EnvMap = {},
): EnvPlan {
  const { set, unset, write } = makeEnvWriter()

  // 1. Base URL, UNCONDITIONALLY. A provider whose baseUrl is null (Anthropic
  //    direct) must CLEAR a gateway URL left in the shell, not inherit it.
  write('ANTHROPIC_BASE_URL', profile?.baseUrl ?? provider?.baseUrl ?? '')

  // 2. Descriptor env. Descriptors use the explicit set/unset split; '' as a
  //    sentinel is banned there and enforced by test/registry.test.ts.
  for (const [k, v] of Object.entries(provider?.env ?? {})) write(k, v)
  for (const k of provider?.unsetEnv ?? []) write(k, '')

  // 3. Compatibility switches. The provider ships defaults; the profile may
  //    override any individual key, including turning one OFF.
  //
  //    A flag carrying a `consequence` announces it. Severity depends on WHO
  //    asked: a provider default is something the user did not choose, so it
  //    surfaces on stderr every launch; a profile that names the flag itself is
  //    an explicit choice already made, so it stays `info` — reported by the
  //    doctor, never nagged about. Same distinction the profile banner draws.
  const compatWarnings: EnvWarning[] = []
  const announce = (flag: string, entry: ClaudeCodeCompatEnv, chosenByProfile: boolean): void => {
    if (!entry.consequence) return
    compatWarnings.push({
      severity: chosenByProfile ? 'info' : 'medium',
      code: 'compat-consequence',
      message:
        `compat flag "${flag}" is on${chosenByProfile ? '' : ' by provider default'}: ` +
        entry.consequence,
    })
  }

  const profileCompat = definedEntriesOf(profile?.compat)
  for (const [flag, on] of Object.entries(provider?.compat ?? {})) {
    if (!on || flag in profileCompat) continue
    const mapped = COMPAT_ENV[flag]
    if (!mapped) continue
    write(mapped.env, mapped.value)
    announce(flag, mapped, false)
  }
  for (const [flag, on] of Object.entries(profileCompat)) {
    const mapped = COMPAT_ENV[flag]
    if (!mapped) continue
    write(mapped.env, on ? mapped.value : '')
    if (on) announce(flag, mapped, true)
  }

  // 4. Structural billing guard. A stale ANTHROPIC_API_KEY in the shell makes
  //    Claude Code fall back to Anthropic and bill the wrong account.
  const effectiveBaseUrl = set.get('ANTHROPIC_BASE_URL') ?? null
  if (effectiveBaseUrl && provider?.credentialEnv !== 'ANTHROPIC_API_KEY') {
    write('ANTHROPIC_API_KEY', '')
  }

  // 5. Credential, unconditionally — an empty one clears a stale variable.
  //    `defaultCredential` covers the keyless endpoint: a local Ollama ignores
  //    the token entirely (verified: no header, a wrong key and a bearer token
  //    all behave identically), but Claude Code still wants the variable to
  //    carry something, so the descriptor supplies the placeholder rather than
  //    every user being told to invent one.
  const credentialEnv = provider?.credentialEnv ?? 'ANTHROPIC_AUTH_TOKEN'
  write(credentialEnv, resolveCredential(profile, ambientEnv) || (provider?.defaultCredential ?? ''))

  // 6. All four tiers, from one table.
  const effectiveModels: Partial<Record<Tier, string>> = {
    ...(provider?.defaultModels ?? {}),
    ...definedEntriesOf(profile?.models),
  }
  const resolved: Partial<ResolvedModels> = {}
  for (const tier of TIERS) {
    const value = withExtendedContext(effectiveModels[tier], provider?.extendedContext)
    resolved[tier] = value
    write(TIER_ENV[tier], value)
  }

  // 7. Auto-compact window, from measured data only. Skipped for first-party
  //    Anthropic (no base URL), which knows its own models' windows.
  if (effectiveBaseUrl) {
    const windowTokens = autoCompactWindow(
      resolved,
      provider?.extendedContext,
      profile?.contextWindows,
    )
    if (windowTokens) write('CLAUDE_CODE_AUTO_COMPACT_WINDOW', String(windowTokens))
  }

  // 8. Gateways with no notion of the tiers need subagents pinned explicitly,
  //    or they fall back to a model that 404s.
  if (provider?.subagentFollowsOpus) {
    write('CLAUDE_CODE_SUBAGENT_MODEL', set.get(TIER_ENV.opus) ?? '')
  }

  // 9. User escape hatch, applied last so it wins over everything above,
  //    including the guard in step 4. '' still means UNSET (README contract).
  for (const [k, v] of Object.entries(definedEntriesOf(profile?.env))) write(k, v)

  const plan: EnvPlan = {
    set: Object.fromEntries(set),
    unset: [...unset],
    warnings: [],
    resolvedModels: resolved,
  }

  // Warnings describe decisions already made above, so they are computed from
  // the finished plan rather than accumulated during it. The compat
  // consequences are the exception: they are a property of WHICH flag was set
  // and by whom, which the finished plan no longer records.
  plan.warnings = [...compatWarnings, ...inspectAmbient(plan, ambientEnv, { provider, profile })]
  return plan
}
