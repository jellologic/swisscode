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
import type {
  AgentProfile,
  ConfigStorePort,
  Profile,
  ProviderAccount,
  State,
} from '../../ports/config-store.ts'
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
 * A provider ACCOUNT as the browser is allowed to see it.
 *
 * Redaction moved here with the credential. Since v3 the key lives on the
 * account rather than on the profile, so this is now the single boundary it
 * could cross — which is an improvement: there is one type to get right instead
 * of one field on a type that also carried everything else.
 *
 * The key never crosses — not masked, not truncated, not length-hinted. That is
 * the same rule the doctor follows, and it matters more here: a value rendered
 * into a DOM can be read by anything that achieves script execution on the page
 * and is one careless screenshot from a bug report.
 *
 * `hasKey` is all the UI needs to render "set / not set" and offer to replace
 * it, so editing is write-only. `apiKeyFromEnv` IS sent, because a variable
 * NAME is not a secret and the user needs to see which one is read.
 */
export type RedactedAccount = Omit<ProviderAccount, 'apiKey'> & { hasKey: boolean }

export function redactAccount(account: ProviderAccount): RedactedAccount {
  const { apiKey, ...rest } = account
  return { ...rest, hasKey: typeof apiKey === 'string' && apiKey.length > 0 }
}

export function redactState(state: State): unknown {
  return {
    ...state,
    providerAccounts: Object.fromEntries(
      Object.entries(state.providerAccounts ?? {}).map(([n, a]) => [n, redactAccount(a)]),
    ),
    // Agent profiles and profiles hold no credential at all now, so they pass
    // through whole. That is the split paying off: only one of the three shapes
    // is security-sensitive, and it is obvious which.
    agentProfiles: state.agentProfiles ?? {},
    profiles: state.profiles ?? {},
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
 * A provider account submitted by the browser.
 *
 * Whitelisted rather than spread: an unknown key from a hostile or buggy client
 * must not reach config.json, where a future swisscode would read it as
 * meaningful.
 *
 * `apiKey` is accepted (write-only) but only when NON-EMPTY — an empty string
 * from a form the user did not touch must not erase a stored key, which is the
 * single most destructive mistake this endpoint could make. Clearing is an
 * explicit `null`, so "I did not touch this" and "remove my credential" stay
 * different requests.
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
  if (typeof input.baseUrl === 'string') account.baseUrl = input.baseUrl
  if (typeof input.apiKey === 'string' && input.apiKey.length > 0) account.apiKey = input.apiKey
  if (input.apiKey === null) delete account.apiKey
  if (typeof input.apiKeyFromEnv === 'string') {
    if (input.apiKeyFromEnv) account.apiKeyFromEnv = input.apiKeyFromEnv
    else delete account.apiKeyFromEnv
  }
  return account
}

/** An agent profile submitted by the browser. Holds no credential. */
export function parseAgentProfile(
  input: unknown,
  existing: AgentProfile | undefined,
): AgentProfile | string {
  if (!isObjectLike(input)) return 'agent profile must be an object'
  const agentProfile: AgentProfile = { ...(existing ?? {}) }

  if (typeof input.label === 'string') agentProfile.label = input.label
  if (typeof input.agent === 'string') agentProfile.agent = input.agent
  if (typeof input.skipPermissions === 'boolean') {
    agentProfile.skipPermissions = input.skipPermissions
  }

  if (isObjectLike(input.models)) {
    const models: Record<string, string> = {}
    for (const tier of TIERS) {
      const v = input.models[tier]
      if (typeof v === 'string') models[tier] = v
    }
    agentProfile.models = models
  }

  if (isObjectLike(input.compat)) {
    const compat: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(input.compat)) {
      if (typeof v === 'boolean') compat[k] = v
    }
    agentProfile.compat = compat as NonNullable<AgentProfile['compat']>
  }

  if (isObjectLike(input.env)) {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(input.env)) {
      if (typeof v === 'string') env[k] = v
    }
    agentProfile.env = env
  }

  // Measured windows only. A non-integer or non-positive entry is dropped
  // rather than stored: this feeds CLAUDE_CODE_AUTO_COMPACT_WINDOW, and a
  // window set too large overflows the conversation instead of compacting it.
  if (isObjectLike(input.contextWindows)) {
    const windows: Record<string, number> = {}
    for (const [model, v] of Object.entries(input.contextWindows)) {
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) windows[model] = v
    }
    agentProfile.contextWindows = windows
  }

  return agentProfile
}

/**
 * The pairing. References only — no credential, no agent settings.
 *
 * References are NOT validated against the store here; that is the caller's
 * job, because it holds the state and can name what is missing. Validating
 * shape and validating existence are different failures and deserve different
 * messages.
 */
