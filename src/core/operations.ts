// Every mutation the configuration supports, as pure functions.
//
// State in, state out. No I/O, no clock, no HTTP — a caller loads, calls one of
// these, and decides what to do with the result.
//
// WHY THIS EXISTS SEPARATELY FROM THE WEB API. There used to be two editors,
// the Ink wizard and the browser, and the rules lived in whichever one you were
// looking at: the wizard minted account+setup+profile in its own `finish()`,
// while shape parsing and reference checking lived in adapters/web/api.ts.
// Two editors, two implementations of the same rules, and no way to tell they
// agreed. The wizard has since been deleted; a terminal editor is expected to
// return, and this is what makes that cheap. What lets two front ends share
// behaviour is not shared UI — it is that neither of them owns the logic.
//
// The shape follows `bindPath`/`unbindPath` in core/binding.ts, which already
// worked this way: a discriminated result carrying either the next state or the
// reason it was refused.

import { accountsUsedBy, validateAccount } from './account.ts'
import { validateProfileName } from './migrate.ts'
import { toCustomProvider, validateCustomProvider } from './provider-def.ts'
import { TIERS } from './tiers.ts'
import type {
  CustomProvider,
  Profile,
  ProviderAccount,
  Settings,
  Setup,
  State,
} from '../ports/config-store.ts'

/**
 * Why an operation was refused.
 *
 * `invalid` is a bad request; `missing` is a name that is not there. Kept as a
 * kind rather than a status code so core/ stays ignorant of HTTP — the adapter
 * maps these to 400 and 404, and a terminal caller maps them to exit codes.
 */
export type OpFailure = { ok: false; kind: 'invalid' | 'missing'; reason: string; reasons?: string[] }

/**
 * `meta` carries facts the caller should surface but that are not errors —
 * profiles left dangling by a delete, warnings about a legal-but-odd provider.
 * Reported, never silently repaired: only the user knows what should replace a
 * reference they removed.
 */
export type OpSuccess = { ok: true; state: State; meta?: Record<string, unknown> }

export type OpResult = OpSuccess | OpFailure

const invalid = (reason: string, reasons?: string[]): OpFailure =>
  reasons ? { ok: false, kind: 'invalid', reason, reasons } : { ok: false, kind: 'invalid', reason }
const missing = (reason: string): OpFailure => ({ ok: false, kind: 'missing', reason })

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

// --------------------------------------------------------------- accounts --

/**
 * A submitted provider account.
 *
 * Whitelisted rather than spread: an unknown key from a hostile or buggy client
 * must not reach config.json, where a future swisscode would read it as
 * meaningful.
 *
 * `apiKey` is accepted write-only and only when NON-EMPTY — an empty string
 * from a form the user did not touch must not erase a stored key, which is the
 * single most destructive mistake an editor could make. Clearing is an explicit
 * `null`, so "I did not touch this" and "remove my credential" stay different
 * requests.
 */
export function parseAccount(
  input: unknown,
  existing: ProviderAccount | undefined,
): ProviderAccount | string {
  if (!isObjectLike(input)) return 'account must be an object'
  const provider = str(input.provider) ?? existing?.provider
  if (!provider) return 'provider is required'

  const account: ProviderAccount = { ...(existing ?? {}), provider }
  if (typeof input.label === 'string') account.label = input.label
  if (typeof input.configDir === 'string') {
    if (input.configDir) account.configDir = input.configDir
    else delete account.configDir
  }
  if (typeof input.baseUrl === 'string') account.baseUrl = input.baseUrl
  if (typeof input.apiKey === 'string' && input.apiKey.length > 0) account.apiKey = input.apiKey
  if (input.apiKey === null) delete account.apiKey
  if (typeof input.apiKeyFromEnv === 'string') {
    if (input.apiKeyFromEnv) account.apiKeyFromEnv = input.apiKeyFromEnv
    else delete account.apiKeyFromEnv
  }
  // The two modes are MUTUALLY EXCLUSIVE, and the conflict is refused rather
  // than resolved by precedence. The rule lives in core/account.ts so the launch
  // path and the doctor reach the same verdict an editor does — they used to
  // disagree, and the doctor called a conflicting account healthy.
  const bad = validateAccount(account)
  if (bad) return bad
  return account
}

export function putAccount(state: State, name: string, input: unknown): OpResult {
  const parsed = parseAccount(input, state.providerAccounts?.[name])
  if (typeof parsed === 'string') return invalid(parsed)
  return {
    ok: true,
    state: { ...state, providerAccounts: { ...state.providerAccounts, [name]: parsed } },
  }
}

