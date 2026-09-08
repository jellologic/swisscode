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

/** One external reference from a plugin's help (docs, key pages, …). */
export interface PluginLink {
  label: string;
  href: string;
}

/**
 * Help owned by a plugin adapter — part of the port DNA. The /help page
 * renders this verbatim, so adding an agent/provider automatically documents
 * it. Keep steps user-actionable and commands copy-pasteable.
 */
export interface PluginHelp {
  /** What this plugin is for, one paragraph. */
  summary?: string;
  /** Ordered setup steps shown to the user. */
  setup?: string[];
  /** CLI commands worth knowing, e.g. ["swisscode proxy run"]. */
  commands?: string[];
  /** External links. Only link pages known to exist. */
  links?: PluginLink[];
}

/** A profile merges one coding agent with one AI provider. */
export interface Profile {
  /**
   * Unique profile name — this is what `swisscode <profileName>` takes, so it
   * may not be one of RESERVED_PROFILE_NAMES (the CLI would win the dispatch).
   */
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
  /**
   * Stored subscription account id (only for providerId "claude-subscription").
   * Omitted = use whatever Claude Code is currently logged in as.
   */
  subscriptionAccountId?: string;
  /**
   * Route this profile through the swisscode proxy (transparent switching +
   * 429 failover) instead of swapping the shared credential file. Requires
   * `swisscode proxy run` to be up; only meaningful with subscriptionAccountId.
   */
  useProxy?: boolean;
  /**
   * Generic stored account reference (key-based providers, e.g. OpenRouter).
   * The account's config merges under the profile's inline providerConfig
   * (inline fields win). Must belong to profile.providerId.
   */
  providerAccountId?: string;
}

/** The resolved OS-level launch plan for a profile. */
export interface LaunchSpec {
  command: string;
  args: string[];
  /** Env vars to set on top of process.env when spawning. */
  env: Record<string, string>;
}
