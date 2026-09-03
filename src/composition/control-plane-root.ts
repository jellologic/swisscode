// Composition root for a bare `swisscode` — the control plane.
//
// LAZY, reached only through a dynamic import from src/cli.ts, so the launch
// path's static closure never carries an HTTP server. That is the same
// treatment the config subcommands and the doctor already get, and
// test/architecture.test.ts is what holds it.
//
// This replaced the Ink wizard. The wizard could not express the object model
// the product now needs — it edited a flattened view and minted account, setup
// and profile one-to-one, so a profile drawing models from more than one
// account was not sayable in it. The web UI already has a screen per noun.

import { runWeb } from './web-root.ts'
import type { LaunchDeps } from './launch-root.ts'

export type RunControlPlaneOptions = {
  deps: LaunchDeps
  port?: number
  /** Print the URL instead of opening a browser. */
  noOpen?: boolean
  out?: (line: string) => void
}

/** @returns the process exit code */
export async function runControlPlane({
  deps,
  port = 0,
  noOpen = false,
  out = console.log,
}: RunControlPlaneOptions): Promise<number> {
  let server
  try {
    server = await runWeb({ deps, port, noOpen, out })
  } catch (e) {
    const message = (e as { message?: string }).message ?? 'could not start the control plane'
    console.error(`swisscode: ${message}`)
    return 2
  }

  // Resolve only when the server closes, so the command holds the terminal.
  // The control plane is a process the user starts on purpose and ends with
  // Ctrl-C; a launch still leaves nothing running.
  await new Promise<void>((resolve) => {
    const stop = () => {
      void server.close().then(resolve)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}
