// The env-building algorithm. Pure: ambient env arrives as a parameter and
// nothing here reads process.env, which is what makes the two highest-cost
// failure modes in this tool assertable in a unit test.

import { TIERS, TIER_ENV } from './tiers.ts'
import { autoCompactWindow, withExtendedContext } from './context.ts'
import { inspectAmbient } from './hygiene.ts'
import type { EnvWarning } from './hygiene.ts'
import type { Profile } from '../ports/config-store.ts'
import type {
  ClaudeCodeCompatFlag,
  ProviderDescriptor,
  ResolvedModels,
  Tier,
} from '../ports/provider.ts'
import type { EnvMap } from '../ports/process.ts'

/**
 * CompatFlags -> env var. Descriptors never spell a variable name; they set a
 * boolean and this table decides what that means. Each entry below has a
 * documented symptom it addresses.
 *
 * CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is deliberately absent. It also
 * disables gateway model discovery, so it must not be reachable from a boolean
 * that reads like a harmless compatibility switch.
 *
 * TWO TYPES, doing two different jobs, which is why this reads oddly:
 *
 *   `satisfies Record<ClaudeCodeCompatFlag, ...>` makes the table EXHAUSTIVE.
 *      Adding a flag to the port without adding its variable here is now a
 *      compile error — the same class of protection `TierRecord` gives the tier
 *      table. A flag with no mapping is a silent no-op, which is exactly the
 *      failure this indirection exists to prevent.
 *
 *   The `Record<string, ...>` ANNOTATION is what the lookups below need: they
 *      index with a key that came back from `Object.entries`, so it is a plain
 *      `string`, and the `if (mapped)` guard is the real runtime contract for
 *      an unrecognized flag in a hand-edited config.
 *
 * `as const` is type-only and erases; the arrays are frozen no more and no less
 * than they were before.
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
 * The finished plan. `set` and `unset` are DISJOINT by construction — see
 * `write` below — which is why they can be two collections rather than one map
 * with a sentinel.
 */
export type EnvPlan = {
  set: Record<string, string>
  unset: string[]
  warnings: EnvWarning[]
  /**
   * Every tier this launch answered for.
   *
   * `Partial<ResolvedModels>`: exhaustiveness is a consequence of the `TIERS`
   * loop below (checked in core/tiers.ts), not something an accumulated object's
   * type can honestly claim. `undefined` means "nothing pinned, clear the variable".
   */
  resolvedModels: Partial<ResolvedModels>
}

/** Entries whose value is neither undefined nor null. '' survives — it means UNSET. */
function definedEntriesOf<T>(
  obj: Record<string, T | null | undefined> | null | undefined,
): Record<string, T> {
  const out: Record<string, T> = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v
  }
  return out
}

/**
 * The credential this profile should present, or '' to clear the variable.
 * `apiKeyFromEnv` lets a profile be fully specified with no secret in the file.
 */
export function resolveCredential(
  profile: Profile | null | undefined,
  ambientEnv: EnvMap | null | undefined,
): string {
  if (profile?.apiKeyFromEnv) return ambientEnv?.[profile.apiKeyFromEnv] ?? ''
  return profile?.apiKey ?? ''
}

export function buildEnvPlan(
  profile: Profile | null | undefined,
  provider: ProviderDescriptor | null | undefined,
  ambientEnv: EnvMap = {},
): EnvPlan {
  const set = new Map<string, string>()
  const unset = new Set<string>()

  // The ONE write primitive. There is no second mechanism, and `set` and
  // `unset` are disjoint by construction rather than by convention.
  //   '' or null/undefined  => remove the variable from the child env
  //   anything else         => set it
  // Last write wins, so a later step can resurrect what an earlier one cleared.
  const write = (key: string, value: string | null | undefined): void => {
    if (value === '' || value === null || value === undefined) {
      set.delete(key)
      unset.add(key)
    } else {
      unset.delete(key)
      set.set(key, String(value))
    }
  }

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
  //    The two sides mean different things by `false`, along the same boundary
  //    the rest of this codebase already draws between author data and user
  //    data (see the env/unsetEnv split in ports/provider.ts):
  //
  //      descriptor false/absent  "this provider does not need it" -> no write.
  //                               Descriptors describe a gateway's quirks; they
  //                               have no business clearing a variable the user
  //                               set on purpose.
  //      profile    false         "I want this OFF" -> UNSET the variable.
  //                               Skipping instead would leave a value
  //                               inherited from the shell in place, so turning
  //                               the flag off would have done nothing — the
  //                               same silent-inherit shape as the stale
  //                               base-URL bug. An explicit choice has to be
  //                               reproducible.
  //      profile    absent        provider default stands.
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
  //    Claude Code fall back to Anthropic and bill the wrong account. This is a
  //    rule about the SHAPE of a launch, not per-provider data, so it covers
  //    every present and future third-party provider automatically.
  const effectiveBaseUrl = set.get('ANTHROPIC_BASE_URL') ?? null
  if (effectiveBaseUrl && provider?.credentialEnv !== 'ANTHROPIC_API_KEY') {
    write('ANTHROPIC_API_KEY', '')
  }

  // 5. Credential, unconditionally — an empty one clears a stale variable
  //    rather than leaving whatever the shell had.
  const credentialEnv = provider?.credentialEnv ?? 'ANTHROPIC_AUTH_TOKEN'
  write(credentialEnv, resolveCredential(profile, ambientEnv))

  // 6. All four tiers, from one table.
  //    absent  => inherit the provider default
  //    ''      => explicit opt-out, unset the variable
  //    present => use it, with [1m] derived per provider support
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

  // 7. Auto-compact window, from measured data only.
  //
  //    This is IN ADDITION to the [1m] suffix, never instead of it. The suffix
  //    is what widens the window; this tells Claude Code where to start
  //    summarising inside it. Setting this alone does not widen anything.
  //
  //    Skipped entirely when the launch has no base URL — that is first-party
  //    Anthropic, which knows its own models' windows better than we do. The
  //    condition is structural (same shape as the billing guard in step 4)
  //    rather than a hardcoded provider id, so it stays right for a profile
  //    that clears the base URL by hand.
  //
  //    autoCompactWindow returns null unless EVERY configured tier has a known
  //    window, so a model absent from the catalog is never guessed at.
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
  // the finished plan rather than accumulated during it — which keeps them
  // honest when a later step overrides an earlier one.
  plan.warnings = inspectAmbient(plan, ambientEnv, { provider, profile })
  return plan
}

/** Apply a plan to an ambient env, producing the child's environment. */
export function materializeEnv(ambientEnv: EnvMap, plan: EnvPlan): EnvMap {
  const env: EnvMap = { ...ambientEnv, ...plan.set }
  for (const key of plan.unset) delete env[key]
  // Read back by the recursion guard in adapters/process/node-process.js.
  env.SWISSCODE = '1'
  return env
}
