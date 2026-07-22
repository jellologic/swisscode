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

/** A profile as the browser is allowed to see it: `hasKey`, never the key. */
export type Profile = {
  provider: string
  agent?: string
  baseUrl?: string
  hasKey: boolean
  apiKeyFromEnv?: string
  models?: Record<string, string>
  compat?: Record<string, boolean>
  env?: Record<string, string>
  contextWindows?: Record<string, number>
  skipPermissions?: boolean
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
  customProviders: Record<string, CustomProvider>
  reservedProviderIds: string[]
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

export const api = {
  bootstrap: () => call<Bootstrap>('/api/bootstrap'),

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

  saveSettings: (settings: unknown, revision: string | null) =>
    call<{ revision: string }>('/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ revision, settings }),
    }),
}
