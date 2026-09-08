// Hexagonal ports. The core owns these interfaces; adapters implement them.

import type { FieldDef, LaunchSpec, PluginHelp, Profile } from "./domain.js";
import type {
  ModelEndpoint,
  ProviderAccount,
  ProviderAccountCapabilities,
  ProviderModel,
  ProviderUsageSnapshot,
} from "./subscriptions.js";

/** Port: a coding-agent plugin ( Driven by core, implemented by adapters ). */
export interface AgentPort {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** Binary invoked, e.g. "claude". */
  readonly command: string;
  readonly defaultArgs: string[];
  /** In-plugin help, rendered on /help. Adding an agent documents it. */
  readonly help?: PluginHelp;
  /**
   * Build the final launch spec given provider env + profile.
   * Agent adapters own agent-specific env mapping (e.g. model var names).
   */
  buildLaunch(profile: Profile, providerEnv: Record<string, string>): LaunchSpec;
}

/** Port: an AI-provider plugin ( Driven by core, implemented by adapters ). */
export interface ProviderPort {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly fields: FieldDef[];
  /** What this provider needs on the accounts page (import flow, usage, hints). */
  readonly accountCapabilities: ProviderAccountCapabilities;
  /** In-plugin help, rendered on /help. Adding a provider documents it. */
  readonly help?: PluginHelp;
  /** Turn stored provider config into env vars for the agent. */
  buildEnv(
    config: Record<string, string> | undefined,
    profile: Pick<Profile, "model">,
  ): Record<string, string>;
}

/** Port: profile persistence. */
export interface ProfileRepository {
  list(): Promise<Profile[]>;
  get(name: string): Promise<Profile | undefined>;
  save(profile: Profile): Promise<void>;
  remove(name: string): Promise<boolean>;
}

/** Port: generic per-provider account vault (key-based providers). */
export interface ProviderAccountRepository {
  list(providerId?: string): Promise<ProviderAccount[]>;
  get(providerId: string, id: string): Promise<ProviderAccount | undefined>;
  save(account: ProviderAccount): Promise<void>;
  remove(providerId: string, id: string): Promise<boolean>;
}

/** Port: live usage reader for one provider's stored accounts. */
export interface ProviderUsageReader {
  readonly providerId: string;
  readUsage(account: ProviderAccount): Promise<ProviderUsageSnapshot>;
}

/** Port: a provider's published model list, for pickers (driven by core). */
export interface ProviderModelCatalog {
  readonly providerId: string;
  /**
   * Fetch the full model list. Config is the stored account config, passed
   * through for endpoints that need auth; public endpoints (OpenRouter)
   * ignore it.
   */
  listModels(config?: Record<string, string>): Promise<ProviderModel[]>;
  /**
   * Serving providers for one model (pricing/quantization compare).
   * Optional: providers without endpoint data omit it.
   */
  listEndpoints?(modelId: string, config?: Record<string, string>): Promise<ModelEndpoint[]>;
}

/** Lookup registries — in-memory adapters over the plugin ports. */
export interface AgentRegistry {
  get(id: string): AgentPort | undefined;
  list(): AgentPort[];
}

export interface ProviderRegistry {
  get(id: string): ProviderPort | undefined;
  list(): ProviderPort[];
}
