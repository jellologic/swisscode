// `swisscode config doctor` — the diagnosis, with no I/O in it.
//
// Everything here is (facts in) -> (checks out). The adapter resolves the
// binary, stats the config file, and makes the network calls; this module
// decides what any of that MEANS, which is the part worth testing.
//
// THREE RULES THIS MODULE ENFORCES:
//
//   1. The API key is never printed, not even partially. Not a prefix, not a
//      suffix, not a length. `redact` runs over every string that leaves here,
//      including bodies echoed back by a gateway, because a masked key is still
//      a key someone can shoulder-surf and a length is still a fingerprint.
//   2. Exit code is derived, never hand-set: any error -> 2, any warning -> 1,
//      otherwise 0. CI consumes that, so it has to come from the same data the
//      human output does.
//   3. Doctor proposes; it does not repair. The one exception is the explicit
//      `--fix`, and even then only for the repairs listed as `fix`-able below.

import { TIERS, TIER_ENV } from './tiers.ts'
import { SUFFIX, bareModelId } from './context.ts'
import { staleStoredModels } from './hygiene.ts'
import { SOFT_RESERVED } from './migrate.ts'
import type { EnvPlan } from './env.ts'
import type { ProfileSelection } from './profile.ts'
import type { ConfigModes, LoadResult, Profile } from '../ports/config-store.ts'
import type {
  ClaudeCodeCredentialEnv,
  ProviderDescriptor,
  ResolvedModels,
  Tier,
} from '../ports/provider.ts'
import type {
  DoctorCheck,
  DoctorCounts,
  DoctorStatus,
  DoctorSummary,
  ProbeResult,
} from '../ports/doctor.ts'

export const OK = 'ok'
export const WARN = 'warn'
export const ERROR = 'error'
export const SKIP = 'skip'

/** Total wall-clock budget for every network probe combined. */
export const DEFAULT_TOTAL_TIMEOUT_MS = 20_000
/** Per-request ceiling, further clamped by whatever is left of the total. */
export const DEFAULT_PROBE_TIMEOUT_MS = 8_000

const REDACTED = '<redacted>'

export function makeCheck(
  id: string,
  title: string,
  status: DoctorStatus,
  detail: string,
  extra: Partial<DoctorCheck> = {},
): DoctorCheck {
  return { id, title, status, detail, ...extra }
}

/**
 * Remove every secret from a string.
 *
 * Deliberately not a mask: `sk-…abcd` still leaks the tail, and `••••` still
 * leaks the length. Both are more than a diagnostic needs.
 *
 * `secrets` is `readonly unknown[]` rather than `string[]` because the
 * `typeof secret !== 'string'` guard below is part of the contract, not a
 * leftover: this runs over whatever the caller scraped together, and a
 * non-string in that list has to be skipped rather than crash the report that
 * is trying to explain what went wrong.
 */
export function redact(text: string, secrets: readonly unknown[] = []): string {
  if (typeof text !== 'string' || text.length === 0) return text
  let out = text
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 4) continue
    out = out.split(secret).join(REDACTED)
  }
  return out
}

/** Deep-redact anything that is about to be printed or serialized as JSON. */
export function redactDeep(value: unknown, secrets: readonly unknown[] = []): unknown {
  if (typeof value === 'string') return redact(value, secrets)
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]): [string, unknown] => [k, redactDeep(v, secrets)]),
    )
  }
  return value
}

/**
 * 0 clean / 1 warnings / 2 errors, so CI can branch on it. Derived from the
 * checks rather than tracked alongside them — the number and the report can
 * never disagree.
 *
 * Takes `{ status }` because that is all it reads; `DoctorCheck[]` is
 * assignable, and the tests exercise it with bare status objects.
 *
 * `DoctorCounts` is `Record<DoctorStatus, number>`, so the tally below is
 * EXHAUSTIVE over the four statuses by the same mechanism that makes the tier
 * table exhaustive. Adding a fifth status without counting it here would not
 * compile — and an uncounted status is one that silently cannot affect the exit
 * code, which is the whole contract of this function.
 */
