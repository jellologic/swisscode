// Application service: pure orchestration over the ports.
// resolveLaunchSpec() is the single choke point used by BOTH the CLI
// and the TanStack Start UI, so env resolution can never drift.

import type { LaunchSpec, Profile } from "./domain.js";
import { isDeniedEnvName } from "./envPolicy.js";
import type { AgentRegistry, ProviderRegistry } from "./ports.js";
import { profileShapeProblem } from "./shapes.js";
import type { ProviderAccount } from "./subscriptions.js";

export class ProfileError extends Error {}

/**
 * Words `swisscode <word>` already means. A profile named after one is
 * unreachable — the CLI dispatches the command and never sees the profile — so
 * the collision is rejected at save time instead of surfacing as "my profile
 * does nothing" later.
 */
export const RESERVED_PROFILE_NAMES: readonly string[] = [
  "list",
  "show",
  "accounts",
  "proxy",
  "help",
  "--help",
  "-h",
];

/**
 * Syntax shared by every stored record id — profile names, subscription and
 * provider account ids, the conversation/session ids that become URL segments.
 * They all end up as a path segment or a route match, so they all obey one
 * rule: alphanumeric first, then alphanumerics, "-" and "_". Stated once here
 * because a laxer copy anywhere is the copy an attacker gets to use.
 */
export const RECORD_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** True when `value` is a string safe to use as a stored record id. */
export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID_RE.test(value);
}

export function validateProfileName(name: string): void {
  // Reserved first: "--help" also fails the syntax rule, but "reserved" is the
  // reason the user needs to hear.
  const lowered = typeof name === "string" ? name.toLowerCase() : "";
  if (RESERVED_PROFILE_NAMES.includes(lowered)) {
    throw new ProfileError(
      `Profile name "${name}" is reserved by the CLI (${RESERVED_PROFILE_NAMES.join(", ")}). Pick another name.`,
    );
  }
  if (!isRecordId(name)) {
    throw new ProfileError(
      `Invalid profile name "${name}". Use letters, numbers, "-" or "_" and start with an alphanumeric.`,
    );
  }
}

export function validateProfile(profile: Profile): void {
  // Profiles arrive from imported bundles, hand-edited profiles.json and web
  // form payloads, where the type system has already stopped applying. Re-check
  // the shape before anything downstream spreads agentArgs into a command line
  // or reads providerConfig values as strings.
  const problem = profileShapeProblem(profile);
  if (problem !== undefined) throw new ProfileError(problem);
  validateProfileName(profile.name);
  if (!profile.agentId) throw new ProfileError("profile.agentId is required");
  if (!profile.providerId) throw new ProfileError("profile.providerId is required");
  // The profile alone decides proxy routing, so an unroutable claim must fail
  // loudly at save time — never silently ignored at launch.
  if (profile.useProxy === true && !profile.subscriptionAccountId) {
    throw new ProfileError(`Profile "${profile.name}" sets useProxy but has no subscriptionAccountId.`);
  }
}

/** Check required provider fields are present. Throws ProfileError. */
export function validateProviderConfig(
  providers: ProviderRegistry,
  profile: Profile,
): void {
  const provider = providers.get(profile.providerId);
  if (!provider) throw new ProfileError(`Unknown provider "${profile.providerId}"`);
  const missing = provider.fields
    .filter((f) => f.required)
    .filter((f) => !(profile.providerConfig?.[f.key] ?? "").trim())
    .map((f) => f.key);
  if (missing.length > 0) {
    throw new ProfileError(
      `Provider "${provider.id}" is missing required config: ${missing.join(", ")}`,
    );
  }
}

/**
 * Merge a stored generic account under the profile's inline providerConfig
 * (inline fields win). Returns a profile ready for resolveLaunchSpec.
 * Throws ProfileError when the reference is missing or belongs to another provider.
 */
export function resolveProviderConfig(
  profile: Profile,
  getAccount: (providerId: string, id: string) => ProviderAccount | undefined,
): Profile {
  if (!profile.providerAccountId) return profile;
  const account = getAccount(profile.providerId, profile.providerAccountId);
  if (!account) {
    throw new ProfileError(
      `Unknown ${profile.providerId} account "${profile.providerAccountId}"`,
    );
  }
  return {
    ...profile,
    providerConfig: { ...account.config, ...profile.providerConfig },
  };
}

/** Drop env names that decide how a process loads code (see envPolicy). */
function stripDeniedEnvNames(
  env: Record<string, string>,
  onDropped?: (name: string) => void,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (isDeniedEnvName(name)) {
      onDropped?.(name);
      continue;
    }
    safe[name] = value;
  }
  return safe;
}

export interface ResolveLaunchOptions {
  /**
   * Called once per env name dropped by the deny list. Exists so a shell can
   * TELL the operator their stored config was ignored; the drop itself is not
   * optional.
   */
  onDroppedEnv?: (name: string) => void;
}

/**
 * Merge agent + provider into a concrete launch spec.
 * Provider env wins over nothing (agent env starts from provider env);
 * agent adapter may add agent-specific vars (e.g. model) on top.
 */
export function resolveLaunchSpec(
  agents: AgentRegistry,
  providers: ProviderRegistry,
  profile: Profile,
  options: ResolveLaunchOptions = {},
): LaunchSpec {
  validateProfile(profile);
  const agent = agents.get(profile.agentId);
  if (!agent) throw new ProfileError(`Unknown agent "${profile.agentId}"`);
  const provider = providers.get(profile.providerId);
  if (!provider) throw new ProfileError(`Unknown provider "${profile.providerId}"`);
  validateProviderConfig(providers, profile);
  // Defence in depth: validateCustomProviderDef already refuses these names at
  // save time, but a hand-edited custom-providers.json never passes through the
  // validator, and PATH/NODE_OPTIONS/DYLD_* in a launch env is code execution
  // rather than configuration. Strip on both sides of buildLaunch so neither the
  // agent adapter nor the spawned process ever sees one.
  const providerEnv = stripDeniedEnvNames(
    provider.buildEnv(profile.providerConfig, profile),
    options.onDroppedEnv,
  );
  const spec = agent.buildLaunch(profile, providerEnv);
  return { ...spec, env: stripDeniedEnvNames(spec.env, options.onDroppedEnv) };
}
