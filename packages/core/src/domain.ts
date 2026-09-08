// Domain entities. Pure data, no I/O. Framework-agnostic.

/** A configurable field on a provider (e.g. apiKey). */
export interface FieldDef {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
}

/** A profile merges one coding agent with one AI provider. */
export interface Profile {
  /** Unique profile name — this is what `swisscode <profileName>` takes. */
  name: string;
  /** Coding-agent plugin id, e.g. "claude-code". */
  agentId: string;
  /** Extra CLI args appended after the agent's default args. */
  agentArgs?: string[];
  /** AI-provider plugin id, e.g. "openrouter" | "claude-subscription". */
  providerId: string;
  /** Free-form config values keyed by the provider's FieldDef keys. */
  providerConfig?: Record<string, string>;
  /** Optional model override passed through to the launch. */
  model?: string;
}

/** The resolved OS-level launch plan for a profile. */
export interface LaunchSpec {
  command: string;
  args: string[];
  /** Env vars to set on top of process.env when spawning. */
  env: Record<string, string>;
}