export function summarize(checks: readonly { status: DoctorStatus }[]): DoctorSummary {
  const counts: DoctorCounts = { ok: 0, warn: 0, error: 0, skip: 0 }
  for (const c of checks) counts[c.status] = (counts[c.status] ?? 0) + 1
  return { counts, exitCode: counts.error > 0 ? 2 : counts.warn > 0 ? 1 : 0 }
}

/** Everything the adapter has to hand `staticChecks`. */
export type StaticChecksInput = {
  /** store.load() result */
  loaded: LoadResult
  /** resolveProfile() result */
  selection: ProfileSelection
  /** after overrides */
  profile: Profile | null
  /** descriptor, or null when unknown */
  provider: ProviderDescriptor | null
  /** buildEnvPlan() result */
  plan: EnvPlan | null
  modes?: ConfigModes
  /**
   * `error` admits undefined because the adapter stores a raw `err.message`,
   * which is undefined for a throw that carries none. Read as
   * `binary.error ?? 'not found'`, so undefined and null are indistinguishable.
   */
  binary?: { path: string | null; error: string | null | undefined }
  /** supplied by the adapter; [] if unchecked */
  deadBindingPaths?: string[]
  /**
   * Accepted and never read here — same situation as `probeSpec`'s `profile`.
   * composition/doctor-root.ts passes `cwd`; resolveProfile uses the cwd it
   * computes, not this field. Kept so the caller signature stays stable.
   */
  cwd?: string | null
}

