// The JSON API behind the web UI.
//
// Deliberately free of node:http: a request is a plain object in and a plain
// object out, so every branch — including every refusal — is testable without
// binding a socket. The server module is the only part that knows about sockets.
//
// It is thin by construction. Everything it does is already a port operation,
// which is the whole reason a second UI was cheap: the Ink wizard and this API
// are two adapters over one unchanged core.

import { bindPath, bindingEntries, unbindPath } from '../../core/binding.ts'
import { validateProfileName } from '../../core/migrate.ts'
import { TIERS } from '../../core/tiers.ts'
import type { ConfigStorePort, Profile, State } from '../../ports/config-store.ts'
import type { AgentRegistryPort } from '../../ports/agent.ts'
import type { ProviderRegistryPort } from '../../ports/provider.ts'

export type ApiRequest = {
  method: string
  /** pathname only, already stripped of query and origin */
  path: string
  /** parsed JSON body, or null. `unknown` because it is untrusted input. */
  body: unknown
}

export type ApiResponse = {
  status: number
  body: unknown
}

export type ApiDeps = {
  store: ConfigStorePort
  providers: ProviderRegistryPort
  agents: AgentRegistryPort
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body })
const fail = (status: number, error: string): ApiResponse => json(status, { error })

/**
 * A profile as the BROWSER is allowed to see it.
 *
 * The key never crosses this boundary — not masked, not truncated, not
 * length-hinted. That is the same rule the doctor already follows, and it
 * matters more here: a value rendered into a DOM can be read by anything that
 * achieves script execution on the page, ends up in browser memory dumps, and
 * is one careless devtools screenshot from a bug report.
 *
 * `hasKey` is all the UI needs to render "set / not set" and offer to replace
 * it. Editing is therefore write-only: you can overwrite a key, never read one
 * back. `apiKeyFromEnv` IS sent, because a variable NAME is not a secret and
 * the user needs to see which one is being read.
 */
export type RedactedProfile = Omit<Profile, 'apiKey'> & { hasKey: boolean }

export function redactProfile(profile: Profile): RedactedProfile {
  const { apiKey, ...rest } = profile
  return { ...rest, hasKey: typeof apiKey === 'string' && apiKey.length > 0 }
}

export function redactState(state: State): unknown {
  return {
    ...state,
    profiles: Object.fromEntries(
      Object.entries(state.profiles ?? {}).map(([name, p]) => [name, redactProfile(p)]),
    ),
  }
}

/** `unknown` -> an indexable object, and nothing more. */
function isObjectLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/**
 * Lost-update check.
 *
 * The client sends the revision it last read. If the file has changed since,
 * the write is REFUSED rather than merged: swisscode cannot know which of two
 * divergent edits the user meant, and silently keeping one would be exactly the
 * kind of confident wrongness the rest of the codebase refuses.
 *
 * 409 rather than 412 because the client is expected to reload and retry, and
 * 409 is what every UI framework's error handling already understands.
 */
function revisionConflict(store: ConfigStorePort, body: unknown): ApiResponse | null {
  if (!store.revision) return null
  const sent = isObjectLike(body) ? body.revision : undefined
  // A client that sends no revision at all is a client that never read the
  // config — refuse rather than let it stomp.
  if (typeof sent !== 'string' && sent !== null) {
    return fail(400, 'write refused: no revision supplied, so a lost update cannot be ruled out')
  }
  const current = store.revision()
  if ((sent ?? null) !== current) {
    return json(409, {
      error:
        'config.json changed since you loaded it — another swisscode command or window ' +
        'wrote to it. Reload before saving so you do not overwrite that change.',
      revision: current,
    })
  }
  return null
}

/** Save, and report the new revision so the client can keep editing. */
function commit(store: ConfigStorePort, state: State, extra: unknown = {}): ApiResponse {
  try {
    store.save(state)
  } catch (err) {
    // readOnly (a newer schema on disk) lands here, and it is a refusal the
    // user must see verbatim rather than as a generic 500.
    return fail(409, (err as { message?: string }).message ?? 'could not write config.json')
  }
  return json(200, {
    ok: true,
    revision: store.revision ? store.revision() : null,
    ...(isObjectLike(extra) ? extra : {}),
  })
}

/**
 * A profile submitted by the browser, validated field by field.
 *
 * Whitelisted rather than spread: an unknown key from a hostile or buggy client
 * must not reach config.json, where a future swisscode would read it as
 * meaningful. `apiKey` is accepted (write-only) but only when non-empty — an
 * empty string from a form the user did not touch must not erase a stored key,
 * which is the single most destructive mistake this endpoint could make.
 */
