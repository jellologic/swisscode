// Port: the pieces of the host process the launcher touches.

/**
 * The child environment handed to execve/spawn, and the ambient one read back
 * from the host.
 *
 * Values are `string`, not `string | undefined`: '' is a meaningful value on
 * the way OUT (it is how core/env.ts says "unset this"), and on the way IN a
 * variable that is not set is simply absent from the map. Callers still get
 * `string | undefined` on every read because `noUncheckedIndexedAccess` is on,
 * so the undefined case is handled at the read site where it belongs rather
 * than smeared across the type.
 */
export type EnvMap = Record<string, string>

/**
 * How to find one agent CLI's binary. DECLARATIVE data an `AgentCliPort`
 * carries; the process adapter (which owns node:fs) turns it into a path via
 * `resolveBinary` and applies the shared self-alias guard. Keeping this here
 * rather than in ports/agent.ts avoids a type cycle (agent.ts imports it).
 */
export type AgentBinarySpec = {
  /** binary name to look for on PATH, e.g. 'claude', 'kilo', 'opencode' */
  name: string
  /** env var that force-points at a specific binary, e.g. 'SWISSCODE_CLAUDE_BIN' */
  overrideEnv: string
  /** absolute paths to try when PATH misses, given the user's home directory */
  fallbacks: (home: string) => string[]
}

export type ProcessPort = {
  /** A COPY of the ambient environment. Mutating it must not affect the host. */
  env: () => EnvMap
  /** may throw (deleted cwd); callers catch — see launch-root.js `safeCwd` */
  cwd: () => string
  /** throws with a human-readable message when the agent binary cannot be found */
  resolveBinary: (spec: AgentBinarySpec) => string

  /**
   * Hand off to the agent binary.
   *
   * RETURNS `void`, NOT `never`. The PRIMARY path (execve) never returns on
   * success; the FALLBACK (spawn) does — it registers an exit relay and leaves
   * the parent alive until the child exits. Every Node 22 user takes the spawn
   * path (execve needs 23.11+). Callers rely on that return: launch-root
   * `main()` executes `return planned` on the next line, and cli reads it.
   */
  replace: (bin: string, argv: string[], env: EnvMap) => void
}

export {}