/** Everything decidable without touching the network. */
export function staticChecks(input: StaticChecksInput): DoctorCheck[] {
  const {
    loaded,
    selection,
    profile,
    provider,
    plan,
    modes = { dir: null, file: null },
    binary = { path: null, error: null },
    deadBindingPaths = [],
  } = input
  const state = loaded?.state ?? {}
  const checks: DoctorCheck[] = []

  // the binary we are going to exec
  checks.push(
    binary.path
      ? makeCheck('binary', 'claude binary', OK, binary.path)
      : makeCheck('binary', 'claude binary', ERROR, binary.error ?? 'not found', {
          fix: 'Install Claude Code, or point SWISSCODE_CLAUDE_BIN at the real binary.',
        }),
  )

  // config file state
  if (loaded?.corrupt) {
    checks.push(
      makeCheck('config-parse', 'config.json', ERROR, 'exists but could not be parsed', {
        fix: 'It will be moved aside as config.corrupt-<epoch>.json on the next write.',
      }),
    )
  } else if (loaded?.readOnly) {
    checks.push(
      makeCheck(
        'config-version',
        'config.json',
        ERROR,
        `written by a newer swisscode (version ${state.version}); writes are refused`,
        { fix: 'Upgrade swisscode.' },
      ),
    )
  } else {
    checks.push(makeCheck('config-parse', 'config.json', OK, `version ${state.version ?? '?'}`))
  }

  // permissions. The file holds an API key.
  checks.push(modeCheck('perms-dir', 'config dir mode', modes.dir, 0o700))
  checks.push(modeCheck('perms-file', 'config file mode', modes.file, 0o600))

  // which profile is active, and why
  if (selection?.error) {
    checks.push(makeCheck('profile', 'active profile', ERROR, selection.error))
  } else if (!profile) {
    checks.push(
      selection?.ambiguous
        ? makeCheck(
            'profile',
            'active profile',
            ERROR,
            `several profiles exist (${Object.keys(state.profiles ?? {}).join(', ')}) and none is ` +
              'the default',
            { fix: 'Run `swisscode config default <name>`.' },
          )
        : makeCheck('profile', 'active profile', ERROR, 'no profile configured', {
            fix: 'Run `swisscode config`.',
          }),
    )
  } else {
    const where =
      selection.source === 'binding'
        ? ` (directory binding: ${selection.bindingKey})`
        : selection.source === 'positional'
          ? ' (named on the command line)'
          : selection.source === 'flag'
            ? ' (--cc-profile)'
            : ' (default profile)'
    checks.push(makeCheck('profile', 'active profile', OK, `"${selection.name}"${where}`))
  }

  if (!profile) return checks

  // provider
  if (!provider) {
    checks.push(
      profile.baseUrl
        ? makeCheck(
            'provider',
            'provider',
            WARN,
            `"${profile.provider}" is not a known provider; falling back to the profile's own ` +
              `baseUrl (${profile.baseUrl})`,
          )
        : makeCheck(
            'provider',
            'provider',
            ERROR,
            `"${profile.provider}" is not a known provider and the profile has no baseUrl`,
            { fix: 'Run `swisscode config <name>` and pick a provider.' },
          ),
    )
  } else {
    checks.push(makeCheck('provider', 'provider', OK, `${provider.label} (${provider.id})`))
  }

  // endpoint
  const baseUrl = plan?.set?.ANTHROPIC_BASE_URL ?? null
  checks.push(
    baseUrl
      ? makeCheck('endpoint', 'endpoint', OK, baseUrl)
      : makeCheck('endpoint', 'endpoint', OK, 'api.anthropic.com (first-party default)'),
  )

  // credential
  const credentialEnv = provider?.credentialEnv ?? 'ANTHROPIC_AUTH_TOKEN'
  const credential = plan?.set?.[credentialEnv] ?? null
  if (credential) {
    // Says WHERE it came from and never WHAT it is.
    const origin = profile.apiKeyFromEnv ? `$${profile.apiKeyFromEnv}` : 'config.json'
    checks.push(makeCheck('credential', 'credential', OK, `${credentialEnv} set from ${origin}`))
  } else if (provider?.credentialOptional) {
    checks.push(
      makeCheck('credential', 'credential', OK, `no ${credentialEnv}; this provider allows that`),
    )
  } else if (profile.apiKeyFromEnv) {
    checks.push(
      makeCheck(
        'credential',
        'credential',
        ERROR,
        `profile reads its key from $${profile.apiKeyFromEnv}, which is not set in this shell`,
        { fix: `export ${profile.apiKeyFromEnv}=… before launching.` },
      ),
    )
  } else {
    checks.push(
      makeCheck('credential', 'credential', ERROR, `no ${credentialEnv} for this profile`, {
        fix: `Run \`swisscode config ${selection.name}\` and paste the key.`,
      }),
    )
  }

  // models
  const resolved: Partial<ResolvedModels> = plan?.resolvedModels ?? {}
  const missing = TIERS.filter((t) => !resolved[t])
  if (missing.length === 0) {
    checks.push(
      makeCheck('models', 'model tiers', OK, TIERS.map((t) => `${t}=${resolved[t]}`).join('  ')),
    )
  } else if (missing.length === TIERS.length) {
    // Legitimate for Anthropic-direct and `custom`: Claude Code picks its own.
    checks.push(
      makeCheck('models', 'model tiers', OK, 'none pinned; Claude Code uses its own defaults'),
    )
  } else {
    checks.push(
      makeCheck(
        'models',
        'model tiers',
        WARN,
        `${missing.join(', ')} not set, so ${missing
          .map((t) => TIER_ENV[t])
          .join(', ')} is cleared and Claude Code falls back for those tiers`,
        { fix: `Run \`swisscode config ${selection.name}\` and fill every tier.` },
      ),
    )
  }

  // stored [1m] drift
  // Advice, not a correctness problem: buildEnvPlan already derives the suffix
  // at launch. This is about the file matching what actually happens.
  const stale = staleStoredModels(profile, provider)
  if (stale.length > 0) {
    const missingSuffix = stale.filter((s) => s.reason === 'missing')
    const unsupported = stale.filter((s) => s.reason === 'unsupported')
    if (missingSuffix.length > 0) {
      checks.push(
        makeCheck(
          'stored-models',
          'stored model ids',
          OK,
          `${missingSuffix.map((s) => `${s.tier}=${s.stored}`).join(', ')} stored without ${SUFFIX}; ` +
            'the launch derives it, so the stored value needs no change',
        ),
      )
    }
    if (unsupported.length > 0) {
      checks.push(
        makeCheck(
          'stored-models-unsupported',
          'stored model ids',
          WARN,
          `${unsupported.map((s) => `${s.tier}=${s.stored}`).join(', ')} carries ${SUFFIX} but ` +
            'this provider does not document the wider window for it; the launch strips it',
          {
            // Reported, never auto-repaired: this is a model string the user
            // pinned by hand, and buildEnvPlan already does the safe thing with
            // it at launch. Doctor does not rewrite deliberate choices.
            fix: `Store the bare id instead: ${unsupported.map((s) => s.suggested).join(', ')}.`,
          },
        ),
      )
    }
  }

  // inherited environment
  for (const w of plan?.warnings ?? []) {
    if (w.severity === 'info') {
      checks.push(makeCheck(`env-${w.code}`, 'environment', OK, w.message))
    } else {
      checks.push(makeCheck(`env-${w.code}`, 'environment', WARN, w.message))
    }
  }
  if ((plan?.warnings ?? []).every((w) => w.severity === 'info')) {
    checks.push(makeCheck('env-clean', 'environment', OK, 'no conflicting ANTHROPIC_*/CLAUDE_CODE_* variables'))
  }

  // bindings
  const bindings = Object.entries(state.bindings ?? {})
  const danglingProfiles = bindings.filter(([, v]) => {
    const name = typeof v === 'string' ? v : v?.profile
    return !name || !Object.prototype.hasOwnProperty.call(state.profiles ?? {}, name)
  })
  if (danglingProfiles.length > 0) {
    checks.push(
      makeCheck(
        'bindings-dangling',
        'directory bindings',
        WARN,
        `${danglingProfiles.length} binding(s) point at a profile that no longer exists: ` +
          danglingProfiles.map(([k]) => k).join(', '),
        { fix: 'Run `swisscode config bindings --prune`.', repair: { kind: 'prune' } },
      ),
    )
  }
  if (deadBindingPaths.length > 0) {
    checks.push(
      makeCheck(
        'bindings-dead-path',
        'directory bindings',
        WARN,
        `${deadBindingPaths.length} binding(s) point at a directory that no longer exists: ` +
          deadBindingPaths.join(', '),
        { fix: 'Run `swisscode config bindings --prune`.', repair: { kind: 'prune' } },
      ),
    )
  }

  // names shadowed by a reserved word
  const shadowed = Object.keys(state.profiles ?? {}).filter((n) => SOFT_RESERVED.includes(n))
  if (shadowed.length > 0) {
    checks.push(
      makeCheck(
        'shadowed-names',
        'profile names',
        WARN,
        `${shadowed.join(', ')} cannot be selected positionally — the subcommand wins`,
        { fix: 'Select it with --cc-profile, or rename it.' },
      ),
    )
  }

  return checks
}

