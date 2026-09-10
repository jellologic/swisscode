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

/**
 * One per-model routing rule inside a profile. The proxy resolves the request
 * model (always a full id — aliases are resolved client-side before requests
 * leave Claude Code) and applies the first route whose `match` equals it.
 * No match, or no routes at all, means the profile's base provider.
 */
export interface ModelRoute {
  /** Exact resolved model id, e.g. "claude-opus-5" or "anthropic/claude-opus-4". */
  match: string;
  /** Where matching requests go. */
  kind: "subscription" | "providerAccount";
  /**
   * Vault subscription account for kind "subscription". Absent = the profile's
   * base subscription account (failover set = whole vault either way).
   */
  subscriptionAccountId?: string;
  /** Stored key-account provider for kind "providerAccount". */
  providerId?: string;
  /** Stored key-account id for kind "providerAccount". */
  providerAccountId?: string;
  /**
   * Model id sent upstream. Omit = pass the requested id through (normal for
   * subscription routes); set for key routes whose upstream names differ
   * (e.g. OpenRouter "anthropic/claude-opus-4").
   */
  upstreamModel?: string;
}

/**
 * JSON-compatible value: the closed type free-form payloads must fit so they
 * survive serialization boundaries (stored JSON, TanStack server functions).
 * `unknown` would also accept functions and class instances, which silently
 * become garbage downstream — this rejects them at the type level instead.
 */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Per-session Claude Code knobs owned by a profile (all optional — absent
 * means today's behavior). Emitted as CLI flags plus one ephemeral `--settings`
 * file; the user's own settings files are never touched. Print-only upstream
 * flags (`--fallback-model`, `--max-budget-usd`) are deliberately absent: the
 * settings-level `fallbackModel` key covers fallback generally.
 */
export interface ClaudeSessionOptions {
  /** Effort level: low|medium|high|xhigh|max (verified against `claude -h`). */
  effort?: string;
  /** Permission mode: acceptEdits|auto|bypassPermissions|manual|dontAsk|plan. */
  permissionMode?: string;
  /** Permission grants (each stays one argv element, e.g. "Bash(npm test:*)"). */
  allowedTools?: string[];
  /** Permission denials, same shape as allowedTools. */
  disallowedTools?: string[];
  /** Available-tool inventory: "" (none), "default", or a comma/space list. */
  tools?: string;
  /** Extra working directories (`--add-dir`, repeatable). Shape-only sanity. */
  addDirs?: string[];
  /** Replace the default system prompt (prefer appendSystemPrompt). */
  systemPrompt?: string;
  /** Append to the default system prompt. */
  appendSystemPrompt?: string;
  /**
   * Which named prompt snippet the append text was copied from
   * (reviewer|planner|explainer — see the adapters gallery). Provenance only:
   * emission reads `appendSystemPrompt`, so hand-edits keep working and later
   * snippet edits never surprise this profile.
   */
  promptPreset?: string;
  /** Session subagent override (`--agent`). */
  agent?: string;
  /**
   * MCP config: inline JSON (starts with { or [, written to a temp file) or a
   * config file path (passed through). Auto-detected — a path can never parse
   * as JSON, so the reading is unambiguous.
   */
  mcpConfig?: string;
  /** Ignore every MCP source except --mcp-config. */
  strictMcp?: boolean;
  /** Settings layers to load: subset of user|project|local (omit = all). */
  settingSources?: string[];
  /** Settings-level fallback model chain. */
  fallbackModel?: string[];
  /**
   * Escape hatch: free-form settings JSON merged UNDER the curated fields
   * above (curated wins on conflict — validated enums beat raw typos).
   */
  claudeSettings?: Record<string, JsonValue>;
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
   * Per-model routing rules, evaluated first-match-wins by the proxy.
   * Requires the proxy (launch fails closed when it is down); combining with
   * `direct:true` is a save-time error.
   */
  modelRoutes?: ModelRoute[];
  /**
   * Bypass the proxy and connect straight to the provider (advanced).
   * Loses failover, model routes and traffic inspection. Default: proxy.
   */
  direct?: boolean;
  /**
   * Claude Code session knobs (flags + ephemeral settings). Never rewrites the
   * user's own settings files — see buildClaudeFlags/buildClaudeSettings.
   */
  session?: ClaudeSessionOptions;
  /**
   * Generic stored account reference (key-based providers, e.g. OpenRouter).
   * The account's config merges under the profile's inline providerConfig
   * (inline fields win). Must belong to profile.providerId.
   */
  providerAccountId?: string;
  /**
   * Default working directory for launches. A spawn option, not env: the CLI
   * passes it as the child `cwd` (and `show` prints it); the proxy and the
   * agent command never see it. Must be absolute — a relative dir would
   * resolve against wherever swisscode happened to start.
   */
  cwd?: string;
}

/** One file the launcher must materialize for a launch (0600, temp dir). */
export interface EphemeralFile {
  /** Path relative to the ephemeral dir, e.g. "settings.json". */
  rel: string;
  content: string;
  /** File mode, e.g. 0o600. */
  mode: number;
}

/** The resolved OS-level launch plan for a profile. */
export interface LaunchSpec {
  command: string;
  args: string[];
  /** Env vars to set on top of process.env when spawning. */
  env: Record<string, string>;
  /**
   * Working directory for the child process (from `profile.cwd`). Carried
   * here so `show`, `--dry-run` and the web Preview all render the directory
   * the CLI will actually spawn in — only the real CLI launch applies it.
   */
  cwd?: string;
  /**
   * File descriptors, not writes: only the real CLI launch path materializes
   * these (adapters' writeEphemeralFiles). `show`/`--dry-run` render them
   * without touching the filesystem, so buildLaunch stays pure and the web UI
   * can call resolveLaunchSpec freely.
   */
  ephemeralFiles?: EphemeralFile[];
}

/** How the proxy's background rotation poller picks the next active account. */
export type RotationStrategy = "reset-soonest" | "least-used";

/** How swisscode reacts when a newer release exists on the registry. */
export type UpdateMode = "off" | "notify-only" | "auto";

/**
 * Global (home-level) runtime settings: one record for the whole home, not
 * per-profile. Persisted as `<base>/settings.json`, backed up as the bundle's
 * "settings" key. Grows one optional field at a time — never silently, so old
 * bundles (no "settings" key) still import onto these defaults.
 */
export interface GlobalSettings {
  /** Background subscription health check + auto-rollover. Off by default. */
  rotationEnabled: boolean;
  rotationStrategy: RotationStrategy;
  /** Self-update behavior. Auto by default so installs stay current. */
  updateMode: UpdateMode;
}

/** Cold-start defaults: rotation stays off until the user opts in. */
export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  rotationEnabled: false,
  rotationStrategy: "reset-soonest",
  updateMode: "auto",
};
