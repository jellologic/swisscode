// node:http glue for the gateway. The ONLY module here that knows about
// sockets; the routing table, the retry policy and the token estimate are all
// pure and live beside it.
//
// Off the launch path by construction: test/architecture.test.ts bans node:http
// there by name, so this is reached only through a dynamic import — the same
// treatment the web UI, the wizard and the doctor already get. The launcher
// still leaves nothing running; this is a process the user starts on purpose.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { DEFAULT_POLICY, isRetryable, isTerminalRateLimit, retryDelay, summarize } from './dispatch.ts'
import type { RetryPolicy } from './dispatch.ts'
import { modelFor, tierOf, type Route } from './table.ts'
import { estimateRequestTokens } from './tokens.ts'

/**
 * Hop-by-hop headers, plus the ones the upstream fetch recomputes. Forwarding
 * any of these produces a request that describes a connection that no longer
 * exists.
 */
const STRIP = new Set([
  'host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive',
  'upgrade', 'expect', 'proxy-authorization', 'proxy-connection',
])

export type GatewayUsage = {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export type GatewayServerOptions = {
  routes: Route[]
  port?: number
  policy?: RetryPolicy
  out: (line: string) => void
  /** Injected so tests do not have to spend real seconds on backoff. */
  sleep?: (ms: number) => Promise<void>
}

export type RunningGateway = {
  url: string
  port: number
  usage: Map<string, GatewayUsage>
  close: () => Promise<void>
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function startGateway(options: GatewayServerOptions): Promise<RunningGateway> {
  const { routes, out, policy = DEFAULT_POLICY, sleep = wait } = options
  const port = options.port ?? 8787
  const usage = new Map<string, GatewayUsage>()

  const primary = routes[0]
  if (!primary) return Promise.reject(new Error('the gateway needs at least one route.'))

  // An arrow bound after the guard rather than a hoisted declaration: a
  // function declaration is analysed before `primary` is narrowed, and would
  // force a non-null assertion on every use.
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = req.url ?? '/'

    if (path === '/health') {
      return respondJson(res, 200, { ok: true, routes: routes.map((r) => r.profile) })
    }
    if (path === '/usage') {
      return respondJson(res, 200, Object.fromEntries(usage))
    }

    // Buffered once: the model decides the route, and every failover attempt
    // replays these exact bytes. Byte-exact replay is not an optimisation —
    // Anthropic signs `thinking` blocks against the serialization it received,
    // so re-encoding a body invalidates them.
    const body = await readBody(req)
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = JSON.parse(body.toString('utf8') || '{}') as Record<string, unknown>
    } catch {
      // Not JSON. Forwarded as-is to the primary route.
    }
    const requested = typeof parsed?.model === 'string' ? parsed.model : undefined
    const tier = tierOf(primary, requested)

    if (path.startsWith('/v1/messages/count_tokens')) {
      const tokens = estimateRequestTokens(parsed)
      out(`${(requested ?? '-').padEnd(28)} → local      200 0ms  ${path}`)
      out(`${' '.repeat(31)}└─ estimated ${tokens} input tokens`)
      return respondJson(res, 200, { input_tokens: tokens })
    }

    let last: { status: number; body: string } | undefined

    for (const [index, route] of routes.entries()) {
      const model = modelFor(route, tier, requested)
      const outcome = await attempt({ route, model, req, path, body, parsed, res, policy, sleep, out, usage })

      if (outcome.kind === 'sent') return
      last = outcome.error
      if (index < routes.length - 1) {
        out(`${' '.repeat(31)}└─ failing over to ${routes[index + 1]?.profile}`)
      }
    }

    if (last) return respondRaw(res, last.status, last.body)
    respondError(res, 502, 'api_error', 'every route failed.')
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      respondError(res, 502, 'api_error', String(e))
    })
  })

  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer)
    // 127.0.0.1 explicitly, never 0.0.0.0: this process holds credentials for
    // every route in the table, and nothing about it should be reachable from
    // the network.
    server.listen(port, '127.0.0.1', () => {
      const bound = (server.address() as { port: number }).port
      resolveServer({
        url: `http://127.0.0.1:${bound}`,
        port: bound,
        usage,
        close: () => new Promise((done) => { server.close(() => done()) }),
      })
    })
  })
}

type Attempt =
  | { kind: 'sent' }
  | { kind: 'failed'; error: { status: number; body: string } }

