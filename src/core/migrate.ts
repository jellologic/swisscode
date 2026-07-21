// The config schema ladder. Pure (object in, object out) so the whole matrix
// in the migration tests runs with no temp directories and no fixtures.
//
// v1 is today's shipped shape: a single flat config object with a top-level
// `provider` string and no `version` key. v2 is named profiles. The two are
// unambiguously distinguishable without a version field, which is why v1 keeps
// that name rather than being retroactively called v0.

import { pickTiers } from './tiers.ts'
import { isAbsolutePath, normalizeBindingKey } from './binding.ts'
import type { BindingValue, ConfigV1, MigrateResult, Settings, State } from '../ports/config-store.ts'

export const SUPPORTED_VERSION = 2

/** Enforced at creation, never at parse — a hand-edited file is still read. */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Rejected at profile-creation time only. Keeping the PARSER's reserved set at
 * four tokens while reserving the whole plausible future subcommand surface is
 * the entire trick: none of these ever becomes a reserved word.
 */
export const SOFT_RESERVED = Object.freeze([
  'config', 'setup', 'help', 'version', 'bind', 'unbind', 'bindings',
  'profile', 'profiles', 'list', 'ls', 'add', 'new', 'rm', 'remove', 'delete',
  'edit', 'rename', 'default', 'use', 'which', 'doctor', 'migrate', 'env',
  'export', 'import', 'update', 'upgrade', 'login', 'logout',
])

/**
 * `cuckoocode fix the login bug` silently eating a profile named `fix` is the
 * worst thing this feature can do, so these need --force at creation time.
 */
export const COMMON_WORD_GUARD = Object.freeze([
  'fix', 'explain', 'write', 'test', 'run', 'build', 'add', 'make', 'check',
  'review',
])

const V1_KEYS = Object.freeze([
  'provider', 'baseUrl', 'apiKey', 'models', 'skipPermissions', 'env',
])

/**
 * The v2 SHAPE, before validation.
 *
 * This is what `fromV1` hands to `normalize`, and its profiles are
 * `Record<string, unknown>` rather than `Profile` ON PURPOSE: rule M1 copies
 * every unrecognized v1 key onto the migrated profile verbatim, so a migrated
 * profile is a `Profile` plus arbitrary extras that nothing has checked. Saying
 * so here keeps the one unchecked step visible instead of laundering it through
 * an intermediate that claims to be a `State`.
 */
type V2Draft = {
  version: number
  profiles: Record<string, Record<string, unknown>>
  defaultProfile: string | null
  bindings: Record<string, BindingValue>
  settings: Settings
}

