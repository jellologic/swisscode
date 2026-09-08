// Env-name policy for user-supplied env vars (custom providers, profile config).
// Anything a user can name ends up in the spawned agent's environment, and a
// few names are not configuration at all — they are code execution: PATH picks
// the binary, NODE_OPTIONS/BASH_ENV/PYTHONSTARTUP inject startup code, LD_*/
// DYLD_* preload shared libraries. Those must never come from stored data.
//
// This module is deliberately inert: it states the policy, it does not enforce
// it. Wiring it into the validators/launch path is a separate change.

/** Exact names a user-supplied env mapping may never set. */
export const DENIED_ENV_NAMES = [
  "PATH",
  "HOME",
  "SHELL",
  "TMPDIR",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "PROMPT_COMMAND",
  "PERL5LIB",
  "RUBYOPT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
] as const;

/** Name prefixes that are denied wholesale (dynamic-linker preload families). */
export const DENIED_ENV_PREFIXES = ["LD_", "DYLD_"] as const;

const DENIED = new Set<string>(DENIED_ENV_NAMES);

/**
 * True when `name` is off limits for user-supplied env mappings.
 * Matching is case-insensitive so the list fails closed: POSIX env names are
 * case-sensitive, but a lower/mixed-case "Path" is never legitimate
 * configuration and some platforms treat it as the same variable.
 */
export function isDeniedEnvName(name: string): boolean {
  const upper = name.trim().toUpperCase();
  if (DENIED.has(upper)) return true;
  return DENIED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}