async function attempt(ctx: {
  route: Route
  model: string | undefined
  req: IncomingMessage
  path: string
  body: Buffer
  parsed: Record<string, unknown> | undefined
  res: ServerResponse
  policy: RetryPolicy
  sleep: (ms: number) => Promise<void>
  out: (line: string) => void
  usage: Map<string, GatewayUsage>
}): Promise<Attempt> {
  const { route, model, req, path, res, policy, sleep, out, usage } = ctx

  // Re-serialize only when the model actually changes. On the common path the
  // original bytes go out untouched, which is what keeps signed thinking
  // blocks valid.
  let payload = ctx.body
  if (model && ctx.parsed && model !== ctx.parsed.model) {
    payload = Buffer.from(JSON.stringify({ ...ctx.parsed, model }))
  }

  let last: { status: number; body: string } | undefined

  for (let n = 0; n < policy.attempts; n++) {
    const upstream = new AbortController()
    // A client that hangs up should not leave the provider generating tokens
    // nobody will read.
    const abort = () => upstream.abort()
    req.once('aborted', abort)
    req.once('close', abort)

    const started = Date.now()
    let response: Response
    try {
      response = await fetch(route.baseUrl + path, {
        method: req.method ?? 'POST',
        headers: upstreamHeaders(req, route),
        ...(payload.length > 0 ? { body: new Uint8Array(payload) } : {}),
        signal: upstream.signal,
      })
    } catch (e) {
      req.off('aborted', abort)
      req.off('close', abort)
      if (upstream.signal.aborted) return { kind: 'sent' } // client left; nothing to send
      out(`${(model ?? '-').padEnd(28)} → ${route.profile.padEnd(10)} ERR ${Date.now() - started}ms  ${path}`)
      out(`${' '.repeat(31)}└─ ${String(e)}`)
      last = { status: 502, body: errorBody('api_error', `${route.profile} unreachable: ${String(e)}`) }
      if (n < policy.attempts - 1) await sleep(retryDelay(n, null, policy))
      continue
    }

    const ms = Date.now() - started
    out(`${(model ?? '-').padEnd(28)} → ${route.profile.padEnd(10)} ${String(response.status).padStart(3)} ${ms}ms  ${path}`)

    if (response.ok) {
      await pipe(response, res, route, usage)
      req.off('aborted', abort)
      req.off('close', abort)
      return { kind: 'sent' }
    }

    const text = await response.text()
    req.off('aborted', abort)
    req.off('close', abort)
    out(`${' '.repeat(31)}└─ ${summarize(text)}`)
    last = { status: response.status, body: text }

    if (!isRetryable(response.status)) return { kind: 'failed', error: last }
    // A spend cap and a rate limit share a status code; only one of them clears
    // on its own. Retrying the other just delays the failover.
    if (response.status === 429 && isTerminalRateLimit(text)) {
      out(`${' '.repeat(31)}└─ not retrying: reads as a balance or quota problem`)
      return { kind: 'failed', error: last }
    }
    if (n < policy.attempts - 1) {
      const delay = retryDelay(n, response.headers.get('retry-after'), policy)
      out(`${' '.repeat(31)}└─ retrying in ${Math.round(delay)}ms (${n + 2}/${policy.attempts})`)
      await sleep(delay)
    }
  }

  return { kind: 'failed', error: last ?? { status: 502, body: errorBody('api_error', 'no response.') } }
}

/**
 * Build the upstream headers.
 *
 * A route with no credential is in session mode: the caller holds the login and
 * its header is forwarded untouched. Otherwise both credential headers are
 * cleared before the route's own is written — a credential for one provider
 * must never leave with a request bound for another, which is the same rule the
 * launcher enforces at the account level.
 */
function upstreamHeaders(req: IncomingMessage, route: Route): Headers {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (STRIP.has(key.toLowerCase())) continue
    if (typeof value === 'string') headers.set(key, value)
    else if (Array.isArray(value)) headers.set(key, value.join(', '))
  }
  // fetch decompresses transparently, which leaves a stale content-encoding on
  // a body that is already plain; an explicit identity avoids the whole class.
  headers.set('accept-encoding', 'identity')

  if (route.credential) {
    headers.delete('authorization')
    headers.delete('x-api-key')
    if (route.header === 'x-api-key') headers.set('x-api-key', route.credential)
    else headers.set('authorization', `Bearer ${route.credential}`)
  }
  return headers
}

/** Forward a successful response, counting tokens without altering the bytes. */
async function pipe(
  response: Response,
  res: ServerResponse,
  route: Route,
  usage: Map<string, GatewayUsage>,
): Promise<void> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    if (key === 'content-encoding' || key === 'content-length') return
    headers[key] = value
  })
  res.writeHead(response.status, headers)

  if (!response.body) return void res.end()

  const isStream = (response.headers.get('content-type') ?? '').includes('text/event-stream')
  if (!isStream) {
    const text = await response.text()
    record(usage, route.profile, text)
    return void res.end(text)
  }

  // Streamed: forward chunks as they arrive and read usage off them in
  // passing. Buffering here would defeat streaming, and rewriting the frames
  // would risk dropping the `ping` events a client uses to tell a slow
  // response from a dead one.
  let tail = ''
  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
  for await (const chunk of source) {
    const buf = chunk as Buffer
    res.write(buf)
    tail = (tail + buf.toString('utf8')).slice(-4096)
  }
  record(usage, route.profile, tail)
  res.end()
}

/** Pull whatever usage numbers are present, best-effort. */
function record(usage: Map<string, GatewayUsage>, profile: string, text: string): void {
  const totals = usage.get(profile) ?? {
    requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
  }
  totals.requests += 1
  for (const match of text.matchAll(/"usage"\s*:\s*(\{[^}]*\})/g)) {
    try {
      const u = JSON.parse(match[1] ?? '{}') as Record<string, number>
      if (typeof u.input_tokens === 'number') totals.inputTokens += u.input_tokens
      if (typeof u.output_tokens === 'number') totals.outputTokens += u.output_tokens
      if (typeof u.cache_read_input_tokens === 'number') totals.cacheReadTokens += u.cache_read_input_tokens
    } catch {
      // Usage accounting must never break a response that is already flowing.
    }
  }
  usage.set(profile, totals)
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', rejectBody)
  })
}

function errorBody(type: string, message: string): string {
  return JSON.stringify({ type: 'error', error: { type, message } })
}

function respondJson(res: ServerResponse, status: number, value: unknown): void {
  respondRaw(res, status, JSON.stringify(value))
}

function respondError(res: ServerResponse, status: number, type: string, message: string): void {
  respondRaw(res, status, errorBody(type, message))
}

function respondRaw(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(body)
}
