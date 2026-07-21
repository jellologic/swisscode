// Port: the pieces of the host process the launcher touches.

/**
 * @typedef {Object} ProcessPort
 * @property {() => Record<string,string>} env
 * @property {() => string} cwd  may throw (deleted cwd); callers catch
 * @property {() => string} resolveBinary  throws with a human-readable message
 * @property {(bin:string, argv:string[], env:Record<string,string>) => never} replace
 *
 * NOTE on `replace`: it does not return. execve never returns on success, and
 * the spawn fallback hands off through an exit relay that ends in
 * process.exit / process.kill. Documented here rather than papered over with a
 * fake return type.
 */

export {}
