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

export type ProcessPort = {
  /** A COPY of the ambient environment. Mutating it must not affect the host. */
  env: () => EnvMap
  /** may throw (deleted cwd); callers catch — see launch-root.js `safeCwd` */
  cwd: () => string
  /** throws with a human-readable message when `claude` cannot be found */
  resolveBinary: () => string

  /**
   * Hand off to the agent binary.
   *
   * RETURNS `void`, NOT `never` — and this is the one place where the JSDoc
   * contract this type replaces was WRONG about the code. The old annotation
   * read `=> never` with a note that "it does not return".
   *
   * That is true of the PRIMARY path and false of the FALLBACK path:
   *
   *   execve  really never returns on success; the process image is replaced.
   *   spawn   returns to its caller. It registers an exit relay and leaves the
   *           parent alive until the child exits, at which point a handler
   *           calls process.exit / process.kill. Every Node 22 user takes this
   *           path, because execve needs 23.11+.
   *
   * So `replace()` genuinely returns control in the fallback, and callers rely
   * on it: launch-root.js `main()` executes `return planned` on the line after,
   * and src/cli.js reads that return value. Typing this `never` would mark that
   * code unreachable and change what compiles — a types-only slice must not do
   * that. Reported rather than "fixed": the runtime behaviour is correct and
   * deliberate, only the annotation was stale.
   */
  replace: (bin: string, argv: string[], env: EnvMap) => void
}

export {}
