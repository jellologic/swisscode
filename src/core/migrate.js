// The config schema ladder. Pure (object in, object out) so the whole matrix
// in the migration tests runs with no temp directories and no fixtures.
//
// v1 is today's shipped shape: a single flat config object with a top-level
// `provider` string and no `version` key. v2 is named profiles. The two are
// unambiguously distinguishable without a version field, which is why v1 keeps
// that name rather than being retroactively called v0.

import { pickTiers } from './tiers.js'
import { isAbsolutePath, normalizeBindingKey } from './binding.js'

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

export function emptyState() {
  return {
    version: SUPPORTED_VERSION,
    profiles: {},
    defaultProfile: null,
    bindings: {},
    settings: {},
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * v1 is detected by ABSENCE of `version` plus PRESENCE of a top-level
 * `provider` string. Migration output always has version 2 and no top-level
 * `provider`, so migrate(migrate(x)) === migrate(x) holds structurally rather
 * than by a flag someone has to remember to set.
 */
export function isV1(raw) {
  return isPlainObject(raw) && raw.version === undefined && typeof raw.provider === 'string'
}

export function detectVersion(raw) {
  if (!isPlainObject(raw)) return null
  if (isV1(raw)) return 1
  if (Number.isInteger(raw.version)) return raw.version
  return null
}

/** v1 -> v2. Lossless, deterministic, and it repairs nothing. */
export function fromV1(raw) {
  const profile = {}
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

/**
 * Fill defaults, drop junk, resolve the default profile. Idempotent.
 * @returns {{state:object, warnings:string[]}}
 */
export function normalize(raw) {
  const warnings = []
  const state = isPlainObject(raw) ? { ...raw } : emptyState()

  state.version = Number.isInteger(state.version) ? state.version : SUPPORTED_VERSION

  if (!isPlainObject(state.profiles)) {
    if (state.profiles !== undefined) {
      warnings.push('config.json: `profiles` is not an object; ignoring it.')
    }
    state.profiles = {}
  } else {
    const profiles = {}
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
    const bindings = {}
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

  const names = Object.keys(state.profiles)
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
  return { state, warnings }
}

/**
 * Run the ladder.
 *
 * `migratedFrom` is the only thing that authorizes a write on load. Filling in
 * a missing `settings` key is not a migration and must not cause a launch that
 * merely read the file to touch the disk.
 *
 * @returns {{state:object, migratedFrom:number|null, corrupt:boolean,
 *            readOnly:boolean, warnings:string[]}}
 */
export function migrate(raw) {
  const absent = () => ({
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
    const { state, warnings } = normalize(fromV1(raw))
    return { state, migratedFrom: 1, corrupt: false, readOnly: false, warnings }
  }

  // W3: unknown top-level keys survive because `normalize` copies the object
  // rather than rebuilding it, so an older binary round-trips a newer file's
  // cosmetic additions instead of eating them.
  const { state, warnings } = normalize(raw)
  return { state, migratedFrom: null, corrupt: false, readOnly: false, warnings }
}

/** Validation for `config <name>` creation. Never applied at parse time. */
export function validateProfileName(name, { force = false } = {}) {
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
