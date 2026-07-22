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
import { toCustomProvider, validateCustomProvider } from '../../core/provider-def.ts'
import { TIERS } from '../../core/tiers.ts'
import { COMPAT_ENV, CREDENTIAL_ENVS } from '../agents/claude-code/env.ts'
import type { ConfigStorePort, Profile, State } from '../../ports/config-store.ts'
import type { AgentRegistryPort } from '../../ports/agent.ts'
import type { ProviderRegistryPort } from '../../ports/provider.ts'
import { RESERVED_PROVIDER_IDS, withCustomProviders } from '../providers/composite.ts'

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
  /**
   * Which agent binaries exist ON THIS MACHINE. Injected as a thunk rather than
   * a value because it stats the filesystem, and `bootstrap` is the only caller
   * that needs it — a profile write should not pay for a PATH walk.
   *
   * Optional: a caller with no process port (every unit test) simply gets no
   * installation facts rather than a fabricated "installed: false", which would
   * be a claim nobody checked.
   */
  installed?: () => InstalledAgent[]
}

/** One agent CLI, as found (or not) on this machine. */
export type InstalledAgent = {
  id: string
  label: string
  installed: boolean
  /** resolved absolute path, or null when it was not found */
  path: string | null
  /** why resolution failed, verbatim from the process adapter */
  error: string | null
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

  // Measured windows only. A non-integer or non-positive entry is dropped
  // rather than stored: this map feeds CLAUDE_CODE_AUTO_COMPACT_WINDOW, and a
  // window set too large means the conversation overflows instead of compacting.
  if (isObjectLike(input.contextWindows)) {
    const windows: Record<string, number> = {}
    for (const [model, v] of Object.entries(input.contextWindows)) {
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) windows[model] = v
    }
    profile.contextWindows = windows
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
      providers: withCustomProviders(providers, loaded.state).all().map((p) => ({
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
        binary: a.binary.name,
        overrideEnv: a.binary.overrideEnv,
      })),
      tiers: TIERS,
      // Everything the CLI can express, so the UI never has to hard-code a
      // vocabulary that would then drift from the adapter's table.
      compatFlags: Object.entries(COMPAT_ENV).map(([id, e]) => ({
        id,
        env: e.env,
        value: e.value,
        consequence: e.consequence ?? null,
      })),
      credentialEnvs: CREDENTIAL_ENVS,
      // Which of these are actually on this machine. Absent when the caller
      // wired no process port; never faked.
      installedAgents: deps.installed ? deps.installed() : null,
      // Custom providers are returned SEPARATELY from `providers` even though
      // the registry already merges them: the UI has to know which ones it may
      // edit, and a merged list cannot say.
      customProviders: loaded.state.providers ?? {},
      reservedProviderIds: providers.all().map((p) => p.id),
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

  if (resource === 'providers') {
    const id = rest[0] ? decodeURIComponent(rest[0]) : null

    if (req.method === 'PUT') {
      if (!id) return fail(400, 'provider id is required')
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict

      const loaded = store.load()
      const submitted = isObjectLike(req.body) ? req.body.provider : null
      const candidate = isObjectLike(submitted) ? { ...submitted, id } : submitted

      // The runtime twin of registry.test.ts. A shipped descriptor is guarded
      // by tests; one typed into a browser is guarded by exactly this call, so
      // the two lists of rules have to stay in step.
      const verdict = validateCustomProvider(candidate, {
        // The BASE ids, not the merged list: a custom provider must not shadow
        // a shipped preset, but it may of course overwrite ITSELF.
        reservedIds: RESERVED_PROVIDER_IDS,
        knownCompatFlags: Object.keys(COMPAT_ENV),
        credentialEnvs: CREDENTIAL_ENVS,
      })
      if (!verdict.ok) return json(400, { error: verdict.errors[0], errors: verdict.errors })

      const providersMap = { ...(loaded.state.providers ?? {}) }
      providersMap[id] = toCustomProvider(candidate as Record<string, unknown>)
      // Warnings ride along on success: they describe a config that is legal
      // and probably wrong, which is the user's call to make, not ours.
      return commit(store, { ...loaded.state, providers: providersMap }, {
        warnings: verdict.warnings,
      })
    }

    if (req.method === 'DELETE') {
      if (!id) return fail(400, 'provider id is required')
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict
      const loaded = store.load()
      if (!loaded.state.providers?.[id]) return fail(404, `no custom provider named "${id}"`)

      // Profiles pointing at it are reported, not silently repaired. Deleting
      // the provider out from under a profile leaves it unlaunchable, and the
      // user is the only one who knows which provider it should point at now.
      const orphaned = Object.entries(loaded.state.profiles ?? {})
        .filter(([, p]) => p.provider === id)
        .map(([name]) => name)

      const providersMap = { ...loaded.state.providers }
      delete providersMap[id]
      return commit(store, { ...loaded.state, providers: providersMap }, { orphanedProfiles: orphaned })
    }
  }

  if (resource === 'settings' && req.method === 'PUT') {
    const conflict = revisionConflict(store, req.body)
    if (conflict) return conflict
    const loaded = store.load()
    const input = isObjectLike(req.body) ? req.body.settings : null
    if (!isObjectLike(input)) return fail(400, 'settings must be an object')
    const settings = { ...loaded.state.settings }
    if (typeof input.quiet === 'boolean') settings.quiet = input.quiet
    if (Number.isInteger(input.bindingWalkDepth)) {
      settings.bindingWalkDepth = input.bindingWalkDepth as number
    }
    return commit(store, { ...loaded.state, settings })
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
