export { claudeCodeAgent } from "./agents/claudeCode.js";
export { claudeSubscriptionProvider } from "./providers/claudeSubscription.js";
export { OPENROUTER_BASE_URL, openRouterProvider } from "./providers/openRouter.js";
export { createAgentRegistry, createProviderRegistry, defaultProviders } from "./registry.js";
export { FileProfileRepository, defaultProfilesPath } from "./store/fileProfiles.js";
export {
  FileProviderAccountRepository,
  defaultProviderAccountsDir,
  maskSecret,
} from "./store/providerAccounts.js";
export { OpenRouterUsageReader } from "./providers/openRouterUsage.js";
export type { OpenRouterUsageOptions } from "./providers/openRouterUsage.js";
export { customProviderPort } from "./providers/customProvider.js";
export {
  FileCustomProviderStore,
  defaultCustomProvidersPath,
  loadCustomProviderPorts,
} from "./store/customProviders.js";
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
export { credentialIdentity } from "./subscriptions/identity.js";
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
export { SubscriptionProxy } from "./proxy/server.js";
export { DEFAULT_PROXY_PORT } from "./proxy/server.js";
import { DEFAULT_PROXY_PORT } from "./proxy/server.js";
export type { ProxyOptions, ProxyStatus } from "./proxy/server.js";

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