export function deleteAccount(state: State, name: string): OpResult {
  if (!state.providerAccounts?.[name]) return missing(`no account named "${name}"`)
  const accounts = { ...state.providerAccounts }
  delete accounts[name]
  return {
    ok: true,
    state: { ...state, providerAccounts: accounts },
    meta: { affectedProfiles: accountsUsedBy(state.profiles, name) },
  }
}

// ----------------------------------------------------------------- setups --

/** A submitted setup. Holds no credential. */
export function parseSetup(input: unknown, existing: Setup | undefined): Setup | string {
  if (!isObjectLike(input)) return 'setup must be an object'
  const setup: Setup = { ...(existing ?? {}) }

  if (typeof input.label === 'string') setup.label = input.label
  if (typeof input.agent === 'string') setup.agent = input.agent
  if (typeof input.skipPermissions === 'boolean') setup.skipPermissions = input.skipPermissions

  if (isObjectLike(input.models)) {
    const models: Record<string, string> = {}
    for (const tier of TIERS) {
      const v = input.models[tier]
      if (typeof v === 'string') models[tier] = v
    }
    setup.models = models
  }

  if (isObjectLike(input.compat)) {
    const compat: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(input.compat)) {
      if (typeof v === 'boolean') compat[k] = v
    }
    setup.compat = compat as NonNullable<Setup['compat']>
  }

  if (isObjectLike(input.env)) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(input.env)) {
      if (typeof v === 'string') env[k] = v
    }
    setup.env = env
  }

  // Measured windows only. A non-integer or non-positive entry is dropped
  // rather than stored: this feeds CLAUDE_CODE_AUTO_COMPACT_WINDOW, and a window
  // set too large overflows the conversation instead of compacting it.
  if (isObjectLike(input.contextWindows)) {
    const windows: Record<string, number> = {}
    for (const [model, v] of Object.entries(input.contextWindows)) {
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) windows[model] = v
    }
    setup.contextWindows = windows
  }

  return setup
}

export function putSetup(state: State, name: string, input: unknown): OpResult {
  const parsed = parseSetup(input, state.setups?.[name])
  if (typeof parsed === 'string') return invalid(parsed)
  return { ok: true, state: { ...state, setups: { ...state.setups, [name]: parsed } } }
}

export function deleteSetup(state: State, name: string): OpResult {
  if (!state.setups?.[name]) return missing(`no setup named "${name}"`)
  const affected = Object.entries(state.profiles ?? {})
    .filter(([, p]) => p.setup === name)
    .map(([n]) => n)
  const setups = { ...state.setups }
  delete setups[name]
  return { ok: true, state: { ...state, setups }, meta: { affectedProfiles: affected } }
}

// --------------------------------------------------------------- profiles --

/**
 * The pairing. References only — no credential, no agent settings.
 *
 * Shape only: whether the things it names EXIST is checked by `putProfile`,
 * which holds the state. Validating shape and validating existence are
 * different failures and deserve different messages.
 */
export function parseProfile(input: unknown, existing: Profile | undefined): Profile | string {
  if (!isObjectLike(input)) return 'profile must be an object'
  const setup = str(input.setup) ?? existing?.setup
  if (!setup) return 'setup is required'

  const accounts = Array.isArray(input.accounts)
    ? input.accounts.filter((a): a is string => typeof a === 'string' && a.length > 0)
    : (existing?.accounts ?? [])
  if (accounts.length === 0) return 'a profile needs at least one provider account'

  const profile: Profile = { ...(existing ?? {}), setup, accounts }
  if (typeof input.label === 'string') profile.label = input.label
  if (input.strategy === 'single' || input.strategy === 'round-robin' || input.strategy === 'usage') {
    profile.strategy = input.strategy
  }
  return profile
}

export function putProfile(state: State, name: string, input: unknown): OpResult {
  // Name rules apply at CREATION only, so a hand-edited config keeps working.
  if (!state.profiles?.[name]) {
    const verdict = validateProfileName(name)
    if (!verdict.ok) return invalid(verdict.reason)
  }

  const parsed = parseProfile(input, state.profiles?.[name])
  if (typeof parsed === 'string') return invalid(parsed)

  if (!state.setups?.[parsed.setup]) return invalid(`no setup named "${parsed.setup}"`)
  const absent = parsed.accounts.filter((a) => !state.providerAccounts?.[a])
  if (absent.length > 0) return invalid(`no provider account named "${absent[0]}"`)

  const next: State = { ...state, profiles: { ...state.profiles, [name]: parsed } }
  // The first profile created becomes the default: a lone profile that is not
  // the default is a state a launch would then refuse to start from.
  if (!next.defaultProfile) next.defaultProfile = name
  return { ok: true, state: next }
}

