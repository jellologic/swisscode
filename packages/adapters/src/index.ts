import { join } from "node:path";
import { homedir } from "node:os";

export { claudeCodeAgent } from "./agents/claudeCode.js";
export { claudeSubscriptionProvider } from "./providers/claudeSubscription.js";
export { OPENROUTER_BASE_URL, openRouterProvider } from "./providers/openRouter.js";
export { createAgentRegistry, createProviderRegistry, defaultProviders, defaultTrafficParsers } from "./registry.js";
export { claudeTrafficParser } from "./providers/claudeTrafficParser.js";
export { FileProfileRepository, defaultProfilesPath } from "./store/fileProfiles.js";
export {
  FileProviderAccountRepository,
  defaultProviderAccountsDir,
  maskSecret,
} from "./store/providerAccounts.js";
export { OpenRouterUsageReader } from "./providers/openRouterUsage.js";
export type { OpenRouterUsageOptions } from "./providers/openRouterUsage.js";
export { customProviderPort } from "./providers/customProvider.js";
export { CustomAccountValidator, OpenRouterAccountValidator } from "./providers/accountValidator.js";
export type { AccountValidatorOptions, CustomValidatorOptions } from "./providers/accountValidator.js";
export {
  FileCustomProviderStore,
  defaultCustomProvidersPath,
  loadCustomProviderPorts,
} from "./store/customProviders.js";
export { readJsonFile, writeFileAtomic, writeJsonAtomic } from "./store/atomicJson.js";
export type { ReadJsonResult, WriteAtomicOptions } from "./store/atomicJson.js";
export { createBundleRegistry } from "./store/configBundle.js";
export type { BundleRegistry, BundleStoreDeps, ImportBundleOptions } from "./store/configBundle.js";
export { ModelCatalogError, OpenRouterModelCatalog } from "./providers/openRouterModels.js";
export type { OpenRouterModelsOptions } from "./providers/openRouterModels.js";
export {
  CachingModelCatalog,
  DEFAULT_MODEL_CACHE_TTL_MS,
  FileModelCatalogCache,
  defaultModelCatalogCachePath,
} from "./providers/modelCatalogCache.js";
export type {
  CachingModelCatalogOptions,
  ModelCatalogCacheEntry,
  ModelCatalogSnapshot,
  ModelEndpointsCacheEntry,
  ModelEndpointsSnapshot,
} from "./providers/modelCatalogCache.js";
export { credentialIdentity, findAccountByCredential } from "./subscriptions/identity.js";
export { liveResyncHook, resyncSubscriptionCredential } from "./subscriptions/liveResync.js";
export { freshVaultCredential } from "./subscriptions/freshCredential.js";
export type { FreshVaultCredentialOptions } from "./subscriptions/freshCredential.js";
export type { LiveResyncDeps } from "./subscriptions/liveResync.js";
export { CachingUsageClient, FileUsageCache, defaultUsageCachePath } from "./subscriptions/usageCache.js";
export type { CachingUsageOptions, UsageCacheEntry } from "./subscriptions/usageCache.js";
export { UsageError } from "./subscriptions/anthropic.js";
export { FileAccountRepository, defaultSubscriptionsDir } from "./subscriptions/accountVault.js";
export {
  ClaudeActiveCredentialStore,
  CLAUDE_KEYCHAIN_SERVICE,
} from "./subscriptions/activeStore.js";
export type { ActiveStoreOptions } from "./subscriptions/activeStore.js";
export {
  AnthropicOAuthClient,
  AnthropicUsageClient,
  OAUTH_BETA_HEADER,
  OAUTH_CLIENT_ID,
} from "./subscriptions/anthropic.js";
export type { AnthropicOptions } from "./subscriptions/anthropic.js";
export {
  PROXY_TOKEN_HEADER,
  createProxyToken,
  defaultProxyTokenPath,
  readProxyToken,
} from "./proxy/proxyToken.js";
export { SubscriptionProxy } from "./proxy/server.js";
export { DEFAULT_PROXY_PORT } from "./proxy/server.js";
import { DEFAULT_PROXY_PORT } from "./proxy/server.js";
export type { ProxyOptions, ProxyStatus, ProxyTrafficAttempt, ProxyTrafficEntry } from "./proxy/server.js";
export { MAX_TRAFFIC_BUFFER_SIZE, parseProfileTag } from "./proxy/server.js";
export { groupTrafficConversations, parseRequestJson, summarizeTrafficEntry } from "./proxy/trafficSummary.js";
export type {
  TrafficConversation,
  TrafficMessagePreview,
  TrafficRequestSummary,
  TrafficResponseSummary,
  TrafficSummary,
} from "./proxy/trafficSummary.js";
export type { TrafficExchange, TrafficParser, TrafficRole, TrafficRoute } from "@swisscode/core";
export { findClaudeSession, readSessionContext } from "./proxy/sessionContext.js";
export type {
  ReadSessionContextOptions,
  SessionAgentDefinition,
  SessionContext,
  SessionTaskLaunch,
  SessionWorkflowAgent,
  SessionWorkflowScript,
} from "./proxy/sessionContext.js";

/** Default JSONL traffic log next to the vault: ~/.swisscode/proxy-traffic.jsonl. */
export function defaultTrafficLogPath(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "proxy-traffic.jsonl");
}

/** Proxy port: SWISSCODE_PROXY_PORT override, else the default. */
export function proxyPort(explicit?: number | string): number {
  const raw = explicit ?? process.env["SWISSCODE_PROXY_PORT"];
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && (n as number) > 0 ? (n as number) : DEFAULT_PROXY_PORT;
}

/** Base URL for a proxy on the given port. */
export function proxyBaseUrl(port?: number | string): string {
  return `http://127.0.0.1:${proxyPort(port)}`;
}
