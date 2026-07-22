// Endpoint-safety helpers. Neutral: no agent/provider or ANTHROPIC_* specifics,
// just facts about a URL string. Used on the launch path (cleartext warning for
// every agent) and by the doctor (endpoint check + display sanitizing).

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')
}

/**
 * True when a credential sent to this base URL would travel in cleartext to a
 * host that is NOT loopback — i.e. an `http://` remote endpoint. Loopback stays
 * exempt so a local gateway (http://127.0.0.1:8080) does not warn. A URL that
 * does not parse, or is already https, returns false.
 */
export function isInsecureRemoteBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  return url.protocol === 'http:' && !isLoopbackHost(url.hostname)
}

/**
 * A base URL with any `user:pass@` userinfo cleared, safe to print. Returns the
 * input unchanged when it has no userinfo or does not parse. Sanitizing the
 * DISPLAY value (not just adding the secret to a redaction set) is required
 * because redaction skips secrets shorter than 4 chars.
 */
export function sanitizeUrlForDisplay(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (!url.username && !url.password) return raw
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return raw
  }
}

/** The non-empty username/password carried in a URL's userinfo, for redaction. */
export function urlCredentials(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const url = new URL(raw)
    return [url.password, url.username].filter((s) => s.length > 0)
  } catch {
    return []
  }
}
