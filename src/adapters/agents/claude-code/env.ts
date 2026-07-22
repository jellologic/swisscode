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
import type { ClaudeCodeCompatFlag } from '../../../ports/claude-code.ts'
import type { ProviderDescriptor, ResolvedModels, Tier } from '../../../ports/provider.ts'
import type { EnvMap } from '../../../ports/process.ts'
import type { EnvWarning } from '../../../ports/agent.ts'

/**
 * CompatFlags -> env var. Descriptors never spell a variable name; they set a
 * boolean and this table decides what that means. Each entry below has a
 * documented symptom it addresses.
 *
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is deliberately absent. It also
 * disables gateway model discovery, so it must not be reachable from a boolean
 * that reads like a harmless compatibility switch.
 *
 * `satisfies Record<ClaudeCodeCompatFlag, ...>` makes the table EXHAUSTIVE:
 * adding a flag to the port without adding its variable here is a compile error.
 * The `Record<string, ...>` annotation is what the lookups below need, since
 * they index with a key that came back from `Object.entries` (a plain string).
 */
export const COMPAT_ENV: Record<string, readonly [string, string]> = Object.freeze({
  // "400 Extra inputs are not permitted"
  disableExperimentalBetas: ['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', '1'],
  // "400 Input tag 'adaptive' found"
  disableAdaptiveThinking: ['CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', '1'],
  // fast mode reported as "disabled by organization"
  skipFastModeOrgCheck: ['CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK', '1'],
  // MCP tool search is off by default away from first-party
  enableToolSearch: ['ENABLE_TOOL_SEARCH', '1'],
  // stalls on slow or locally hosted models
  forceIdleTimeoutOff: ['API_FORCE_IDLE_TIMEOUT', '0'],
  // improves prompt-cache hit rate through gateways
  dropAttributionHeader: ['CLAUDE_CODE_ATTRIBUTION_HEADER', '0'],
} as const) satisfies Record<ClaudeCodeCompatFlag, readonly [string, string]>

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
  const profileCompat = definedEntriesOf(profile?.compat)
  for (const [flag, on] of Object.entries(provider?.compat ?? {})) {
    if (!on || flag in profileCompat) continue
    const mapped = COMPAT_ENV[flag]
    if (mapped) write(mapped[0], mapped[1])
  }
  for (const [flag, on] of Object.entries(profileCompat)) {
    const mapped = COMPAT_ENV[flag]
    if (mapped) write(mapped[0], on ? mapped[1] : '')
  }

  // 4. Structural billing guard. A stale ANTHROPIC_API_KEY in the shell makes
  //    Claude Code fall back to Anthropic and bill the wrong account.
  const effectiveBaseUrl = set.get('ANTHROPIC_BASE_URL') ?? null
  if (effectiveBaseUrl && provider?.credentialEnv !== 'ANTHROPIC_API_KEY') {
    write('ANTHROPIC_API_KEY', '')
  }

  // 5. Credential, unconditionally — an empty one clears a stale variable.
  const credentialEnv = provider?.credentialEnv ?? 'ANTHROPIC_AUTH_TOKEN'
  write(credentialEnv, resolveCredential(profile, ambientEnv))

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
  // the finished plan rather than accumulated during it.
  plan.warnings = inspectAmbient(plan, ambientEnv, { provider, profile })
  return plan
}
