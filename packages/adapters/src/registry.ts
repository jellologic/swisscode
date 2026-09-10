// Default registries: the full plugin set for v1.
// Adding a new agent/provider = add one adapter file + one line here.

import type {
  AgentPort,
  AgentRegistry,
  ProviderPort,
  ProviderRegistry,
  TrafficParser,
} from "@swisscode/core";
import { ProfileError } from "@swisscode/core";
import { claudeCodeAgent } from "./agents/claudeCode.js";
import { claudeSubscriptionProvider } from "./providers/claudeSubscription.js";
import { metaProvider } from "./providers/meta.js";
import { openRouterProvider } from "./providers/openRouter.js";

/**
 * Last id wins in a Map, so a duplicate would silently replace a built-in
 * plugin and reroute every launch that names it. Callers filter shadowing
 * definitions before they get here; a duplicate that still arrives is a bug,
 * and a loud one is safer than a hijacked provider.
 */
function byId<T extends { id: string }>(items: T[], kind: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) {
      throw new ProfileError(`Duplicate ${kind} id "${item.id}" in the registry.`);
    }
    map.set(item.id, item);
  }
  return map;
}

export function defaultAgents(): AgentPort[] {
  return [claudeCodeAgent];
}

export function defaultProviders(): ProviderPort[] {
  return [claudeSubscriptionProvider, openRouterProvider, metaProvider];
}

export function createAgentRegistry(extra: AgentPort[] = []): AgentRegistry {
  const map = byId([...defaultAgents(), ...extra], "agent");
  return {
    get: (id: string) => map.get(id),
    list: () => [...map.values()],
  };
}

export function createProviderRegistry(
  extra: ProviderPort[] = [],
): ProviderRegistry {
  const map = byId([...defaultProviders(), ...extra], "provider");
  return {
    get: (id: string) => map.get(id),
    list: () => [...map.values()],
  };
}

/**
 * Every provider adapter's traffic parser, in provider order. The proxy and
 * the inspection UI consume this — wire-format knowledge stays provider-owned.
 */
export function defaultTrafficParsers(extra: ProviderPort[] = []): TrafficParser[] {
  return [...defaultProviders(), ...extra].flatMap((p) =>
    p.trafficParser ? [p.trafficParser] : [],
  );
}
