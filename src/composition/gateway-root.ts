// Composition root for `swisscode config proxy`.
//
// LAZY, like the web UI, the wizard and the doctor: reached only through a
// dynamic import, so the launch path's static closure never grows to carry an
// HTTP server. test/architecture.test.ts bans node:http there by name, and the
// launch path is at its module ceiling besides.
//
// The gateway is the one thing swisscode runs that outlives a command, and it
// is deliberately foreground-only. A daemon would need a PID file, and a PID
// file has to reimplement — badly — what the OS already does when a process
// dies. The port bind is the mutex, exactly as it is for `config web`.

import { buildTable, type Route } from '../adapters/gateway/table.ts'
import { startGateway, type RunningGateway } from '../adapters/gateway/server.ts'
import { withCustomProviders } from '../adapters/providers/composite.ts'
import type { LaunchDeps } from './launch-root.ts'

export type RunProxyOptions = {
  deps: LaunchDeps
  /** Primary first, then fallbacks in order. */
  profiles: string[]
  port?: number
  out: (line: string) => void
}

export type ProxyResult =
  | { ok: true; server: RunningGateway; routes: Route[] }
  | { ok: false; reason: string }

export async function runProxy({
  deps,
  profiles,
  port,
  out,
}: RunProxyOptions): Promise<ProxyResult> {
  const { state } = deps.store.load()
  const registry = withCustomProviders(deps.registry, state)

  // Default to the profile a bare launch would have used, so the gateway and
  // the launcher agree about "my current setup" without the user restating it.
  const names = profiles.length > 0 ? profiles : state.defaultProfile ? [state.defaultProfile] : []
  if (names.length === 0) {
    return { ok: false, reason: 'no profile given and no default profile set.' }
  }

  const table = buildTable(state, registry, names, deps.proc.env())
  if (!table.ok) return { ok: false, reason: table.reason }

  const server = await startGateway({
    routes: table.routes,
    ...(port === undefined ? {} : { port }),
    out,
  })

  return { ok: true, server, routes: table.routes }
}

/** One line per route, for the banner. Credentials are never printed. */
export function describeRoutes(routes: Route[]): string[] {
  return routes.map((route, index) => {
    const role = index === 0 ? 'primary ' : 'fallback'
    // Says whose credential travels, which is the part worth being unambiguous
    // about: the account's own, or the one the caller arrived with.
    const auth = route.credential ? "the account's key" : 'your own login'
    return `  ${role}  ${route.profile.padEnd(16)} ${route.provider.padEnd(12)} ${route.baseUrl}  (sends ${auth})`
  })
}