export function emptyState(): State {
  return {
    version: SUPPORTED_VERSION,
    profiles: {},
    defaultProfile: null,
    bindings: {},
    settings: {},
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * `Number.isInteger` does not coerce, so this is the same runtime test with the
 * narrowing the callers need. See the identical note in binding.ts.
 */
function isInteger(v: unknown): v is number {
  return Number.isInteger(v)
}

/**
 * v1 is detected by ABSENCE of `version` plus PRESENCE of a top-level
 * `provider` string. Migration output always has version 2 and no top-level
 * `provider`, so migrate(migrate(x)) === migrate(x) holds structurally rather
 * than by a flag someone has to remember to set.
 *
 * THE PREDICATE IS BROADER THAN THE CHECK. `raw is ConfigV1` claims `models` is
 * a `Partial<Record<Tier, string>>` and `env` a `Record<string, string>`; all
 * that is actually verified is `provider`. That is deliberate and matches what
 * the code has always done — a v1 file is read, not validated — but it means
 * this line is the trust boundary for everything downstream of it, so it is
 * written down here rather than being implied.
 */
export function isV1(raw: unknown): raw is ConfigV1 {
  return isPlainObject(raw) && raw.version === undefined && typeof raw.provider === 'string'
}

export function detectVersion(raw: unknown): number | null {
  if (!isPlainObject(raw)) return null
  if (isV1(raw)) return 1
  if (isInteger(raw.version)) return raw.version
  return null
}

/** v1 -> v2. Lossless, deterministic, and it repairs nothing. */
export function fromV1(raw: ConfigV1): V2Draft {
  const profile: Record<string, unknown> = {}
  // M1: unrecognized v1 keys ride along on the profile verbatim.
  for (const [k, v] of Object.entries(raw)) {
    if (!V1_KEYS.includes(k)) profile[k] = v
  }
  profile.provider = raw.provider
  if (raw.baseUrl !== undefined) profile.baseUrl = raw.baseUrl
  if (raw.apiKey !== undefined) profile.apiKey = raw.apiKey
  // M5: copied as-is. No fable backfill, no [1m], no glm-5.2 rewrite. The
  // suffix reaches existing users at env-build time instead; `config doctor`
  // owns anything that genuinely needs the stored data changed.
  if (raw.models !== undefined) profile.models = pickTiers(raw.models)
  if (raw.skipPermissions !== undefined) profile.skipPermissions = raw.skipPermissions
  if (raw.env !== undefined) profile.env = raw.env

  const name = NAME_RE.test(raw.provider) ? raw.provider : 'default'
  return {
    version: SUPPORTED_VERSION,
    profiles: { [name]: profile },
    defaultProfile: name,
    bindings: {},
    settings: {},
  }
}

/** Fill defaults, drop junk, resolve the default profile. Idempotent. */
export function normalize(raw: unknown): { state: State; warnings: string[] } {
  const warnings: string[] = []
  // Typed as an untrusted bag on the way in, and DELIBERATELY not as a `State`:
  // rule W3 keeps whatever unknown top-level keys the file had, so this object
  // is "the five fields State needs, plus anything else that was in the JSON".
  const state: Record<string, unknown> = isPlainObject(raw) ? { ...raw } : emptyState()

  state.version = isInteger(state.version) ? state.version : SUPPORTED_VERSION

  if (!isPlainObject(state.profiles)) {
    if (state.profiles !== undefined) {
      warnings.push('config.json: `profiles` is not an object; ignoring it.')
    }
    state.profiles = {}
  } else {
    const profiles: Record<string, Record<string, unknown>> = {}
    for (const [name, p] of Object.entries(state.profiles)) {
      if (!isPlainObject(p)) {
        warnings.push(`config.json: profile "${name}" is not an object; ignoring it.`)
        continue
      }
      profiles[name] = p
    }
    state.profiles = profiles
  }

  if (!isPlainObject(state.bindings)) {
    state.bindings = {}
  } else {
    const bindings: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(state.bindings)) {
      if (!isAbsolutePath(key)) {
        warnings.push(`config.json: binding key "${key}" is not an absolute path; ignoring it.`)
        continue
      }
      bindings[normalizeBindingKey(key) ?? key] = value
    }
    state.bindings = bindings
  }

  if (!isPlainObject(state.settings)) state.settings = {}

  // `state.profiles` was assigned an object on BOTH branches above, so this
  // guard is provably redundant — but the compiler cannot carry a narrowing
  // through a write to an index-signature property, and a redundant `typeof` on
  // config load is a better answer than an assertion that switches the check
  // off. Same reasoning as the lookup guard in binding.ts `pruneBindings`.
  const names = Object.keys(isPlainObject(state.profiles) ? state.profiles : {})
  if (typeof state.defaultProfile === 'string' && names.includes(state.defaultProfile)) {
    // keep it
  } else if (names.length === 1) {
    // A dangling default with exactly one profile has an unambiguous answer.
    state.defaultProfile = names[0]
  } else {
    // Never guess alphabetically — that silently picks an account to bill.
    if (typeof state.defaultProfile === 'string' && names.length > 1) {
      warnings.push(
        `config.json: defaultProfile "${state.defaultProfile}" does not exist.`,
      )
    }
    state.defaultProfile = null
  }

  delete state.provider
  // ===================== THE ONE TRUST BOUNDARY =========================
  // This is where unvalidated JSON is declared to be a `State`, and it is the
  // only assertion in core/. It is placed here, at a single line with a name,
  // because the trust was ALREADY being granted — silently — by every caller
  // of this function; the assertion does not add unsoundness, it localizes it.
  //
  // What is genuinely verified above: `version` is an integer, `profiles` is an
  // object whose every entry is an object, `bindings` is an object keyed by
  // absolute paths, `settings` is an object, and `defaultProfile` is either a
  // string naming a real profile or null.
  //
  // What is NOT verified, and is the reason this cannot be a type predicate:
  // the INSIDE of a profile. `Profile.provider` may be absent or a number,
  // `apiKey` may be an object, `models.opus` may be a boolean — nothing here
  // looks. Reported as a finding rather than fixed; adding validation would be
  // a behaviour change, and this slice is types only.
  return { state: state as unknown as State, warnings }
}

/**
 * Run the ladder.
 *
 * `migratedFrom` is the only thing that authorizes a write on load. Filling in
 * a missing `settings` key is not a migration and must not cause a launch that
 * merely read the file to touch the disk.
 */
export function migrate(raw: unknown): MigrateResult {
  const absent = (): MigrateResult => ({
    ...normalize(emptyState()),
    migratedFrom: null,
    corrupt: true,
    readOnly: false,
  })

  if (!isPlainObject(raw)) return absent()

  const version = detectVersion(raw)

  // R5: no version and no top-level provider — we do not know what this is.
  if (version === null) return absent()

  // R4: a NEWER schema. Best-effort read, and every write path is disabled for
  // the whole process. An older binary must never clobber a newer file.
  if (version > SUPPORTED_VERSION) {
    const salvage = {
      version,
      profiles: isPlainObject(raw.profiles) ? raw.profiles : {},
      defaultProfile: typeof raw.defaultProfile === 'string' ? raw.defaultProfile : null,
      bindings: isPlainObject(raw.bindings) ? raw.bindings : {},
      settings: isPlainObject(raw.settings) ? raw.settings : {},
    }
    const { state, warnings } = normalize(salvage)
    state.version = version
    return { state, migratedFrom: null, corrupt: false, readOnly: true, warnings }
  }

  if (version === 1) {
    // ======================= KNOWN BUG, NOT FIXED HERE ======================
    // `version === 1` IS NOT `isV1(raw)`, and the compiler is the thing that
    // just said so: `raw` is only a `Record<string, unknown>` here.
    //
    // `detectVersion` returns 1 down TWO paths — the implicit v1 shape (no
    // `version` key, top-level `provider` string), and any file that literally
    // says `"version": 1`. Only the first is a `ConfigV1`. A file carrying an
    // explicit `"version": 1` with no top-level `provider` reaches `fromV1`,
    // where `raw.provider` is undefined, `NAME_RE.test(undefined)` coerces to
    // the string "undefined" and MATCHES, and rule M1 then nests the entire
    // file inside a single profile named "undefined".
    //
    // Left exactly as it is per the terms of this migration: types only, no
    // behaviour changes, report don't fix. The assertion below is the marker,
    // not a repair — see the migration report.
    const { state, warnings } = normalize(fromV1(raw as unknown as ConfigV1))
    return { state, migratedFrom: 1, corrupt: false, readOnly: false, warnings }
  }

  // W3: unknown top-level keys survive because `normalize` copies the object
  // rather than rebuilding it, so an older binary round-trips a newer file's
  // cosmetic additions instead of eating them.
  const { state, warnings } = normalize(raw)
  return { state, migratedFrom: null, corrupt: false, readOnly: false, warnings }
}

/** Validation for `config <name>` creation. Never applied at parse time. */
export function validateProfileName(
  name: unknown,
  { force = false }: { force?: boolean } = {},
): { ok: true; reason: null } | { ok: false; reason: string } {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    return {
      ok: false,
      reason:
        'profile names must start with a letter or digit and contain only ' +
        'letters, digits, dot, underscore or dash (max 64 chars).',
    }
  }
  if (SOFT_RESERVED.includes(name)) {
    return { ok: false, reason: `"${name}" is reserved for cuckoocode subcommands.` }
  }
  if (!force && COMMON_WORD_GUARD.includes(name)) {
    return {
      ok: false,
      reason:
        `"${name}" is a word you are likely to type as a prompt — ` +
        `\`cuckoocode ${name} ...\` would select the profile instead. ` +
        'Re-run with --force if you really want it.',
    }
  }
  return { ok: true, reason: null }
}
