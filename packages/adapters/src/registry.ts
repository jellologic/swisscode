// Default registries: the full plugin set for v1.
// Adding a new agent/provider = add one adapter file + one line here.

import type {
  AgentPort,
  AgentRegistry,
  ProviderPort,
  ProviderRegistry,
  TrafficParser,
} from "@swisscode/core";
import { claudeCodeAgent } from "./agents/claudeCode.js";
import { claudeSubscriptionProvider } from "./providers/claudeSubscription.js";
import { openRouterProvider } from "./providers/openRouter.js";

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((i) => [i.id, i]));
}

export function defaultAgents(): AgentPort[] {
  return [claudeCodeAgent];
}

export function defaultProviders(): ProviderPort[] {
  return [claudeSubscriptionProvider, openRouterProvider];
}

export function createAgentRegistry(extra: AgentPort[] = []): AgentRegistry {
  const map = byId([...defaultAgents(), ...extra]);
  return {
    get: (id: string) => map.get(id),
    list: () => [...map.values()],
  };
}

export function createProviderRegistry(
  extra: ProviderPort[] = [],
): ProviderRegistry {
  const map = byId([...defaultProviders(), ...extra]);
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