function modeCheck(id: string, title: string, mode: number | null, want: number): DoctorCheck {
  if (mode === null) return makeCheck(id, title, SKIP, 'does not exist yet')
  const actual = `0${mode.toString(8)}`
  if (mode === want) return makeCheck(id, title, OK, actual)
  // Looser than wanted is the only direction that matters: the file holds a key.
  const tooOpen = (mode & ~want) !== 0
  return makeCheck(
    id,
    title,
    tooOpen ? ERROR : WARN,
    `${actual}, expected 0${want.toString(8)}`,
    { fix: 'swisscode re-asserts this on its next write, or `chmod` it yourself.' },
  )
}

/** One model the probe will exercise, and whether its stored id carried [1m]. */
export type ProbeModel = {
  tier: Tier
  id: string
  suffixed: boolean
}

export type ProbeSpec = {
  baseUrl: string | null
  credentialEnv: ClaudeCodeCredentialEnv
  credential: string | null
  models: ProbeModel[]
  /** the tier that does the actual work, or null when nothing is pinned */
  toolModel: string | null
}

/**
 * What to probe over the network, derived from the plan that will actually be
 * used at launch.
 *
 * The BARE model id is probed, not the [1m] one. The suffix is a Claude Code
 * client-side signal about the context window; whether it is forwarded to the
 * endpoint as part of the model string has not been verified here, so probing
 * the suffixed id could report a false 404 for a model that works fine. The
 * report says so rather than quietly testing something else than it claims.
 *
 * NOTE: `profile` is accepted and never read. Retained so the call-site
 * signature stays stable.
 */