export function parseProfile(input: unknown, existing: Profile | undefined): Profile | string {
  if (!isObjectLike(input)) return 'profile must be an object'
  const agentProfile = str(input.agentProfile) ?? existing?.agentProfile
  if (!agentProfile) return 'agentProfile is required'

  const accounts = Array.isArray(input.accounts)
    ? input.accounts.filter((a): a is string => typeof a === 'string' && a.length > 0)
    : (existing?.accounts ?? [])
  if (accounts.length === 0) return 'a profile needs at least one provider account'

  const profile: Profile = { ...(existing ?? {}), agentProfile, accounts }
  if (typeof input.label === 'string') profile.label = input.label
  if (input.strategy === 'single' || input.strategy === 'round-robin' || input.strategy === 'usage') {
    profile.strategy = input.strategy
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

      // References are checked HERE, where the state is in hand. parseProfile
      // validated the shape; this validates that the things it names exist.
      if (!loaded.state.agentProfiles?.[parsed.agentProfile]) {
        return fail(400, `no agent profile named "${parsed.agentProfile}"`)
      }
      const missing = parsed.accounts.filter((a) => !loaded.state.providerAccounts?.[a])
      if (missing.length > 0) {
        return fail(400, `no provider account named "${missing[0]}"`)
      }

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

  // The two halves a profile references. Same revision discipline, same
  // whitelisting; separate routes because they are separate things now, and a
  // single endpoint taking a flat blob would re-create exactly the conflation
  // v3 exists to undo.
  if (resource === 'accounts') {
    const name = rest[0] ? decodeURIComponent(rest[0]) : null
    if (!name) return fail(400, 'account name is required')

    if (req.method === 'PUT') {
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict
      const loaded = store.load()
      const parsed = parseAccount(
        isObjectLike(req.body) ? req.body.account : null,
        loaded.state.providerAccounts?.[name],
      )
      if (typeof parsed === 'string') return fail(400, parsed)
      return commit(store, {
        ...loaded.state,
        providerAccounts: { ...loaded.state.providerAccounts, [name]: parsed },
      })
    }

    if (req.method === 'DELETE') {
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict
      const loaded = store.load()
      if (!loaded.state.providerAccounts?.[name]) return fail(404, `no account named "${name}"`)

      // Profiles referencing it are REPORTED, never silently repaired: only the
      // user knows which account should pay instead.
      const affected = Object.entries(loaded.state.profiles ?? {})
        .filter(([, pr]) => (pr.accounts ?? []).includes(name))
        .map(([n]) => n)

      const accounts = { ...loaded.state.providerAccounts }
      delete accounts[name]
      return commit(store, { ...loaded.state, providerAccounts: accounts }, {
        affectedProfiles: affected,
      })
    }
  }

  if (resource === 'agent-profiles') {
    const name = rest[0] ? decodeURIComponent(rest[0]) : null
    if (!name) return fail(400, 'agent profile name is required')

    if (req.method === 'PUT') {
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict
      const loaded = store.load()
      const parsed = parseAgentProfile(
        isObjectLike(req.body) ? req.body.agentProfile : null,
        loaded.state.agentProfiles?.[name],
      )
      if (typeof parsed === 'string') return fail(400, parsed)
      return commit(store, {
        ...loaded.state,
        agentProfiles: { ...loaded.state.agentProfiles, [name]: parsed },
      })
    }

    if (req.method === 'DELETE') {
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict
      const loaded = store.load()
      if (!loaded.state.agentProfiles?.[name]) return fail(404, `no agent profile named "${name}"`)
      const affected = Object.entries(loaded.state.profiles ?? {})
        .filter(([, pr]) => pr.agentProfile === name)
        .map(([n]) => n)
      const agentProfiles = { ...loaded.state.agentProfiles }
      delete agentProfiles[name]
      return commit(store, { ...loaded.state, agentProfiles }, { affectedProfiles: affected })
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

      // ACCOUNTS point at providers now, not profiles — so deleting a provider
      // orphans accounts, and those in turn orphan whichever profiles use them.
      // Both are reported, never silently repaired: only the user knows where a
      // profile should point next.
      const orphanedAccounts = Object.entries(loaded.state.providerAccounts ?? {})
        .filter(([, a]) => a.provider === id)
        .map(([name]) => name)
      const orphaned = Object.entries(loaded.state.profiles ?? {})
        .filter(([, p]) => (p.accounts ?? []).some((a) => orphanedAccounts.includes(a)))
        .map(([name]) => name)

      const providersMap = { ...loaded.state.providers }
      delete providersMap[id]
      return commit(store, { ...loaded.state, providers: providersMap }, {
        orphanedAccounts,
        orphanedProfiles: orphaned,
      })
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
