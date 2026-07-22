// The typed client for swisscode's local API.
//
// Two things every call here depends on, both decided server-side:
//
//   1. The token comes from a meta tag the server injected, and goes back in a
//      CUSTOM header. That header is what forces a CORS preflight the server
//      never answers, so a page on another origin cannot make these calls at
//      all — it never gets far enough to be refused.
//   2. Writes carry the `revision` they were based on. The server rejects a
//      stale one with 409 rather than merging, because it cannot know which of
//      two divergent edits was meant.

export const TOKEN_HEADER = 'x-swisscode-token'

function token(): string {
  const meta = document.querySelector('meta[name=swisscode-token]')
  return meta?.getAttribute('content') ?? ''
}

export type CompatFlag = {
  id: string
  env: string
  value: string
  /** non-null when enabling it gives something up; the UI must show it */
  consequence: string | null
}

export type ProviderInfo = {
  id: string
  label: string
  baseUrl: string | null
  askBaseUrl: boolean
  credentialOptional: boolean
  defaultModels: Record<string, string>
  catalogId: string | null
  hints: { keyHint?: string; modelHint?: string; note?: string }
}

export type AgentInfo = {
  id: string
  label: string
  capabilities: { models: string; skipPermissions: boolean; extendedContextSuffix: boolean; compatFlags: boolean }
  binary: string
  overrideEnv: string
}

export type InstalledAgent = {
  id: string
  label: string
  installed: boolean
  path: string | null
  error: string | null
}

/**
 * WHO PAYS, as the browser is allowed to see it: `hasKey`, never the key.
 *
 * Only one of the three shapes is security-sensitive, and this is it — which is
 * itself a benefit of the split, since there is one type to get right rather
 * than one field on a type carrying everything else.
 */
export type ProviderAccount = {
  provider: string
  label?: string
  baseUrl?: string
  hasKey: boolean
  apiKeyFromEnv?: string
  /**
   * Session mode: a directory holding a login the agent already performed.
   *
   * Crosses to the browser in full, unlike `apiKey`, because it is a PATH and
   * not a secret — the credential it points at stays in the Keychain, which is
   * the entire point of this mode. Mutually exclusive with the key fields; the
   * server refuses the combination rather than picking one.
   */
  configDir?: string
}

/** WHAT RUNS. Holds no credential, so it crosses whole. */
export type AgentProfile = {
  agent?: string
  label?: string
  models?: Record<string, string>
  compat?: Record<string, boolean>
  env?: Record<string, string>
  contextWindows?: Record<string, number>
  skipPermissions?: boolean
}

export type SelectionStrategy = 'single' | 'round-robin' | 'usage'

/** THE PAIRING. References plus the rule for choosing among them. */
export type Profile = {
  label?: string
  agentProfile: string
  accounts: string[]
  strategy?: SelectionStrategy
}

export type CustomProvider = {
  id: string
  label: string
  baseUrl: string
  credentialEnv?: string
  credentialOptional?: boolean
  defaultCredential?: string
  defaultModels?: Record<string, string>
  env?: Record<string, string>
  unsetEnv?: string[]
  compat?: Record<string, boolean>
  subagentFollowsOpus?: boolean
}

export type Bootstrap = {
  state: {
    providerAccounts: Record<string, ProviderAccount>
    agentProfiles: Record<string, AgentProfile>
    profiles: Record<string, Profile>
    defaultProfile: string | null
    bindings: Record<string, unknown>
    settings: { quiet?: boolean; bindingWalkDepth?: number }
  }
  revision: string | null
  readOnly: boolean
  corrupt: boolean
  warnings: string[]
  configPath: string
  providers: ProviderInfo[]
  agents: AgentInfo[]
  tiers: string[]
  compatFlags: CompatFlag[]
  credentialEnvs: string[]
  installedAgents: InstalledAgent[] | null
  /**
   * Who each session account is logged in as, keyed by account name.
   *
   * Null when the server wired no identity reader — NOT an empty map, which
   * would be indistinguishable from "every account is logged out". Key-mode
   * accounts are simply absent from it.
   */
  logins: Record<string, string | null> | null
  customProviders: Record<string, CustomProvider>
  reservedProviderIds: string[]
}

/** One window of a subscription, as the endpoint publishes it. */
export type UsageWindow = { utilization: number | null; resetsAt: string | null }

export type MeasuredAccount = {
  name: string
  mode: 'session' | 'key'
  login: string | null
  remaining: number | null
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
}

