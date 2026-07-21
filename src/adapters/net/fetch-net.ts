import type { NetPort } from '../../ports/net.ts'

/**
 * `res.json()` is typed `Promise<any>` by the lib, and `any` would happily flow
 * an unvalidated upstream field all the way into ANTHROPIC_DEFAULT_*_MODEL
 * without a single diagnostic.
 *
 * The `NetPort` annotation is what stops that. The port declares `getJson`
 * returning `Promise<unknown>`, so the `any` is CONTAINED at this boundary and
 * every caller has to narrow before it can read a field. Nothing in this
 * adapter looks inside the body — it only checks the HTTP status — so `unknown`
 * is not a conservative guess here, it is the strongest true statement
 * available. See the note in ports/net.ts.
 */
export const fetchNet: NetPort = {
  async getJson(url, { timeoutMs = 10_000, headers = {} } = {}) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`)
    return res.json()
  },
}