export function deleteProfile(state: State, name: string): OpResult {
  if (!state.profiles?.[name]) return missing(`no profile named "${name}"`)
  const profiles = { ...state.profiles }
  delete profiles[name]

  // Bindings to a deleted profile are pruned, exactly as `config rm` does.
  // Leaving them would make a directory silently fall back to the default.
  //
  // KNOWN INCOMPLETE, and preserved verbatim rather than fixed here: a
  // BindingValue is `string | {profile, overrides}`, and this compares the whole
  // value, so only the string form is pruned. An object-form binding survives
  // and resolves to a profile that no longer exists. Filed separately — an
  // extraction that quietly changed behaviour would be impossible to review.
  const bindings = Object.fromEntries(
    Object.entries(state.bindings ?? {}).filter(([, p]) => p !== name),
  )
  const next: State = { ...state, profiles, bindings }
  // `string | null`, not optional — null is the "no default" state the launcher
  // already knows how to report, so clear rather than delete.
  if (next.defaultProfile === name) next.defaultProfile = null
  return { ok: true, state: next }
}

export function setDefaultProfile(state: State, name: string): OpResult {
  if (!state.profiles?.[name]) return missing(`no profile named "${name}"`)
  return { ok: true, state: { ...state, defaultProfile: name } }
}

// -------------------------------------------------------------- providers --

/**
 * `reservedIds`, `knownCompatFlags` and `credentialEnvs` are PARAMETERS because
 * they are agent-specific: the compat flags and credential variable names are
 * Claude Code's, and core/ may not name them. The caller supplies them from the
 * adapter that owns them.
 */
export type ProviderRules = {
  reservedIds: readonly string[]
  knownCompatFlags: readonly string[]
  credentialEnvs: readonly string[]
}

export function putProvider(
  state: State,
  id: string,
  input: unknown,
  rules: ProviderRules,
): OpResult {
  const candidate = isObjectLike(input) ? { ...input, id } : input
  const verdict = validateCustomProvider(candidate, {
    reservedIds: rules.reservedIds,
    knownCompatFlags: rules.knownCompatFlags,
    credentialEnvs: rules.credentialEnvs,
  })
  if (!verdict.ok) return invalid(verdict.errors[0] ?? 'invalid provider', verdict.errors)

  const providers: Record<string, CustomProvider> = { ...(state.providers ?? {}) }
  providers[id] = toCustomProvider(candidate as Record<string, unknown>)
  // Warnings ride along on success: they describe a config that is legal and
  // probably wrong, which is the user's call to make.
  return { ok: true, state: { ...state, providers }, meta: { warnings: verdict.warnings } }
}

export function deleteProvider(state: State, id: string): OpResult {
  if (!state.providers?.[id]) return missing(`no custom provider named "${id}"`)

  // Accounts point at providers, so deleting one orphans accounts, and those in
  // turn orphan whichever profiles use them. Both are reported, never silently
  // repaired: only the user knows where a profile should point next.
  const orphanedAccounts = Object.entries(state.providerAccounts ?? {})
    .filter(([, a]) => a.provider === id)
    .map(([name]) => name)
  const orphanedProfiles = Object.entries(state.profiles ?? {})
    .filter(([, p]) => (p.accounts ?? []).some((a) => orphanedAccounts.includes(a)))
    .map(([name]) => name)

  const providers = { ...state.providers }
  delete providers[id]
  return {
    ok: true,
    state: { ...state, providers },
    meta: { orphanedAccounts, orphanedProfiles },
  }
}

// --------------------------------------------------------------- settings --

export function putSettings(state: State, input: unknown): OpResult {
  if (!isObjectLike(input)) return invalid('settings must be an object')
  const settings: Settings = { ...state.settings }
  if (typeof input.quiet === 'boolean') settings.quiet = input.quiet
  if (Number.isInteger(input.bindingWalkDepth)) {
    settings.bindingWalkDepth = input.bindingWalkDepth as number
  }
  return { ok: true, state: { ...state, settings } }
}