export function probeSpec(
  profile: Profile | null | undefined,
  provider: ProviderDescriptor | null | undefined,
  plan: EnvPlan | null | undefined,
): ProbeSpec {
  const baseUrl = plan?.set?.ANTHROPIC_BASE_URL ?? null
  const credentialEnv = provider?.credentialEnv ?? 'ANTHROPIC_AUTH_TOKEN'
  const credential = plan?.set?.[credentialEnv] ?? null

  const resolved: Partial<ResolvedModels> = plan?.resolvedModels ?? {}
  const seen = new Set<string>()
  const models: ProbeModel[] = []
  for (const tier of TIERS) {
    const id = resolved[tier]
    if (!id) continue
    const bare = bareModelId(id)
    if (seen.has(bare)) continue
    seen.add(bare)
    models.push({ tier, id: bare, suffixed: id !== bare })
  }

  return {
    baseUrl,
    credentialEnv,
    credential,
    models,
    // Tool calling is probed once, on the tier that does the actual work.
    toolModel: models[0]?.id ?? null,
  }
}

/**
 * HTTP status -> a check.
 *
 * The status codes matter more than the bodies: every gateway words its errors
 * differently, but they agree on 401 and 404.
 */
export function interpretMessagesProbe({
  model,
  result,
  provider,
}: {
  model: string
  result: ProbeResult
  provider?: ProviderDescriptor | null
}): DoctorCheck {
  const id = `endpoint-${model}`
  const title = `model ${model}`

  if (result.timedOut) {
    return makeCheck(id, title, ERROR, `no response within ${result.timeoutMs}ms`, {
      fix: 'The endpoint may be unreachable, or slower than the probe budget.',
    })
  }
  if (result.networkError) {
    return makeCheck(id, title, ERROR, `could not reach the endpoint: ${result.networkError}`)
  }

  const status = result.status
  const detail = result.message ? ` — ${result.message}` : ''

  if (status === 200) {
    return makeCheck(id, title, OK, 'endpoint reachable, credential accepted, model served')
  }
  if (status === 401 || status === 403) {
    return makeCheck(id, title, ERROR, `credential rejected (HTTP ${status})${detail}`, {
      fix:
        provider?.id === 'modelscope'
          ? 'Keep the ms- prefix on the token exactly as issued — stripping it breaks auth.'
          : 'Re-enter the key with `swisscode config <name>`.',
    })
  }
  if (status === 404) {
    return makeCheck(id, title, ERROR, `not found (HTTP 404)${detail}`, {
      fix:
        'Either the model id is wrong or the base URL has an extra path segment. ' +
        'ModelScope and SiliconFlow take a BARE host — a trailing /v1 yields /v1/v1/messages.',
    })
  }
  if (status === 429) {
    return makeCheck(id, title, WARN, `rate limited (HTTP 429)${detail}`, {
      fix: 'The endpoint and credential are fine; try again shortly.',
    })
  }
  if (status === 400) {
    return makeCheck(id, title, ERROR, `rejected the request (HTTP 400)${detail}`, {
      fix:
        'A 400 here is usually a schema mismatch in the gateway. ' +
        '`"compat": {"disableExperimentalBetas": true}` clears "Extra inputs are not permitted"; ' +
        '`"disableAdaptiveThinking"` clears "Input tag \'adaptive\' found".',
    })
  }
  // `status !== null &&` is new TEXT and not new BEHAVIOUR. `status` is
  // `number | null` because a probe that never got a response reports null, and
  // `null >= 500` coerces to `0 >= 500`, which is false — exactly what the
  // explicit check yields. A null status still falls through to the line below
  // and is reported as an unexpected status, which is what it is.
  if (status !== null && status >= 500) {
    return makeCheck(id, title, WARN, `endpoint returned HTTP ${status}${detail}`, {
      fix: 'Reachable and authenticated, but the endpoint is unhealthy right now.',
    })
  }
  return makeCheck(id, title, WARN, `unexpected HTTP ${status}${detail}`)
}

