// The gate in front of the web UI's API.
//
// This is the highest-stakes code in the project. The server it guards can read
// and write config.json, which holds API keys in plaintext — and a browser will
// cheerfully issue requests to 127.0.0.1 on behalf of ANY page the user has
// open. "It only listens on localhost" is not a security model; it is the
// reason one is required.
//
// Three attacks decide the design, and each countermeasure below names the one
// it stops. Pure functions, so every branch is testable without a socket.

/**
 * The token, minted per server run and never persisted.
 *
 * It is injected into index.html at serve time and read back by the SPA, rather
 * than being set as a cookie. That choice is the CSRF defence and it is worth
 * spelling out: a cookie is attached by the browser AUTOMATICALLY on
 * cross-origin requests, so a malicious page could ride it. A value the client
 * has to read out of our HTML and echo in a header cannot be ridden, because
 * the attacker's page is forbidden by the same-origin policy from reading our
 * response body to learn it.
 */
import { createHash } from 'node:crypto'

export type WebSecurityOptions = {
  token: string
  /** the port the server actually bound, needed to validate Host exactly */
  port: number
}

/** A rejection carries the status AND the reason, so the server can log it. */
export type SecurityVerdict = { ok: true } | { ok: false; status: number; reason: string }

const OK: SecurityVerdict = { ok: true }

/**
 * Hosts a browser may legitimately use to reach us.
 *
 * EXACT MATCH on host:port, not a suffix or a substring test. This is the
 * DNS-rebinding defence: an attacker registers evil.example, points it at
 * 127.0.0.1, and the victim's browser then sends requests to our server with
 * `Host: evil.example`. The connection is genuinely from localhost and the
 * socket-level check everyone reaches for first cannot tell the difference. The
 * Host header can — nothing legitimate ever arrives claiming to be a name we
 * did not bind.
 *
 * IPv6 loopback is spelled bracketed because that is how a browser sends it.
 */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
}

export function checkHost(host: string | undefined, port: number): SecurityVerdict {
  if (!host) return { ok: false, status: 400, reason: 'request carried no Host header' }
  if (!allowedHosts(port).includes(host.toLowerCase())) {
    return {
      ok: false,
      status: 403,
      reason:
        `Host "${host}" is not one this server bound. This is what a DNS-rebinding ` +
        'attack looks like: a page on another origin resolving its own hostname to ' +
        'your loopback address.',
    }
  }
  return OK
}

/**
 * Origin, checked only where it exists.
 *
 * Absent on same-origin GETs in some browsers, so a missing Origin cannot be
 * fatal without breaking ordinary navigation. Present-and-wrong, however, is
 * unambiguous: some other site is driving this request.
 */
export function checkOrigin(origin: string | undefined, port: number): SecurityVerdict {
  if (!origin) return OK
  const allowed = allowedHosts(port).map((h) => `http://${h}`)
  if (!allowed.includes(origin.toLowerCase())) {
    return { ok: false, status: 403, reason: `Origin "${origin}" is not this server` }
  }
  return OK
}

/**
 * Constant-time comparison.
 *
 * `a === b` on a secret leaks its prefix through timing. The window is small
 * over loopback and the attack is fiddly — and it costs one function to remove
 * the question entirely, which is cheaper than being asked to justify keeping
 * it.
 *
 * Length is compared first and non-constant-time deliberately: the length of
 * this token is fixed and public (it is minted here), so it is not a secret to
 * protect.
 */
export function tokensMatch(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** The header the SPA echoes the token in. Custom on purpose — see below. */
export const TOKEN_HEADER = 'x-swisscode-token'

export function checkToken(headerValue: string | undefined, token: string): SecurityVerdict {
  if (!tokensMatch(headerValue, token)) {
    return {
      ok: false,
      status: 401,
      reason: `missing or wrong ${TOKEN_HEADER} header`,
    }
  }
  return OK
}

/**
 * Every API request runs this. Order matters only for which reason gets
 * reported first; all three must pass.
 *
 * The CUSTOM header is doing more work than it looks. A cross-origin page
 * cannot set an arbitrary request header without triggering a CORS preflight,
 * and this server answers no preflight and sends no
 * Access-Control-Allow-Origin. So a hostile page cannot even get the real
 * request sent, let alone read the reply — the token check is the belt to that
 * pair of braces.
 */
export function guardApiRequest(
  headers: {
    host?: string | undefined
    origin?: string | undefined
    token?: string | undefined
  },
  { token, port }: WebSecurityOptions,
): SecurityVerdict {
  const host = checkHost(headers.host, port)
  if (!host.ok) return host
  const origin = checkOrigin(headers.origin, port)
  if (!origin.ok) return origin
  return checkToken(headers.token, token)
}

/**
 * The document request (GET /) is guarded by Host and Origin but NOT by the
 * token — the token is what the document is delivering, so requiring it would
 * be circular.
 *
 * That is safe precisely because of what the document contains: markup and a
 * token, no user data. An attacker who could somehow cause this response has
 * still learned nothing, because they cannot read it cross-origin.
 */
export function guardDocumentRequest(
  headers: { host?: string | undefined; origin?: string | undefined },
  { port }: Pick<WebSecurityOptions, 'port'>,
): SecurityVerdict {
  const host = checkHost(headers.host, port)
  if (!host.ok) return host
  return checkOrigin(headers.origin, port)
}

/**
 * Headers on every response.
 *
 * The CSP is strict because this page renders values that came from a config
 * file a user may have hand-edited — a profile name is attacker-influenced data
 * in the only threat model that matters here (someone else's config pasted in
 * from a bug report). `default-src 'self'` with no `unsafe-inline` for scripts
 * means an injected string cannot execute.
 *
 * `Cache-Control: no-store` because the document carries the session token, and
 * a token in a disk cache outlives the server that issued it.
 */
/**
 * The CSP for a document, with the hashes of the inline scripts it contains.
 *
 * WHY HASHES AND NOT `unsafe-inline`. The page needs exactly one inline script:
 * the theme resolver, which must run BEFORE first paint or every dark-mode user
 * gets a white flash on load. Deferring it to React is what causes that flash,
 * and moving it to a file makes the document depend on a second request to look
 * right. So it stays inline — and the CSP names its exact bytes.
 *
 * This is TIGHTER than it looks, not a loosening. `unsafe-inline` would allow
 * any injected script to run; a hash allows one specific script and nothing
 * else, so an attacker who manages to inject a `<script>` into this document
 * still gets it blocked. The hash is computed from the HTML actually being
 * served, so the two can never disagree — and if the document is tampered with
 * in transit, the hash stops matching and the script stops running, which is
 * the behaviour you want.
 */
export function documentSecurityHeaders(html: string): Readonly<Record<string, string>> {
  const hashes = inlineScriptHashes(html)
  const scriptSrc = ["'self'", ...hashes.map((h) => `'${h}'`)].join(' ')
  return Object.freeze({
    ...SECURITY_HEADERS,
    'content-security-policy': SECURITY_HEADERS['content-security-policy']!.replace(
      "script-src 'self'",
      `script-src ${scriptSrc}`,
    ),
  })
}

/**
 * sha256 of each inline `<script>` body, base64, CSP-shaped.
 *
 * Only scripts with NO `src` attribute: an external one is governed by `'self'`
 * and hashing it would be meaningless. The regex is deliberately narrow, and it
 * runs over our own build output rather than user input.
 */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = []
  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = match[1] ?? ''
    if (body.trim() === '') continue
    hashes.push(`sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`)
  }
  return hashes
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; font-src 'self' data:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
})
