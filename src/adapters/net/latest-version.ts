// Asking npm what the latest swisscode is.
//
// CONFIGURATION-TIME ONLY. This module reaches the network, so it may never
// appear on the launch path — `test/architecture.test.ts` enforces that for
// `adapters/net` already. The launcher reads the cached answer instead.
//
// Uses the ABBREVIATED packument (`application/vnd.npm.install-v1+json`), which
// is what npm's own installer requests: it omits READMEs and per-version
// metadata, so the response is a few kB rather than a few hundred. We want one
// string out of it.

/** The registry, overridable so a private mirror or a test can stand in. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

export type LatestVersionOptions = {
  packageName?: string
  registry?: string
  timeoutMs?: number
  /** injected in tests; defaults to global fetch */
  fetchImpl?: typeof fetch
}

/**
 * The published `latest` dist-tag, or null.
 *
 * NEVER THROWS, and null covers every failure — offline, rate-limited, a
 * private registry that does not carry this package, a shape change. This runs
 * as a side errand of some command the user actually asked for, and an update
 * check that could fail `config list` would be a worse bug than a stale
 * version.
 */
export async function fetchLatestVersion({
  packageName = 'swisscode',
  registry = DEFAULT_REGISTRY,
  timeoutMs = 3000,
  fetchImpl = fetch,
}: LatestVersionOptions = {}): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(
      `${registry.replace(/\/+$/, '')}/${encodeURIComponent(packageName)}`,
      {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
        signal: controller.signal,
      },
    )
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object') return null
    const tags = (body as { 'dist-tags'?: unknown })['dist-tags']
    if (!tags || typeof tags !== 'object') return null
    const latest = (tags as Record<string, unknown>).latest
    return typeof latest === 'string' && latest !== '' ? latest : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
