// Display redaction for resolved launch environments.
// Two independent signals, because either one alone leaks: the NAME pattern
// misses a custom provider mapping a secret to MY_PASSWORD, and value matching
// misses a secret we were never told about. Live here (not in adapters) so the
// CLI dry-run and the web preview mask identically.

/** Env names whose value is assumed secret regardless of where it came from. */
export const DEFAULT_SECRET_NAME_RE = /TOKEN|KEY|SECRET|PASS|CRED|AUTH/i;

/**
 * The proxy's profile tag (`swisscode-profile/<name>`) rides in
 * ANTHROPIC_AUTH_TOKEN but is a public routing label, never a credential —
 * masking it would hide the one field that explains a proxied launch.
 */
const PROFILE_TAG_PREFIX = "swisscode-profile/";

/**
 * Mask a secret for display: first 4 + … + last 2.
 * Mirrors the adapters-side `maskSecret`; core cannot import adapters, so the
 * rule is stated once here and the two must stay byte-identical.
 */
export function maskSecretValue(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}

export interface RedactEnvOptions {
  /** Override the name-based signal. Default: {@link DEFAULT_SECRET_NAME_RE}. */
  nameRegex?: RegExp;
}

/**
 * Copy `env` with secret values masked. A value is masked when it equals one of
 * `secretValues` (non-empty ones only — "" would match every unset var) or when
 * its NAME matches `nameRegex`. Profile tags are never masked.
 */
export function redactEnv(
  env: Record<string, string>,
  secretValues: Iterable<string>,
  opts: RedactEnvOptions = {},
): Record<string, string> {
  const secrets = new Set<string>();
  for (const value of secretValues) {
    if (value) secrets.add(value);
  }
  const nameRegex = stateless(opts.nameRegex ?? DEFAULT_SECRET_NAME_RE);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    out[name] = isSecret(name, value, secrets, nameRegex) ? maskSecretValue(value) : value;
  }
  return out;
}

function isSecret(
  name: string,
  value: string,
  secrets: ReadonlySet<string>,
  nameRegex: RegExp,
): boolean {
  if (!value) return false;
  if (value.startsWith(PROFILE_TAG_PREFIX)) return false;
  if (secrets.has(value)) return true;
  return nameRegex.test(name);
}

/**
 * A caller-supplied /g or /y regex carries `lastIndex` between `test()` calls,
 * which would mask every other variable. Strip those flags before use.
 */
function stateless(re: RegExp): RegExp {
  if (!re.global && !re.sticky) return re;
  return new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
}