/** Claude Code cannot operate without tool calling, so this one is load-bearing. */
export function interpretToolProbe({
  model,
  result,
}: {
  model: string
  result: ProbeResult
}): DoctorCheck {
  const id = 'tool-calling'
  const title = `tool calling (${model})`

  if (result.timedOut) {
    return makeCheck(id, title, WARN, `no response within ${result.timeoutMs}ms`)
  }
  if (result.networkError) {
    return makeCheck(id, title, WARN, `could not reach the endpoint: ${result.networkError}`)
  }
  if (result.status === 200 && result.usedTool) {
    return makeCheck(id, title, OK, 'the model called the tool it was given')
  }
  if (result.status === 200) {
    return makeCheck(
      id,
      title,
      WARN,
      'the request was accepted but the model did not call the tool it was forced to call',
      { fix: 'Claude Code needs tool calling. Try a short real task before relying on this model.' },
    )
  }
  return makeCheck(
    id,
    title,
    ERROR,
    `the endpoint rejected a tool-calling request (HTTP ${result.status})` +
      (result.message ? ` — ${result.message}` : ''),
    { fix: 'Claude Code cannot work against this model without tool calling.' },
  )
}

/** Remaining slice of the total budget, clamped to the per-request ceiling. */
export function remainingBudget(
  startedAt: number,
  now: number,
  totalMs: number,
  perProbeMs: number,
): number {
  const left = totalMs - (now - startedAt)
  if (left <= 0) return 0
  return Math.min(perProbeMs, left)
}

/**
 * `Record<DoctorStatus, string>`, so every status has a glyph. A status with no
 * glyph renders as the `?` fallback below, which is a worse bug than it looks:
 * the reader cannot tell a failing check from an unrecognized one.
 */
const GLYPH: Record<DoctorStatus, string> = { ok: '✓', warn: '!', error: '✗', skip: '·' }

/**
 * Only the three fields the renderer reads. `DoctorReport` is assignable, and
 * so is the smaller object the tests build — this is what the function actually
 * depends on.
 */
export type RenderableReport = {
  checks: readonly DoctorCheck[]
  summary: DoctorSummary
  notes?: readonly string[]
}

/** Human output. Every string has already been through `redact`. */
export function renderText(report: RenderableReport): string {
  const lines: string[] = []
  for (const c of report.checks) {
    lines.push(`${GLYPH[c.status] ?? '?'} ${c.title.padEnd(20)} ${c.detail}`)
    if (c.fix && c.status !== OK) lines.push(`  ↳ ${c.fix}`)
  }
  const { counts, exitCode } = report.summary
  lines.push('')
  lines.push(
    exitCode === 0
      ? `all clear — ${counts.ok} checks passed`
      : `${counts.error} error(s), ${counts.warn} warning(s), ${counts.ok} ok`,
  )
  if (report.notes?.length) {
    lines.push('')
    for (const n of report.notes) lines.push(`note: ${n}`)
  }
  return lines.join('\n')
}
