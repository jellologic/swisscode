// Hexagonal ports. The core owns these interfaces; adapters implement them.

import type { FieldDef, LaunchSpec, Profile } from "./domain.js";

/** Port: a coding-agent plugin ( Driven by core, implemented by adapters ). */
export interface AgentPort {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  /** Binary invoked, e.g. "claude". */
  readonly command: string;
  readonly defaultArgs: string[];
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

/** Lookup registries — in-memory adapters over the plugin ports. */
export interface AgentRegistry {
  get(id: string): AgentPort | undefined;
  list(): AgentPort[];
}

export interface ProviderRegistry {
  get(id: string): ProviderPort | undefined;
  list(): ProviderPort[];
}
