// Subscription-account domain. Extends the Profile model: a
// `claude-subscription` profile can point at one stored OAuth account,
// and swisscode activates it (file/Keychain swap or proxy) at launch.

/** Metadata for one stored Claude subscription (secrets live in the vault). */
export interface SubscriptionAccount {
  /** Stable swisscode-side id, e.g. "personal". URL/CLI-safe. */
  id: string;
  /** Display label, e.g. "Personal (gmail)". */
  label: string;
  email?: string;
  createdAt: string;
  updatedAt: string;
}

/** OAuth credential snapshot for one subscription account. */
export interface OAuthCredential {
  accessToken: string;
  refreshToken: string;
  /** ms since epoch; 0/undefined = unknown (treat as expired). */
  expiresAt?: number;
  scopes?: string[];
  /**
   * Opaque /login fields we don't interpret (rateLimitTier,
   * refreshTokenExpiresAt, subscriptionType, ...). Round-tripped verbatim so a
   * switch restores the byte-equivalent credential /login would have left.
   */
  extra?: Record<string, unknown>;
}

/** One utilization window from the Anthropic usage API. */
export interface UsageWindow {
  /** 0-100, or null when the API reports null (unlimited/unknown). */
  utilization: number | null;
  resetsAt?: string;
}

/** Per-model weekly limit from the `limits` array (display names, e.g. "Fable"). */
export interface ScopedLimit {
  name: string;
  utilization: number;
  resetsAt?: string;
}

/** Pay-as-you-go extra-usage spend, in dollars. */
export interface SpendInfo {
  used: number;
  /** Null = no cap set. */
  limit: number | null;
  resetsAt?: string;
}

/** Generically captured window (rotating codenames, future scoped keys). */
export interface ExtraWindow {
  key: string;
  utilization: number;
  resetsAt?: string;
}

/** Usage snapshot for one account. */
export interface AccountUsage {
  accountId: string;
  fetchedAt: string;
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** Per-model weekly windows, keyed by model family ("sonnet", "opus", ...). */
  models?: Record<string, UsageWindow>;
  /** Per-model weekly limits from `limits[]`, keyed by display name. */
  scoped?: ScopedLimit[];
  /** Extra-usage spend, when the account reports it. */
  spend?: SpendInfo;
  /** Any other top-level `{utilization}` windows (codename keys, etc.). */
  windows?: ExtraWindow[];
  /** True when served from cache because the live fetch failed. */
  stale?: boolean;
}

export type CredentialBackend = "file" | "keychain" | "none";

/** What Claude Code itself currently holds (read from its own store). */
export interface ActiveCredentialState {
  backend: CredentialBackend;
  credential?: OAuthCredential;
  /** Which keychain service / file the active credential came from. */
  source?: string;
}

/**
 * Generic stored credential for ANY provider (the provider-agnostic account).
 * Secrets live in `config`, keyed by the provider's FieldDef keys —
 * e.g. OpenRouter: { apiKey, model }. OAuth-lifecycle providers
 * (claude-subscription) keep using SubscriptionAccount instead.
 */
export interface ProviderAccount {
  id: string;
  providerId: string;
  label: string;
  config: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** How a stored account can be activated for a launch. */
export type AccountSwitchMode = "proxy" | "file-swap";

/** One model entry from a provider's model catalog (for pickers). */
export interface ProviderModel {
  /** Provider-scoped model id, e.g. "anthropic/claude-sonnet-4". */
  id: string;
  /** Human display name, when the endpoint provides one. */
  name?: string;
  /** Author slug from the id prefix, e.g. "anthropic". */
  creator?: string;
  /** Release timestamp (ISO), when the endpoint reports one. */
  created?: string;
  /** Total context window in tokens. */
  contextLength?: number;
  /** Max completion tokens (best-known serving provider). */
  maxCompletionTokens?: number;
  /** Accepted input modalities, e.g. ["text", "image"]. */
  inputModalities?: string[];
  /** USD per 1M tokens, when the endpoint reports pricing. */
  promptPerMillion?: number;
  /** USD per 1M completion tokens. */
  completionPerMillion?: number;
}

/** One serving provider for a model (OpenRouter endpoints). */
export interface ModelEndpoint {
  /** Serving provider, e.g. "Amazon Bedrock". */
  provider: string;
  /** Routing tag, e.g. "amazon-bedrock/eu-west-1". */
  tag?: string;
  contextLength?: number;
  maxCompletionTokens?: number;
  /** e.g. "fp8", "unknown". */
  quantization?: string;
  promptPerMillion?: number;
  completionPerMillion?: number;
  /** 1-day uptime percent, when reported. */
  uptime1d?: number;
}

/** What a provider plugin declares about its account management needs. */
export interface ProviderAccountCapabilities {
  /**
   * The provider can snapshot "whatever is currently logged in"
   * (claude-subscription: read Claude Code's own store).
   */
  importActive: boolean;
  /** The provider exposes live usage/limits for stored accounts. */
  usageMetrics: boolean;
  /** The provider publishes a model list for pickers (OpenRouter today). */
  modelCatalog?: boolean;
  /** The provider lists serving providers per model (OpenRouter endpoints). */
  modelEndpoints?: boolean;
  /** The provider can test credentials before they are saved. */
  connectionTest?: boolean;
  /** Activation modes the accounts UI may offer. Key-based providers: []. */
  switchVia: AccountSwitchMode[];
  /** Human hint for the accounts UI, e.g. "needs an API key". */
  hint?: string;
}

/** One labeled usage number for the generic accounts UI. */
export interface UsageMetric {
  label: string;
  value: string;
}

/** Live usage snapshot for one generic provider account. */
export interface ProviderUsageSnapshot {
  accountId: string;
  providerId: string;
  fetchedAt: string;
  metrics: UsageMetric[];
}
