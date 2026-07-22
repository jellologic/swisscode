// Composition root for `swisscode config web`.
//
// LAZY, like the UI bundle, the config subcommands and the doctor: reached only
// through a dynamic import, so the launch path's static closure never grows to
// carry an HTTP server. test/architecture.test.ts bans node:http there by name.
//
// This is also the SINGLETON. The port bind is the mutex — there is no lockfile
// and no stale-PID reasoning, because the OS already refuses to bind a port
// twice and cleans up when the process dies. A lockfile would have to
// reimplement that badly.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { startWebServer, type RunningServer } from '../adapters/web/server.ts'
import type { LaunchDeps } from './launch-root.ts'

export type RunWebOptions = {
  deps: LaunchDeps
  port?: number
  /** print the URL rather than opening a browser */
  noOpen?: boolean
  out?: (line: string) => void
}

/**
 * Where the built SPA lives, or null when it has not been built.
 *
 * Resolved relative to THIS module's own location rather than process.cwd(),
 * because `swisscode` is run from the user's project directory and the assets
 * live next to the compiled code in the installed package.
 */
export function assetDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  // dist/composition/web-root.js -> dist/web
  const candidate = join(here, '..', 'web')
  return existsSync(join(candidate, 'index.html')) ? candidate : null
}

export async function runWeb({
  deps,
  port = 0,
  noOpen = false,
  out = console.log,
}: RunWebOptions): Promise<RunningServer> {
  let server: RunningServer
  try {
    server = await startWebServer({
      store: deps.store,
      providers: deps.registry,
      agents: deps.agents,
      // Resolved through the SAME ProcessPort the launcher uses, so "installed"
      // in the UI means exactly what it means at launch — including the
      // SWISSCODE_*_BIN overrides and the self-alias guard. A second
      // implementation here could disagree with the thing it describes.
      installed: () =>
        deps.agents.all().map((agent) => {
          try {
            return {
              id: agent.id,
              label: agent.label,
              installed: true,
              path: deps.proc.resolveBinary(agent.binary),
              error: null,
            }
          } catch (err) {
            return {
              id: agent.id,
              label: agent.label,
              installed: false,
              path: null,
              error: (err as { message?: string }).message ?? null,
            }
          }
        }),
      port,
      assetDir: assetDir(),
    })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'EADDRINUSE') {
      // The singleton speaking. A second instance is not an error condition to
      // recover from — it means the thing the user asked for is already
      // running, and the useful response is to say where.
      throw new Error(
        `port ${port} is already in use — swisscode's web UI may already be running there. ` +
          'Open it, or start this one on a different port with `--port <n>`.',
      )
    }
    throw err
  }

  out(`swisscode: web UI on ${server.url}`)
  out('  the URL carries no token; the page fetches its own. Close with Ctrl-C.')
  if (!assetDir()) {
    out('  note: no UI bundle found — serving the fallback page. Run `npm run build`.')
  }
  if (!noOpen) {
    // Opening a browser is a side effect on the user's desktop, so it is
    // announced above rather than done silently, and `--no-open` exists.
    out('')
  }
  return server
}
