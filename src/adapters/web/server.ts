// node:http glue for the web UI. The ONLY module here that knows about sockets;
// routing decisions live in api.ts and the gate lives in security.ts, both pure.
//
// Off the launch path by construction: test/architecture.test.ts bans node:http
// there by name, so this is reached only through a dynamic import from
// src/cli.ts — the same treatment the wizard, the config subcommands and the
// doctor already get.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { handleApi, type ApiDeps } from './api.ts'
import {
  SECURITY_HEADERS,
  TOKEN_HEADER,
  guardApiRequest,
  guardDocumentRequest,
} from './security.ts'

/**
 * A request body cannot be unbounded. Nothing this API accepts is remotely this
 * large — it is a denial-of-service bound, not a schema limit, so it is
 * deliberately generous rather than tuned.
 */
const MAX_BODY_BYTES = 256 * 1024

const MIME: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
})

export type WebServerOptions = ApiDeps & {
  /** 0 lets the OS choose, which is the default: a fixed port is squattable. */
  port?: number
  /** absolute path to the built SPA. When absent, a fallback page is served. */
  assetDir?: string | null
}

export type RunningServer = {
  url: string
  port: number
  token: string
  close: () => Promise<void>
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        rejectBody(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolveBody(null)
      try {
        resolveBody(JSON.parse(raw))
      } catch {
        rejectBody(new Error('body is not valid JSON'))
      }
    })
    req.on('error', rejectBody)
  })
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  const payload = type.startsWith('application/json') ? JSON.stringify(body) : String(body)
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': type,
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Resolve a URL path to a file inside `root`, or null.
 *
 * The `startsWith(root + sep)` check is the path-traversal defence and it runs
 * on the RESOLVED path, after normalize, because `..` segments and encoded
 * variants only collapse once resolved. Serving files is the one place this
 * server touches the filesystem on a client's say-so, so it gets the check even
 * though the asset directory holds nothing secret — the directory above it does.
 */
export function resolveAsset(root: string, urlPath: string): string | null {
  const relative = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, '')
  const target = resolve(root, relative)
  const rootResolved = resolve(root)
  if (target !== rootResolved && !target.startsWith(rootResolved + sep)) return null
  return existsSync(target) ? target : null
}

/** Where the fallback page's script is served from. See `fallbackDocument`. */
export const FALLBACK_SCRIPT_PATH = '/__swisscode/fallback.js'

/**
 * The fallback page's script, as a SEPARATE RESOURCE rather than an inline
 * <script>.
 *
 * This is not a style preference. Our own CSP is `script-src 'self'` with no
 * 'unsafe-inline' — so an inline script on our own page is blocked by our own
 * header, and the page silently sits at "loading" forever. It did exactly that.
 *
 * The fix is to serve the script, not to loosen the policy: the CSP is right
 * and the page was wrong. Externalising also matches where the real SPA lands
 * (a bundled file, trivially 'self'), so nothing here needs a nonce.
 */
const FALLBACK_SCRIPT = `
const out = document.getElementById('out')
try {
  const token = document.querySelector('meta[name=swisscode-token]').content
  const res = await fetch('/api/bootstrap', { headers: { '${TOKEN_HEADER}': token } })
  if (!res.ok) throw new Error('API returned HTTP ' + res.status)
  const data = await res.json()
  const profiles = Object.keys(data.state?.profiles ?? {})
  out.textContent =
    'config    ' + data.configPath
    + '\\nprofiles  ' + (profiles.length ? profiles.join(', ') : '(none yet)')
    + '\\nproviders ' + (data.providers ?? []).map(p => p.id).join(', ')
    + '\\nagents    ' + (data.agents ?? []).map(a => a.id).join(', ')
} catch (err) {
  out.textContent = 'could not reach the API: ' + err.message
}
`

/**
 * The page served when no SPA bundle has been built.
 *
 * Not a stub for its own sake: it makes the whole server verifiable end to end —
 * security gate, token handoff, live API — before any framework is involved, and
 * it is what a user gets if `dist/web` is missing rather than a blank 404.
 */
