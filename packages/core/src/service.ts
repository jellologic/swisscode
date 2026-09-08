// Application service: pure orchestration over the ports.
// resolveLaunchSpec() is the single choke point used by BOTH the CLI
// and the TanStack Start UI, so env resolution can never drift.

import type { LaunchSpec, Profile } from "./domain.js";
import type { AgentRegistry, ProviderRegistry } from "./ports.js";
import type { ProviderAccount } from "./subscriptions.js";

export class ProfileError extends Error {}

export function validateProfileName(name: string): void {
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/.test(name)) {
    throw new ProfileError(
      `Invalid profile name "${name}". Use letters, numbers, "-" or "_" and start with an alphanumeric.`,
    );
  }
}

export function validateProfile(profile: Profile): void {
  validateProfileName(profile.name);
  if (!profile.agentId) throw new ProfileError("profile.agentId is required");
  if (!profile.providerId) throw new ProfileError("profile.providerId is required");
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
  const providerEnv = provider.buildEnv(profile.providerConfig, profile);
  return agent.buildLaunch(profile, providerEnv);
}
