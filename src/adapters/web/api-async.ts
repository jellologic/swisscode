// The two API routes that do I/O.
//
// Kept OUT of api.ts deliberately. Everything there is a pure
// (request, deps) -> response function, which is why every refusal in it is
// testable without a socket, a clock or a network. Widening that signature to
// `ApiResponse | Promise<ApiResponse>` so two endpoints could await would have
// pushed asynchrony into ~20 branches that have no reason to know about it.
//
// So this module owns the I/O routes and answers `null` for anything it does
// not recognise, letting the server fall through to the pure handler. The seam
// is one `if` in server.ts.

import type { ApiResponse } from './api.ts'
import type { CatalogRegistryPort } from '../../ports/catalog.ts'
import type { DoctorReport } from '../../ports/doctor.ts'

export type AsyncApiDeps = {
  /**
   * Runs the real doctor. Injected rather than imported so this module needs no
   * ProcessPort of its own, and so a test can drive every branch without
   * resolving a binary or reaching a network.
   */
  doctor?: (opts: { offline: boolean }) => Promise<DoctorReport>
  /** Built lazily by web-root; absent when no catalog adapters are wired. */
  catalogs?: CatalogRegistryPort
}

const json = (status: number, body: unknown): ApiResponse => ({ status, body })

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * @returns the response, or null when this module does not own the route.
 */
export async function handleAsyncApi(
  req: { method: string; path: string; body: unknown },
  deps: AsyncApiDeps,
): Promise<ApiResponse | null> {
  const segments = req.path.replace(/^\/api\/?/, '').split('/').filter(Boolean)
  const [resource, ...rest] = segments

  if (resource === 'doctor' && req.method === 'POST') {
    if (!deps.doctor) return json(501, { error: 'the doctor is not available in this context' })

    // DEFAULTS TO OFFLINE, which inverts the CLI. On the command line running
    // `config doctor` is an explicit act; a web UI invites clicking, and the
    // probes are real billable inference requests. Opting IN to spending money
    // is the only defensible default for a button.
    const offline = isObjectLike(req.body) ? req.body.offline !== false : true
    try {
      const report = await deps.doctor({ offline })
      return json(200, { report, offline })
    } catch (err) {
      return json(500, { error: (err as { message?: string }).message ?? 'doctor failed' })
    }
  }

  if (resource === 'catalog' && req.method === 'GET') {
    const id = rest[0] ? decodeURIComponent(rest[0]) : null
    if (!id) return json(400, { error: 'catalog id is required' })
    const catalog = deps.catalogs?.byId(id)
    // A provider whose catalogId is null is the common case, not an error —
    // most providers publish nothing browsable.
    if (!catalog) return json(404, { error: `no catalog named "${id}"` })

    // `list()` never throws by contract: an offline box with a warm cache still
    // gets a working picker, and a cold one gets an empty list plus a reason.
    const result = await catalog.list()
    return json(200, {
      id: catalog.id,
      label: catalog.label,
      capabilities: catalog.capabilities,
      ...result,
    })
  }

  return null
}