function fallbackDocument(token: string): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>swisscode</title>
<meta name="swisscode-token" content="${token}">
<style>
  :root { color-scheme: dark }
  body { background:#0c0d10; color:#e6e7ea; font:14px/1.6 ui-sans-serif,system-ui,sans-serif;
         margin:0; display:grid; place-items:center; min-height:100vh }
  main { max-width:36rem; padding:2rem }
  h1 { font-size:1.1rem; font-weight:600; letter-spacing:-0.01em; margin:0 0 .75rem }
  p { color:#9ba1ac; margin:0 0 1rem }
  code { background:#16181d; border:1px solid #24272e; border-radius:4px; padding:.15rem .4rem }
  pre { background:#16181d; border:1px solid #24272e; border-radius:6px; padding:1rem;
        overflow:auto; color:#9ba1ac; white-space:pre-wrap }
</style>
<main>
  <h1>swisscode is serving, but the UI bundle is not built</h1>
  <p>The API is live and this page is proof the security handshake works.
     The interface itself has not been built yet.</p>
  <pre id="out">loading /api/bootstrap…</pre>
</main>
<script type="module" src="${FALLBACK_SCRIPT_PATH}"></script>`
}

export function startWebServer(options: WebServerOptions): Promise<RunningServer> {
  const { port = 0, assetDir = null, ...deps } = options
  // 32 bytes of CSPRNG. Not a password — nobody types it — so there is no reason
  // for it to be short.
  const token = randomBytes(32).toString('hex')

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal error' })
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bound = (server.address() as { port: number } | null)?.port ?? port
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const headers = {
      host: req.headers.host,
      origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
      token: req.headers[TOKEN_HEADER] as string | undefined,
    }

    if (url.pathname.startsWith('/api/')) {
      const verdict = guardApiRequest(headers, { token, port: bound })
      if (!verdict.ok) return send(res, verdict.status, { error: verdict.reason })

      let body: unknown = null
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        try {
          body = await readBody(req)
        } catch (err) {
          return send(res, 400, { error: (err as Error).message })
        }
      }
      const result = handleApi({ method: req.method ?? 'GET', path: url.pathname, body }, deps)
      return send(res, result.status, result.body)
    }

    const docVerdict = guardDocumentRequest(headers, { port: bound })
    if (!docVerdict.ok) return send(res, docVerdict.status, { error: docVerdict.reason }, 'text/plain')

    // The fallback page's script. Served rather than inlined so it satisfies
    // our own `script-src 'self'` — see FALLBACK_SCRIPT.
    if (url.pathname === FALLBACK_SCRIPT_PATH) {
      return send(res, 200, FALLBACK_SCRIPT, 'text/javascript; charset=utf-8')
    }

    // Static assets, when a bundle exists.
    if (assetDir && url.pathname !== '/') {
      const file = resolveAsset(assetDir, url.pathname)
      if (file) {
        const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
        return send(res, 200, readFileSync(file, 'utf8'), type)
      }
    }

    // The document. Token injected here rather than set as a cookie — see
    // security.ts for why that is the CSRF defence and not merely a style.
    const indexPath = assetDir ? join(assetDir, 'index.html') : null
    const html =
      indexPath && existsSync(indexPath)
        ? readFileSync(indexPath, 'utf8').replace('__SWISSCODE_TOKEN__', token)
        : fallbackDocument(token)
    return send(res, 200, html, 'text/html; charset=utf-8')
  }

  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer)
    // 127.0.0.1 EXPLICITLY, never 0.0.0.0. On a shared machine the difference is
    // whether every other user on the box can read this config.
    server.listen(port, '127.0.0.1', () => {
      const bound = (server.address() as { port: number }).port
      resolveServer({
        url: `http://127.0.0.1:${bound}/`,
        port: bound,
        token,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
          }),
      })
    })
  })
}