export type UsageReport = {
  accounts: MeasuredAccount[]
  checkedAt: number | null
}

/** A refusal the UI must render rather than swallow. */
export class ApiError extends Error {
  status: number
  errors: string[]
  constructor(status: number, message: string, errors: string[] = []) {
    super(message)
    this.status = status
    this.errors = errors
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      [TOKEN_HEADER]: token(),
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    throw new ApiError(
      res.status,
      typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
      Array.isArray(body.errors) ? (body.errors as string[]) : [],
    )
  }
  return body as T
}

export type DoctorCheck = {
  id: string
  title: string
  status: 'ok' | 'warn' | 'error' | 'skip'
  detail: string
  fix?: string
}

export type DoctorReport = {
  profile: string | null
  provider: string | null
  endpoint: string | null
  checks: DoctorCheck[]
  notes: string[]
  summary: { counts: Record<string, number>; exitCode: number }
}

export type CatalogModel = {
  id: string
  name: string
  description?: string
  context: number | null
  pricing: { prompt: number; completion: number } | null
  /** TRI-STATE. null is UNKNOWN, false is CONFIRMED ABSENT. Do not collapse. */
  tools: boolean | null
}

export type CatalogResult = {
  id: string
  label: string
  capabilities: { pricing: boolean; benchmarks: boolean; toolSupportKnown: boolean }
  models: CatalogModel[]
  fromCache: boolean
  stale: boolean
  error: string | null
}

export const api = {
  bootstrap: () => call<Bootstrap>('/api/bootstrap'),

  saveAccount: (name: string, account: unknown, revision: string | null) =>
    call<{ revision: string }>(`/api/accounts/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ revision, account }),
    }),

  deleteAccount: (name: string, revision: string | null) =>
    call<{ revision: string; affectedProfiles: string[] }>(
      `/api/accounts/${encodeURIComponent(name)}`,
      { method: 'DELETE', body: JSON.stringify({ revision }) },
    ),

  saveAgentProfile: (name: string, agentProfile: unknown, revision: string | null) =>
    call<{ revision: string }>(`/api/agent-profiles/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ revision, agentProfile }),
    }),

  deleteAgentProfile: (name: string, revision: string | null) =>
    call<{ revision: string; affectedProfiles: string[] }>(
      `/api/agent-profiles/${encodeURIComponent(name)}`,
      { method: 'DELETE', body: JSON.stringify({ revision }) },
    ),

  saveProfile: (name: string, profile: unknown, revision: string | null) =>
    call<{ revision: string }>(`/api/profiles/${encodeURIComponent(name)}`, {
      method: 'PUT',
      body: JSON.stringify({ revision, profile }),
    }),

  deleteProfile: (name: string, revision: string | null) =>
    call<{ revision: string }>(`/api/profiles/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      body: JSON.stringify({ revision }),
    }),

  setDefault: (name: string, revision: string | null) =>
    call<{ revision: string }>('/api/default', {
      method: 'PUT',
      body: JSON.stringify({ revision, name }),
    }),

  saveProvider: (id: string, provider: unknown, revision: string | null) =>
    call<{ revision: string; warnings?: string[] }>(`/api/providers/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ revision, provider }),
    }),

  deleteProvider: (id: string, revision: string | null) =>
    call<{ revision: string; orphanedProfiles: string[] }>(
      `/api/providers/${encodeURIComponent(id)}`,
      { method: 'DELETE', body: JSON.stringify({ revision }) },
    ),

  /**
   * `offline` defaults to true server-side. Sending false is opting IN to real,
   * billable inference probes — so the UI must make that an explicit click.
   */
  doctor: (offline: boolean) =>
    call<{ report: DoctorReport; offline: boolean }>('/api/doctor', {
      method: 'POST',
      body: JSON.stringify({ offline }),
    }),

  catalog: (id: string) => call<CatalogResult>(`/api/catalog/${encodeURIComponent(id)}`),

  /**
   * Measure every account's remaining subscription window, and cache it.
   *
   * A POST, not a GET, because on macOS each measurement can raise a Keychain
   * unlock dialog — and a GET is something a browser may prefetch, retry or
   * replay on its own initiative. Nothing that can pop a system dialog should
   * be reachable that way.
   */
  usage: () => call<UsageReport>('/api/usage', { method: 'POST', body: JSON.stringify({}) }),

  saveSettings: (settings: unknown, revision: string | null) =>
    call<{ revision: string }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ revision, settings }),
    }),
}