export function parseProfile(input: unknown, existing: Profile | undefined): Profile | string {
  if (!isObjectLike(input)) return 'profile must be an object'
  const provider = str(input.provider)
  if (!provider) return 'provider is required'

  const profile: Profile = { ...(existing ?? {}), provider } as Profile

  if (typeof input.baseUrl === 'string') profile.baseUrl = input.baseUrl
  if (typeof input.agent === 'string') profile.agent = input.agent
  if (typeof input.skipPermissions === 'boolean') profile.skipPermissions = input.skipPermissions

  // Write-only, and never cleared by omission. Clearing is an explicit
  // `apiKey: null`, so "I did not touch this field" and "remove my key" stop
  // being the same request.
  if (typeof input.apiKey === 'string' && input.apiKey.length > 0) profile.apiKey = input.apiKey
  if (input.apiKey === null) delete profile.apiKey

  if (typeof input.apiKeyFromEnv === 'string') {
    if (input.apiKeyFromEnv) profile.apiKeyFromEnv = input.apiKeyFromEnv
    else delete profile.apiKeyFromEnv
  }

  if (isObjectLike(input.models)) {
    const models: Record<string, string> = {}
    for (const tier of TIERS) {
      const v = input.models[tier]
      if (typeof v === 'string') models[tier] = v
    }
    profile.models = models
  }

  if (isObjectLike(input.compat)) {
    // Built as a plain record then asserted once. The flag NAMES are validated
    // downstream by registry.test.ts's "compat flags are all real" rule and are
    // inert if unknown, so an unrecognised key here is a no-op rather than a
    // write of a bogus variable — the same tolerance the CLI path has.
    const compat: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(input.compat)) {
      if (typeof v === 'boolean') compat[k] = v
    }
    profile.compat = compat as NonNullable<Profile['compat']>
  }

  if (isObjectLike(input.env)) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(input.env)) {
      if (typeof v === 'string') env[k] = v
    }
    profile.env = env
  }

  return profile
}

export function handleApi(req: ApiRequest, deps: ApiDeps): ApiResponse {
  const { store, providers, agents } = deps
  const segments = req.path.replace(/^\/api\/?/, '').split('/').filter(Boolean)
  const [resource, ...rest] = segments

  // Everything the UI needs for a cold start, in one round trip: state, the
  // shipped catalogues of providers and agents, and the revision every
  // subsequent write must quote back.
  if (resource === 'bootstrap' && req.method === 'GET') {
    const loaded = store.load()
    return json(200, {
      state: redactState(loaded.state),
      revision: store.revision ? store.revision() : null,
      readOnly: loaded.readOnly,
      corrupt: loaded.corrupt,
      warnings: loaded.warnings,
      configPath: store.path(),
      providers: providers.all().map((p) => ({
        id: p.id,
        label: p.label,
        baseUrl: p.baseUrl,
        askBaseUrl: Boolean(p.askBaseUrl),
        credentialOptional: Boolean(p.credentialOptional),
        defaultModels: p.defaultModels,
        catalogId: p.catalogId ?? null,
        hints: p.hints ?? {},
      })),
      agents: agents.all().map((a) => ({
        id: a.id,
        label: a.label,
        capabilities: a.capabilities,
      })),
      tiers: TIERS,
    })
  }

  if (resource === 'profiles') {
    const name = rest[0] ? decodeURIComponent(rest[0]) : null
    if (!name) return fail(400, 'profile name is required')

    if (req.method === 'PUT') {
      const valid = validateProfileName(name)
      if (!valid.ok) return fail(400, valid.reason)
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict

      const loaded = store.load()
      const body = isObjectLike(req.body) ? req.body.profile : null
      const parsed = parseProfile(body, loaded.state.profiles?.[name])
      if (typeof parsed === 'string') return fail(400, parsed)

      const state: State = {
        ...loaded.state,
        profiles: { ...loaded.state.profiles, [name]: parsed },
      }
      // First profile created becomes the default, matching the wizard: a lone
      // profile that is not the default is a state the CLI would then refuse to
      // launch from.
      if (!state.defaultProfile) state.defaultProfile = name
      return commit(store, state)
    }

    if (req.method === 'DELETE') {
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict
      const loaded = store.load()
      if (!loaded.state.profiles?.[name]) return fail(404, `no profile named "${name}"`)

      const profiles = { ...loaded.state.profiles }
      delete profiles[name]
      // Bindings to a deleted profile are pruned, exactly as `config rm` does.
      // Leaving them would make a directory silently fall back to the default.
      const bindings = Object.fromEntries(
        Object.entries(loaded.state.bindings ?? {}).filter(([, p]) => p !== name),
      )
      const state: State = { ...loaded.state, profiles, bindings }
      // `string | null`, not optional — null is the "no default" state the
      // launcher already knows how to report, so clear rather than delete.
      if (state.defaultProfile === name) state.defaultProfile = null
      return commit(store, state)
    }
  }

  if (resource === 'default' && req.method === 'PUT') {
    const conflict = revisionConflict(store, req.body)
    if (conflict) return conflict
    const name = isObjectLike(req.body) ? str(req.body.name) : null
    if (!name) return fail(400, 'name is required')
    const loaded = store.load()
    if (!loaded.state.profiles?.[name]) return fail(404, `no profile named "${name}"`)
    return commit(store, { ...loaded.state, defaultProfile: name })
  }

  if (resource === 'bindings') {
    const loaded = store.load()
    if (req.method === 'GET') {
      return json(200, { bindings: bindingEntries(loaded.state) })
    }
    const conflict = revisionConflict(store, req.body)
    if (conflict) return conflict
    const path = isObjectLike(req.body) ? str(req.body.path) : null
    if (!path) return fail(400, 'path is required')

    if (req.method === 'PUT') {
      const profile = isObjectLike(req.body) ? str(req.body.profile) : null
      if (!profile) return fail(400, 'profile is required')
      const bound = bindPath(loaded.state, path, profile)
      // bindPath validates the path is absolute AND that the profile exists,
      // and reports which is wrong. Forwarding its reason beats re-deriving one.
      if (!bound.ok) return fail(400, bound.reason)
      return commit(store, bound.state, { key: bound.key, replaced: bound.replaced })
    }
    if (req.method === 'DELETE') {
      const unbound = unbindPath(loaded.state, path)
      return commit(store, unbound.state, { key: unbound.key, removed: unbound.removed })
    }
  }

  return fail(404, `no route for ${req.method} ${req.path}`)
}
