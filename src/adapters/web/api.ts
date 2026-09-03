// The JSON API behind the web UI.
//
// Deliberately free of node:http: a request is a plain object in and a plain
// object out, so every branch — including every refusal — is testable without
// binding a socket. The server module is the only part that knows about sockets.
//
// It is thin by construction, and now literally so: every mutation below is a
// pure function in core/operations.ts, and this file's remaining job is HTTP —
// routing, revision conflicts, redaction and status codes. That split is what
// makes a second front end cheap. It was not always true; the rules used to
// live half here and half in the Ink wizard's own `finish()`, with no way to
// tell the two agreed.

import { bindPath, bindingEntries, unbindPath } from '../../core/binding.ts'
import { TIERS } from '../../core/tiers.ts'
import {
  deleteAccount,
  deleteProfile,
  deleteProvider,
  deleteSetup,
  parseAccount,
  parseSetup,
  putAccount,
  putProfile,
  putProvider,
  putSettings,
  putSetup,
  setDefaultProfile,
} from '../../core/operations.ts'
import type { OpResult } from '../../core/operations.ts'
import type { IdentityCollision } from '../../core/account.ts'
import { COMPAT_ENV, CREDENTIAL_ENVS } from '../agents/claude-code/env.ts'
import { CATALOG_SOURCE, CLAUDE_ENV_CATALOG } from '../agents/claude-code/env-catalog.ts'
import type {
  Setup,
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
  /**
   * Who each session-mode account is logged in as, keyed by account name.
   *
   * A thunk for the same reason as `installed`: it reads a `.claude.json` per
   * session account, and only `bootstrap` wants it. Cheap enough to run on every
   * cold start — a file read, no credential, no Keychain prompt, no network —
   * which is precisely why identity is separate from usage. Measuring a window
   * costs a prompt and is a button; saying who an account IS costs nothing and
   * should already be on screen.
   *
   * Optional, and absent rather than empty when unwired: `{}` would be
   * indistinguishable from "every account is logged out".
   */
  identities?: () => {
    logins: Record<string, string | null>
    /**
     * Accounts that are really one subscription. Computed where the store is
     * read, from the SAME `core/account.ts` rule the CLI and the doctor use —
     * the browser must not re-derive it by comparing the `logins` strings, which
     * is the private-fourth-copy failure that module was written to end.
     */
    collisions: IdentityCollision[]
  }
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
    // Setups and profiles hold no credential at all now, so they pass
    // through whole. That is the split paying off: only one of the three shapes
    // is security-sensitive, and it is obvious which.
    setups: state.setups ?? {},
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
 * The shape parsers moved to core/operations.ts with the mutations they belong
 * to. Re-exported here because they are part of this module's tested surface
 * and callers should not have to care that the rules relocated.
 */
export { parseAccount, parseSetup, parseProfile } from '../../core/operations.ts'

/** Map a core refusal onto the status code it deserves. */
function refuse(result: Extract<OpResult, { ok: false }>): ApiResponse {
  const status = result.kind === 'missing' ? 404 : 400
  return result.reasons
    ? json(status, { error: result.reason, errors: result.reasons })
    : fail(status, result.reason)
}

/** Apply a pure operation and persist it, or report why it was refused. */
function apply(store: ConfigStorePort, result: OpResult): ApiResponse {
  if (!result.ok) return refuse(result)
  return commit(store, result.state, result.meta)
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
    // ONCE. Each call reads every session account's `.claude.json`, which is a
    // 200 kB file apiece on a well-used account, and both fields below come from
    // the same walk.
    const identities = deps.identities ? deps.identities() : null
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
        sessionCapable: Boolean(p.sessionCapable),
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
      // Who each session account is logged in as. Same "never faked" rule as
      // `installedAgents`: null when unwired, never an empty map that would read
      // as "all logged out".
      logins: identities ? identities.logins : null,
      // Absent-vs-empty matters here too: `[]` is a real answer ("checked, all
      // distinct"), so null has to mean "nobody looked".
      loginCollisions: identities ? identities.collisions : null,
      // Custom providers are returned SEPARATELY from `providers` even though
      // the registry already merges them: the UI has to know which ones it may
      // edit, and a merged list cannot say.
      customProviders: loaded.state.providers ?? {},
      reservedProviderIds: providers.all().map((p) => p.id),
    })
  }

  // Every environment variable Claude Code references, for the browser to
  // search. Its own route rather than a field on `bootstrap`: it is ~57 kB of
  // static data that only one screen wants, and paying for it on every cold
  // start would be a tax on people who never open that screen.
  if (resource === 'claude-env' && req.method === 'GET') {
    return json(200, { source: CATALOG_SOURCE, variables: CLAUDE_ENV_CATALOG })
  }

  if (resource === 'profiles') {
    const name = rest[0] ? decodeURIComponent(rest[0]) : null
    if (!name) return fail(400, 'profile name is required')

    if (req.method === 'PUT') {
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict
      const body = isObjectLike(req.body) ? req.body.profile : null
      return apply(store, putProfile(store.load().state, name, body))
    }

    if (req.method === 'DELETE') {
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict
      return apply(store, deleteProfile(store.load().state, name))
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
      const body = isObjectLike(req.body) ? req.body.account : null
      return apply(store, putAccount(store.load().state, name, body))
    }

    if (req.method === 'DELETE') {
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict
      return apply(store, deleteAccount(store.load().state, name))
    }
  }

  if (resource === 'agent-profiles') {
    const name = rest[0] ? decodeURIComponent(rest[0]) : null
    if (!name) return fail(400, 'setup name is required')

    if (req.method === 'PUT') {
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict
      const body = isObjectLike(req.body) ? req.body.setup : null
      return apply(store, putSetup(store.load().state, name, body))
    }

    if (req.method === 'DELETE') {
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict
      return apply(store, deleteSetup(store.load().state, name))
    }
  }

  if (resource === 'providers') {
    const id = rest[0] ? decodeURIComponent(rest[0]) : null

    if (req.method === 'PUT') {
      if (!id) return fail(400, 'provider id is required')
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict

      const submitted = isObjectLike(req.body) ? req.body.provider : null
      // The runtime twin of registry.test.ts. A shipped descriptor is guarded by
      // tests; one typed into a browser is guarded by this call, so the two
      // lists of rules have to stay in step.
      //
      // These three are PARAMETERS because they are Claude Code's: core/ may not
      // name a CLAUDE_CODE_ or ANTHROPIC_ variable, so the adapter that owns
      // them supplies them. RESERVED_PROVIDER_IDS is the BASE list, not the
      // merged one — a custom provider must not shadow a shipped preset, but it
      // may of course overwrite itself.
      return apply(store, putProvider(store.load().state, id, submitted, {
        reservedIds: RESERVED_PROVIDER_IDS,
        knownCompatFlags: Object.keys(COMPAT_ENV),
        credentialEnvs: CREDENTIAL_ENVS,
      }))
    }

    if (req.method === 'DELETE') {
      if (!id) return fail(400, 'provider id is required')
      const conflict = revisionConflict(store, req.body)
      if (conflict) return conflict
      return apply(store, deleteProvider(store.load().state, id))
    }
  }

  if (resource === 'settings' && req.method === 'PUT') {
    const conflict = revisionConflict(store, req.body)
    if (conflict) return conflict
    const input = isObjectLike(req.body) ? req.body.settings : null
    return apply(store, putSettings(store.load().state, input))
  }

  if (resource === 'default' && req.method === 'PUT') {
    const conflict = revisionConflict(store, req.body)
    if (conflict) return conflict
    const name = isObjectLike(req.body) ? str(req.body.name) : null
    if (!name) return fail(400, 'name is required')
    return apply(store, setDefaultProfile(store.load().state, name))
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
