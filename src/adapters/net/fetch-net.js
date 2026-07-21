/** @type {import('../../ports/net.js').NetPort} */
export const fetchNet = {
  async getJson(url, { timeoutMs = 10_000, headers = {} } = {}) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`)
    return res.json()
  },
}
