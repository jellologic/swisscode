// Application service: pure orchestration over the ports.
// resolveLaunchSpec() is the single choke point used by BOTH the CLI
// and the TanStack Start UI, so env resolution can never drift.

import type { LaunchSpec, Profile } from "./domain.js";
import { isDeniedEnvName } from "./envPolicy.js";
import type { AgentRegistry, ProviderRegistry } from "./ports.js";
import { isProfileShape } from "./shapes.js";
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

const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-_]*$/;

export function validateProfileName(name: string): void {
  // Reserved first: "--help" also fails the syntax rule, but "reserved" is the
  // reason the user needs to hear.
  const lowered = typeof name === "string" ? name.toLowerCase() : "";
  if (RESERVED_PROFILE_NAMES.includes(lowered)) {
    throw new ProfileError(
      `Profile name "${name}" is reserved by the CLI (${RESERVED_PROFILE_NAMES.join(", ")}). Pick another name.`,
    );
  }
  if (typeof name !== "string" || !PROFILE_NAME_RE.test(name)) {
    throw new ProfileError(
      `Invalid profile name "${name}". Use letters, numbers, "-" or "_" and start with an alphanumeric.`,
    );
  }
}

/**
 * Explain an isProfileShape rejection. Diagnosis only — the guard stays the
 * single source of truth for accept/reject; this just names the bad field so
 * an import error or a form message is actionable.
 */
function profileShapeProblem(profile: unknown): string {
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) {
    return "Profile must be an object.";
  }
  const rec = profile as Record<string, unknown>;
  const optionalString = (v: unknown): boolean => v === undefined || typeof v === "string";
  for (const key of ["name", "agentId", "providerId"] as const) {
    if (typeof rec[key] !== "string") return `profile.${key} must be a string.`;
  }
  const args = rec["agentArgs"];
  if (args !== undefined && !(Array.isArray(args) && args.every((a) => typeof a === "string"))) {
    return "profile.agentArgs must be an array of strings.";
  }
  const config = rec["providerConfig"];
  if (
    config !== undefined &&
    !(
      typeof config === "object" &&
      config !== null &&
      !Array.isArray(config) &&
      Object.values(config).every((v) => typeof v === "string")
    )
  ) {
    return "profile.providerConfig must be an object of string values.";
  }
  if (!optionalString(rec["model"])) return "profile.model must be a string.";
  const useProxy = rec["useProxy"];
  if (useProxy !== undefined && typeof useProxy !== "boolean") {
    return "profile.useProxy must be true or false.";
  }
  for (const key of ["subscriptionAccountId", "providerAccountId"] as const) {
    if (!optionalString(rec[key])) return `profile.${key} must be a string.`;
  }
  return "Profile has an unexpected shape.";
}

export function validateProfile(profile: Profile): void {
  // Profiles arrive from imported bundles, hand-edited profiles.json and web
  // form payloads, where the type system has already stopped applying. Re-check
  // the shape before anything downstream spreads agentArgs into a command line
  // or reads providerConfig values as strings.
  if (!isProfileShape(profile)) throw new ProfileError(profileShapeProblem(profile));
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
function stripDeniedEnvNames(env: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isDeniedEnvName(name)) safe[name] = value;
  }
  return safe;
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
  const providerEnv = stripDeniedEnvNames(provider.buildEnv(profile.providerConfig, profile));
  const spec = agent.buildLaunch(profile, providerEnv);
  return { ...spec, env: stripDeniedEnvNames(spec.env) };
}
