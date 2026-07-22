// The Claude Code env-building algorithm. Pure: ambient env arrives as a
// parameter and nothing here reads process.env, which is what makes the two
// highest-cost failure modes in this tool assertable in a unit test.
//
// This is the heart of the Claude Code adapter — every ANTHROPIC_*/CLAUDE_CODE_*
// variable this tool emits is chosen here. The generic accumulator it is built
// on (makeEnvWriter, materializeEnv) is neutral and lives in core/env-plan.ts.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { TIERS } from '../../../core/tiers.ts'
import { definedEntriesOf, makeEnvWriter, resolveCredential } from '../../../core/env-plan.ts'
import { TIER_ENV } from './tiers.ts'
import { autoCompactWindow, withExtendedContext } from './context.ts'
import { inspectAmbient } from './hygiene.ts'
import type { ResolvedProfile } from '../../../ports/config-store.ts'
import type { ClaudeCodeCompatEnv, ClaudeCodeCompatFlag } from '../../../ports/claude-code.ts'
import type { ProviderDescriptor, ResolvedModels, Tier } from '../../../ports/provider.ts'
import type { EnvMap } from '../../../ports/process.ts'
import type { EnvWarning } from '../../../ports/agent.ts'

/**
 * Does this session directory mean "the default login"?
 *
 * Lives here, in the env lowering, because it is an ENV-LOWERING QUESTION: the
 * answer decides whether CLAUDE_CONFIG_DIR is written or cleared. It earns no
 * module of its own — the launch path is held under 40 modules so it stays
 * auditable in a sitting, and that budget is a real constraint rather than a
 * decoration.
 *
 * MEASURED, and the measurement is the whole reason it exists. Claude Code
 * chooses which Keychain item holds the credential from WHETHER
 * `CLAUDE_CONFIG_DIR` IS SET, hashing the path into the service name whenever
 * it is — so the default directory has two distinct credentials depending on
 * how you arrive at it. Verified on a real machine:
 *
 *     claude config ls                                  ->  logged in
 *     CLAUDE_CONFIG_DIR=$HOME/.claude claude config ls   ->  "Not logged in"
 *
 * Same directory, same `.claude.json`, different login. Identity is shared —
 * that file really is the same one — so a session lowered the wrong way reports
 * the correct email while being unable to authenticate, which is about the most
 * confusing failure on offer.
 */
export function isDefaultConfigDir(
  dir: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  // `resolve` so a trailing slash, a doubled separator, or a relative spelling
  // of the same directory all answer alike. A near-miss does not fail loudly;
  // it silently takes the hashed-credential branch.
  return resolve(dir) === resolve(join(env.HOME || homedir(), '.claude'))
}

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
 * The variable spellings that may carry the credential, as RUNTIME data.
 *
 * ports/claude-code.ts has the type (`ClaudeCodeCredentialEnv`), but a type
 * erases — and validating a provider typed in by a user needs a list at
 * runtime. It lives here because this adapter is the designated home for the
 * dialect: core/ is forbidden from naming these, which is what keeps a
 * user-defined provider validated by injection rather than by core learning
 * Anthropic's vocabulary.
 */
export const CREDENTIAL_ENVS: readonly string[] = Object.freeze([
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
])

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
  profile: ResolvedProfile | null | undefined,
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

  // 4b. SESSION MODE. The account points at a directory holding a login Claude
  //     Code already performed, so the credential is not ours to supply — we
  //     just tell it where to look.
  //
  //     BOTH credential variables are cleared, and that is the whole point.
  //     ANTHROPIC_API_KEY overrides an OAuth login outright, and a stale
  //     ANTHROPIC_AUTH_TOKEN left in a shell would be presented instead of the
  //     subscription this account names. Verified before this was written: the
  //     anthropic-direct path cleared only the first, so a stale auth token
  //     survived into the child — a silent wrong-account launch, which is the
  //     exact failure the golden maps exist to catch.
  //
  //     SETTING THE VARIABLE TO THE DEFAULT PATH IS NOT THE SAME AS LEAVING IT
  //     UNSET, and this is not a subtlety we may round off. Claude Code decides
  //     which Keychain item holds the credential from whether CLAUDE_CONFIG_DIR
  //     IS SET — not from what it contains — hashing the path into the service
  //     name whenever it is. So the default directory has two different
  //     credentials depending on how you arrive at it. Verified on this machine:
  //
  //       claude config ls                          -> logged in
  //       CLAUDE_CONFIG_DIR=$HOME/.claude ... ls    -> "Not logged in"
  //
  //     Same directory, same `.claude.json`, different login. An account that
  //     names the default directory therefore lowers to UNSETTING the variable,
  //     which is also what makes adopting an existing `~/.claude` work with no
  //     re-login. Writing the path instead would hand the user a session that
  //     reports the right email — identity comes from `.claude.json`, which IS
  //     shared — while being logged out.
  const sessionDir = profile?.configDir
  if (sessionDir) {
    write('CLAUDE_CONFIG_DIR', isDefaultConfigDir(sessionDir, ambientEnv) ? '' : sessionDir)
    write('ANTHROPIC_API_KEY', '')
    write('ANTHROPIC_AUTH_TOKEN', '')
  }

  // 5. Credential, unconditionally — an empty one clears a stale variable.
  //    `defaultCredential` covers the keyless endpoint: a local Ollama ignores
  //    the token entirely (verified: no header, a wrong key and a bearer token
  //    all behave identically), but Claude Code still wants the variable to
  //    carry something, so the descriptor supplies the placeholder rather than
  //    every user being told to invent one.
  //    Skipped entirely in session mode: step 4b already cleared both
  //    variables, and writing one back — even an empty one — would re-open the
  //    question of which credential a subscription launch presented.
  if (!sessionDir) {
    const credentialEnv = provider?.credentialEnv ?? 'ANTHROPIC_AUTH_TOKEN'
    write(credentialEnv, resolveCredential(profile, ambientEnv) || (provider?.defaultCredential ?? ''))
  }

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
