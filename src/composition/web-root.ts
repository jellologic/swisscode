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
import { spawn } from 'node:child_process'
import { startWebServer, type RunningServer } from '../adapters/web/server.ts'
import { createCatalogRegistry } from '../adapters/catalog/registry.ts'
import { createFsCacheStore } from '../adapters/store/fs-cache-store.ts'
import { fetchNet } from '../adapters/net/fetch-net.ts'
import { systemClock } from '../adapters/clock/system-clock.ts'
import { configDir } from '../adapters/store/fs-config-store.ts'
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
      // Same catalogs the Ink picker uses, so the browser and the terminal
      // browse an identical list from an identical 24h cache.
      catalogs: createCatalogRegistry({
        net: fetchNet,
        cache: createFsCacheStore({ dir: configDir(), clock: systemClock }),
        clock: systemClock,
      }),
      // The doctor is imported LAZILY: it reaches the network and pulls in the
      // probe, and a user who only edits a profile should not load it at all.
      doctor: async ({ offline }) => {
        const { runDoctor } = await import('./doctor-root.ts')
        const run = await runDoctor({ deps, offline })
        return run.report
      },
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
  if (!noOpen) openBrowser(server.url, out)
  return server
}

/**
 * Open the default browser, best effort.
 *
 * BEST EFFORT IS THE CONTRACT, not a shortcut. This is a side effect on someone
 * else's desktop, over which swisscode has no authority: there may be no
 * browser, no display, no session (ssh, a container, CI). Every one of those is
 * a normal state, and none of them is a reason to fail a command whose actual
 * job — serving on a URL that was already printed — has succeeded.
 *
 * So it is detached and unref'd (the child must not hold the process open or
 * inherit the terminal), errors are swallowed to a single line, and the URL is
 * printed FIRST so the flow works identically whether or not this does anything.
 */
function openBrowser(url: string, out: (line: string) => void): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    const child = spawn(command, [url], {
      stdio: 'ignore',
      detached: true,
      // `start` is a cmd builtin rather than an executable.
      ...(process.platform === 'win32' ? { shell: true } : {}),
    })
    // Failure arrives asynchronously (ENOENT on a box with no xdg-open), so it
    // needs a handler or it becomes an unhandled 'error' event and kills us.
    child.on('error', () => out('  (could not open a browser — copy the URL above)'))
    child.unref()
  } catch {
    out('  (could not open a browser — copy the URL above)')
  }
}
