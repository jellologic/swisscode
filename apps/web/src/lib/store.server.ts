// Server-only data access. The `.server.` suffix keeps node:fs + API keys
// out of the client bundle. All domain logic goes through @swisscode/core.

import { stat } from "node:fs/promises";
import {
  AnthropicOAuthClient,
  AnthropicUsageClient,
  CachingModelCatalog,
  CachingUsageClient,
  ClaudeActiveCredentialStore,
  CustomAccountValidator,
  FileAccountRepository,
  FileCustomProviderStore,
  FileModelCatalogCache,
  FileProfileRepository,
  FileProviderAccountRepository,
  PROFILE_PRESETS,
  PROMPT_PRESETS,
  freshVaultCredential,
  FileUsageCache,
  OpenRouterAccountValidator,
  OpenRouterModelCatalog,
  OpenRouterUsageReader,
  createBundleRegistry,
  defaultProviders,
  findAccountByCredential,
  loadCustomProviderPorts,
  countOtherClaudeSessions,
  createAgentRegistry,
  createProviderRegistry,
  defaultProfilesPath,
  defaultTrafficStorePath,
  maskSecret,
  groupTrafficConversations,
  openTrafficStore,
  proxyLaunchEnv,
  proxyPort,
  summarizeTrafficEntry,
  usesProxy,
  type ProcessProbe,
  type SessionContext,
  type TrafficConversation,
} from "@swisscode/adapters";
import {
  collectSecretValues,
  describeModelRoute,
  isRecordId,
  redactEnv,
  resolveLaunchSpec,
  resolveProviderConfig,
  rollupExchanges,
  rollupTotal,
  spendRollup,
  spendTotal,
  suggestInsights,
  validateAccountId,
  validateProfile,
  type AccountValidation,
  type AccountUsage,
  type ConfigBundle,
  type CustomProviderDef,
  type FieldDef,
  type ModelEndpoint,
  type ModelRouteLabels,
  type PluginHelp,
  type Profile,
  type ProviderAccount,
  type ProviderAccountCapabilities,
  type ProviderAccountValidator,
  type ProviderModel,
  type ProviderRegistry,
  type ProviderUsageSnapshot,
  type SpendRow,
  type StoredTrafficExchange,
  type StoreImportResult,
  type SubscriptionAccount,
  type TrafficFilter,
  type TrafficRollupRow,
} from "@swisscode/core";
import { mergeAccountConfig } from "./accountConfig.js";
import { ProxyControlClient } from "./proxyClient.server.js";
import type { ProxyTrafficItem } from "./threadView.js";

export type { ProxyTrafficItem } from "./threadView.js";

const agents = createAgentRegistry();
const customProviderStore = new FileCustomProviderStore();
const builtinProviderIds = defaultProviders().map((p) => p.id);

/** Registry = built-ins + stored customs. Reset when customs change. */
let registryPromise: Promise<ProviderRegistry> | undefined;
async function providerRegistry(): Promise<ProviderRegistry> {
  registryPromise ??= (async () =>
    createProviderRegistry(await loadCustomProviderPorts(customProviderStore)))();
  return registryPromise;
}
function resetProviderRegistry(): void {
  registryPromise = undefined;
}

/** Exact secret keys from the live registry (built-ins + customs). */
async function secretKeysFor(providerId: string): Promise<Set<string>> {
  const registry = await providerRegistry();
  const provider = registry.get(providerId);
  return new Set((provider?.fields ?? []).filter((f) => f.secret).map((f) => f.key));
}
const profiles = new FileProfileRepository(defaultProfilesPath());
const vault = new FileAccountRepository();
const activeStore = new ClaudeActiveCredentialStore();
const oauth = new AnthropicOAuthClient();
const usageApi = new AnthropicUsageClient();
const usageClient = new CachingUsageClient(usageApi, new FileUsageCache());
const providerAccounts = new FileProviderAccountRepository();
/** Backup/restore registry: one entry per store (see createBundleRegistry). */
const bundles = createBundleRegistry({
  profiles,
  vault,
  providerAccounts,
  customProviders: customProviderStore,
  secretKeysFor,
});
const usageReaders = [new OpenRouterUsageReader()];
const modelCatalog = new CachingModelCatalog(
  new OpenRouterModelCatalog(),
  new FileModelCatalogCache(),
);
const modelCatalogs = [modelCatalog];

export function getAgents() {
  return agents.list().map((a) => ({
    id: a.id,
    displayName: a.displayName,
    description: a.description,
    command: a.command,
    defaultArgs: a.defaultArgs,
    help: a.help,
  }));
}

export interface ProviderListItem {
  id: string;
  displayName: string;
  description: string;
  fields: FieldDef[];
  accountCapabilities: ProviderAccountCapabilities;
  help?: PluginHelp;
  /** False for user-defined providers (editable on /providers). */
  builtin: boolean;
  /** True when the provider can test credentials before save. */
  hasValidator: boolean;
  /** The stored definition, only for customs. */
  custom?: CustomProviderDef;
}

/** Full catalog: built-ins first, then customs. Async: customs load from disk. */
export async function getProviders(): Promise<ProviderListItem[]> {
  const registry = await providerRegistry();
  const customs = new Map((await customProviderStore.list()).map((d) => [d.id, d]));
  const validators = await accountValidators();
  return registry.list().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    description: p.description,
    fields: p.fields,
    accountCapabilities: p.accountCapabilities,
    help: p.help,
    builtin: !customs.has(p.id),
    hasValidator: validators.has(p.id),
    ...(customs.get(p.id) ? { custom: customs.get(p.id) } : {}),
  }));
}

/** Validators: built-ins plus customs that declare a test endpoint. */
async function accountValidators(): Promise<Map<string, ProviderAccountValidator>> {
  const map = new Map<string, ProviderAccountValidator>([
    ["openrouter", new OpenRouterAccountValidator()],
  ]);
  for (const def of await customProviderStore.list()) {
    if (def.test) map.set(def.id, new CustomAccountValidator(def));
  }
  return map;
}

/** Pre-save credential check. Never throws — failure is a verdict. */
export async function validateProviderAccount(
  providerId: string,
  config: Record<string, string>,
): Promise<AccountValidation> {
  const validator = (await accountValidators()).get(providerId);
  if (!validator) return { ok: false, error: `No connection test for provider "${providerId}".` };
  try {
    return await validator.validateAccount(config);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function getProfiles(): Promise<Profile[]> {
  return profiles.list();
}

/**
 * Starter gallery: pure preset data (no I/O inside — the import only carries
 * the constant). Copy-fill, never linked: the form takes the values and the
 * preset stays behind.
 */
export async function getPresets() {
  return { presets: PROFILE_PRESETS, promptPresets: PROMPT_PRESETS };
}

/** Stored as-is (secrets live in ~/.swisscode, same machine as the CLI). */
export async function saveProfile(profile: Profile): Promise<void> {
  validateProfile(profile);
  await profiles.save(profile);
}

export async function deleteProfile(name: string): Promise<void> {
  await profiles.remove(name);
}

/**
 * Resolve a profile to its launch spec, with secrets redacted.
 *
 * Redaction is by VALUE first: a custom provider may map its secret field to
 * any env name it likes (MY_PASSWORD, X_GATEWAY), and a name pattern alone
 * hands that key to the browser. redactEnv keeps the widened name pattern as
 * the fallback for secrets we were never told about.
 */
export async function previewProfile(name: string) {
  const stored = await profiles.get(name);
  if (!stored) throw new Error(`Unknown profile "${name}"`);
  let profile = stored;
  const secretKeys = await secretKeysFor(stored.providerId);
  const secretValues: string[] = [];
  if (stored.providerAccountId) {
    const account = await providerAccounts.get(stored.providerId, stored.providerAccountId);
    if (account) secretValues.push(...collectSecretValues(account.config, secretKeys));
    profile = resolveProviderConfig(stored, () => account ?? undefined);
  }
  secretValues.push(...collectSecretValues(profile.providerConfig, secretKeys));
  const spec = resolveLaunchSpec(agents, await providerRegistry(), profile);
  return {
    command: spec.command,
    args: spec.args,
    env: redactEnv(spec.env, secretValues),
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
  };
}

/** Labels for describeModelRoute, read live like the CLI `show` path. */
async function launchRouteLabels(): Promise<ModelRouteLabels> {
  const [subscriptions, keys, registry] = await Promise.all([
    vault.list().catch(() => []),
    providerAccounts.list().catch(() => []),
    providerRegistry(),
  ]);
  const vaultById = new Map(subscriptions.map((a) => [a.id, a.label]));
  const keyById = new Map(keys.map((a) => [`${a.providerId}:${a.id}`, a.label]));
  const providerName = new Map(registry.list().map((p) => [p.id, p.displayName]));
  return {
    subscriptionAccountLabel: (id) => vaultById.get(id),
    providerAccountLabel: (providerId, id) => keyById.get(`${providerId}:${id}`),
    providerDisplayName: (providerId) => providerName.get(providerId),
  };
}

/**
 * The `show` equivalent for an UNSAVED profile: what launching this form
 * would run (command, args, redacted env, ephemeral file contents, route
 * sentences). Throws ProfileError/InputError on invalid input so the form
 * renders it inline next to Save errors. POST-only: the payload can carry
 * inline secrets, which never belong in a URL.
 */
export async function previewLaunch(profile: Profile) {
  validateProfile(profile);
  let resolved = profile;
  const secretKeys = await secretKeysFor(profile.providerId);
  const secrets: string[] = [];
  if (profile.providerAccountId) {
    const account = await providerAccounts.get(profile.providerId, profile.providerAccountId);
    if (account) secrets.push(...collectSecretValues(account.config, secretKeys));
    resolved = resolveProviderConfig(profile, () => account ?? undefined);
  }
  secrets.push(...collectSecretValues(resolved.providerConfig, secretKeys));
  const spec = resolveLaunchSpec(agents, await providerRegistry(), resolved);
  const labels = await launchRouteLabels();
  return {
    profile: resolved.providerConfig
      ? { ...resolved, providerConfig: redactEnv(resolved.providerConfig, secrets) }
      : resolved,
    launch: {
      command: spec.command,
      args: spec.args,
      env: redactEnv(proxyLaunchEnv(resolved, spec.env), secrets),
      ...(spec.cwd ? { cwd: spec.cwd } : {}),
    },
    ephemeralFiles: spec.ephemeralFiles ?? [],
    routes: (resolved.modelRoutes ?? []).map((r) => describeModelRoute(r, labels)),
    proxy: usesProxy(resolved),
  };
}

/** One store-backed report: totals, three rollup grains, newest-first recents. */
export interface ProxyReport {
  available: boolean;
  total: TrafficRollupRow | null;
  byDay: TrafficRollupRow[];
  byRoute: TrafficRollupRow[];
  byProfile: TrafficRollupRow[];
  recent: StoredTrafficExchange[];
  /** Estimated spend over the same uncapped selection (estimates, not bills). */
  spendTotal: SpendRow | null;
  spendByDay: SpendRow[];
  spendByRoute: SpendRow[];
  spendByProfile: SpendRow[];
  /** Read-only route suggestions over the route grain + spend lookup. */
  suggestions: string[];
}

/** Newest-first request facts backing the report list (bodies live in JSONL). */
const REPORT_RECENT_LIMIT = 100;

/**
 * Queryable history via the TrafficLog port — never SQL in the caller, never
 * the live ring buffer (history survives proxy restarts; the ring does not).
 * `available:false` when this home never ran the proxy (no store file yet).
 */
export async function getProxyReport(filter: TrafficFilter): Promise<ProxyReport> {
  const empty: ProxyReport = {
    available: false,
    total: null,
    byDay: [],
    byRoute: [],
    byProfile: [],
    recent: [],
    spendTotal: null,
    spendByDay: [],
    spendByRoute: [],
    spendByProfile: [],
    suggestions: [],
  };
  try {
    if (!(await stat(defaultTrafficStorePath())).isFile()) return empty;
  } catch {
    return empty;
  }
  const store = await openTrafficStore(defaultTrafficStorePath());
  try {
    const rows = await store.query({ ...filter, limit: 0 });
    if (rows.length === 0) {
      return { ...empty, available: true };
    }
    const byRoute = rollupExchanges(rows, "route");
    const spendByRoute = spendRollup(rows, "route");
    const spendLookup: Record<string, number> = {};
    for (const row of spendByRoute) spendLookup[row.key] = row.estSpendUsd;
    // Dead-route tips need the configured match ids — only when the report
    // is scoped to one profile whose config we can read.
    let configuredRoutes: string[] | undefined;
    if (filter.profile) {
      const profile = await profiles.get(filter.profile).catch(() => undefined);
      const matches = profile?.modelRoutes?.map((r) => r.match);
      if (matches && matches.length > 0) configuredRoutes = matches;
    }
    return {
      available: true,
      total: rollupTotal(rows),
      byDay: rollupExchanges(rows, "day"),
      byRoute,
      byProfile: rollupExchanges(rows, "profile"),
      recent: rows.slice(-REPORT_RECENT_LIMIT).reverse(),
      spendTotal: spendTotal(rows),
      spendByDay: spendRollup(rows, "day"),
      spendByRoute,
      spendByProfile: spendRollup(rows, "profile"),
      suggestions: suggestInsights(byRoute, spendLookup, {
        ...(configuredRoutes ? { configuredRoutes } : {}),
        windowLabel: "in this selection",
      }),
    };
  } finally {
    store.close();
  }
}

export function storePath(): string {
  return profiles.path;
}

export async function getAccounts(): Promise<SubscriptionAccount[]> {
  return vault.list();
}

/** Email local-part → id slug, e.g. "Ada.Lovelace@x.com" → "ada-lovelace". */
function slugifyId(value: string): string {
  return value
    .toLowerCase()
    .split("@")[0]!
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function importAccount(
  id: string,
  label?: string,
  overwrite = false,
): Promise<SubscriptionAccount> {
  const active = await activeStore.readActive();
  if (!active.credential) {
    throw new Error(
      active.backend === "none"
        ? "Claude Code has no stored login (file or Keychain). Log in first."
        : "Could not read the active Claude Code login (Keychain access may need approval).",
    );
  }
  const email = await usageApi.fetchEmail(active.credential.accessToken);
  // Blank id defaults to what the subscription says (email local-part).
  const finalId = id.trim() || (email ? slugifyId(email) : "");
  if (!finalId) throw new Error("Enter an account id — none could be derived from the login.");
  validateAccountId(finalId);
  if (!overwrite && (await vault.get(finalId))) {
    throw new Error(`Account "${finalId}" already exists.`);
  }
  const duplicate = await findAccountByCredential(vault, active.credential);
  if (duplicate && duplicate.id !== finalId) {
    throw new Error(
      `This Claude login is already imported as "${duplicate.id}". Use Re-import on that account to refresh its credentials instead of adding it again.`,
    );
  }
  const now = new Date().toISOString();
  const account: SubscriptionAccount = {
    id: finalId,
    label: label?.trim() || email || finalId,
    email,
    createdAt: now,
    updatedAt: now,
  };
  await vault.save(account, active.credential);
  return account;
}

export async function removeAccount(id: string): Promise<void> {
  await vault.remove(id);
}

export async function renameSubscriptionAccount(id: string, label: string): Promise<void> {
  const account = await vault.get(id);
  if (!account) throw new Error(`Unknown account "${id}"`);
  const credential = await vault.loadCredential(id);
  if (!credential) throw new Error(`Account "${id}" has no stored credential — re-import it.`);
  await vault.save({ ...account, label: label.trim() || account.label }, credential);
}

export interface UsageResult {
  usage?: AccountUsage;
  error?: string;
}

export interface ProxyState {
  running: boolean;
  activeAccountId: string | null;
  port: number;
}

/** Control-route client: signs every call with the proxy's per-run token. */
const proxyControl = new ProxyControlClient();

export async function getProxyState(): Promise<ProxyState> {
  const port = proxyPort();
  try {
    const status = await proxyControl.status();
    return { running: true, activeAccountId: status.activeAccountId ?? null, port };
  } catch {
    return { running: false, activeAccountId: null, port };
  }
}

export async function useProxyAccount(id: string): Promise<void> {
  await proxyControl.use(id);
}

export interface ProxyTrafficView {
  running: boolean;
  entries: ProxyTrafficItem[];
  /** Conversation groups over entries (indexes align with entries). */
  conversations: TrafficConversation[];
  kept: number;
  size: number;
  profiles: string[];
}

/**
 * Buffered proxy traffic (newest first), each with a plain-English summary.
 * Never throws.
 *
 * Body-less on purpose: this list backs a 2.5s poll, and shipping every kept
 * request and response body made a single refresh tens of megabytes. Request
 * facts, byte counts and the conversation grouping all survive; the bodies are
 * fetched one entry at a time by whoever actually renders them.
 */
export async function getProxyTraffic(profile?: string): Promise<ProxyTrafficView> {
  const empty: ProxyTrafficView = {
    running: false,
    entries: [],
    conversations: [],
    kept: 0,
    size: 0,
    profiles: [] as string[],
  };
  try {
    const body = await proxyControl.traffic({
      ...(profile !== undefined && profile !== "" ? { profile } : {}),
      bodies: false,
    });
    const entries = body.entries.map((entry) => ({
      ...entry,
      summary: summarizeTrafficEntry(entry),
    }));
    return {
      running: true,
      entries,
      conversations: groupTrafficConversations(
        entries.map((entry) => ({ entry, summary: entry.summary })),
      ),
      kept: body.kept,
      size: body.size,
      profiles: body.profiles,
    };
  } catch {
    return empty;
  }
}

/**
 * The full entries (bodies included) behind specific ids — what a thread page
 * renders. Ids that have left the ring buffer are simply absent, so the page
 * falls back to the body-less copy instead of failing. Never throws.
 */
export async function getProxyTrafficEntries(ids: string[]): Promise<ProxyTrafficItem[]> {
  try {
    const found = await Promise.all(ids.map((id) => proxyControl.entry(id)));
    return found.flatMap((entry) =>
      entry ? [{ ...entry, summary: summarizeTrafficEntry(entry) }] : [],
    );
  } catch {
    return [];
  }
}

/**
 * Local Claude Code session behind a thread (transcript prompts, Workflow
 * scripts, subagent branches). Null when the proxy is down or the session
 * is not on this machine. Never throws.
 */
export async function getSessionContext(sessionId: string): Promise<SessionContext | null> {
  try {
    if (!isRecordId(sessionId)) return null;
    return await proxyControl.sessionContext(sessionId);
  } catch {
    return null;
  }
}

export async function clearProxyTraffic(): Promise<{ cleared: number }> {
  return { cleared: await proxyControl.clearTraffic() };
}

export async function setProxyTrafficSize(size: number): Promise<{ size: number; kept: number }> {
  const n = Math.min(10000, Math.max(0, Math.floor(size)));
  return proxyControl.setTrafficSize(n);
}

/** Live usage per account; never throws — errors are reported per account. */
export async function getUsage(ids?: string[]): Promise<UsageResult[]> {
  const targets = ids ?? (await vault.list()).map((a) => a.id);
  const out: UsageResult[] = [];
  for (const accountId of targets) {
    try {
      // freshVaultCredential: single-flight + cross-process lock, adopts Claude
      // Code's live lineage, mirrors a shared-lineage rotation back to it.
      const { credential } = await freshVaultCredential(vault, oauth, accountId, {
        liveStore: activeStore,
      });
      out.push({ usage: await usageClient.fetchUsage(accountId, credential.accessToken) });
    } catch (err) {
      out.push({ error: `${accountId}: ${(err as Error).message}` });
    }
  }
  return out;
}

export interface CurrentLogin {
  backend: string;
  source?: string;
  email?: string;
  matchedAccountId: string | null;
}

export interface SwitchResult {
  switched: boolean;
  /** Refused: other sessions hold the shared credential (re-call with force). */
  needsConfirm?: boolean;
  otherSessions?: number;
  backend?: string;
  refreshed?: boolean;
}

/** Runs pgrep. Its "no match" exit code 1 rejects; the counter treats that as none. */
const pgrepProbe: ProcessProbe = async (command, args) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)(command, args);
  return stdout;
};

/**
 * Count other live Claude Code sessions (best-effort; 0 when undetectable).
 * Covers both the native binary and `node …/claude-code/cli.js`.
 */
async function otherClaudeSessionCount(): Promise<number> {
  return countOtherClaudeSessions(pgrepProbe);
}

/**
 * Make a vault account the system-wide Claude Code login (Keychain/file swap,
 * same path as `swisscode accounts use`). Two-phase: returns needsConfirm
 * instead of moving other live sessions unless force is set.
 */
export async function switchSubscriptionAccount(id: string, force = false): Promise<SwitchResult> {
  const account = await vault.get(id);
  if (!account) throw new Error(`Unknown subscription account "${id}"`);
  // Ask about other sessions BEFORE touching the token: a refresh spends a
  // single-use rotation, and a refused switch must not have spent it.
  const otherSessions = await otherClaudeSessionCount();
  if (!force && otherSessions > 0) {
    return { switched: false, needsConfirm: true, otherSessions };
  }
  const { credential, refreshed } = await freshVaultCredential(vault, oauth, id, {
    liveStore: activeStore,
  });
  const before = await activeStore.readActive();
  await activeStore.writeActive(credential);
  return { switched: true, otherSessions, backend: before.backend, refreshed };
}

/** Identify the current Claude Code login; never exposes secrets. */
export async function getCurrentLogin(): Promise<CurrentLogin | null> {
  const active = await activeStore.readActive();
  if (!active.credential) return null;
  const email = await usageApi.fetchEmail(active.credential.accessToken);
  const matched = await findAccountByCredential(vault, active.credential);
  const matchedAccountId = matched?.id ?? null;
  return {
    backend: active.backend,
    source: active.source,
    email,
    matchedAccountId,
  };
}

// ---- Generic per-provider accounts (key-based providers) ----

export async function listProviderAccounts(providerId?: string): Promise<ProviderAccount[]> {
  return providerAccounts.list(providerId);
}

export interface ProviderAccountSummary {
  id: string;
  providerId: string;
  label: string;
  /** Secrets masked — safe to send to the client. */
  config: Record<string, string>;
}

/** Masked summaries for the UI; secrets never leave the server. */
export async function listProviderAccountSummaries(
  providerId?: string,
): Promise<ProviderAccountSummary[]> {
  const all = await providerAccounts.list(providerId);
  const registry = await providerRegistry();
  return all.map((a) => {
    const provider = registry.get(a.providerId);
    const secretKeys = new Set(
      (provider?.fields ?? []).filter((f) => f.secret).map((f) => f.key),
    );
    const config: Record<string, string> = {};
    for (const [key, value] of Object.entries(a.config)) {
      config[key] = secretKeys.has(key) || /key|token|secret/i.test(key) ? maskSecret(value) : value;
    }
    return { id: a.id, providerId: a.providerId, label: a.label, config };
  });
}

export async function saveProviderAccount(account: ProviderAccount): Promise<void> {
  validateAccountId(account.id);
  const provider = (await providerRegistry()).get(account.providerId);
  if (!provider) throw new Error(`Unknown provider "${account.providerId}"`);
  const missing = provider.fields
    .filter((f) => f.required)
    .map((f) => f.key)
    .filter((k) => !(account.config[k] ?? "").trim());
  if (missing.length > 0) throw new Error(`Missing required fields: ${missing.join(", ")}`);
  const now = new Date().toISOString();
  const prev = await providerAccounts.get(account.providerId, account.id);
  await providerAccounts.save({
    ...account,
    label: account.label.trim() || account.id,
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  });
}

export async function removeProviderAccount(providerId: string, id: string): Promise<void> {
  await providerAccounts.remove(providerId, id);
}

/**
 * Update label and/or config. Blank secret values — and values that are just
 * the mask the UI displayed — keep the stored secret; blank non-secrets clear
 * the field. Never receives or returns real secrets beyond the submitted form
 * values.
 */
export async function updateProviderAccount(
  providerId: string,
  id: string,
  patch: { label?: string; config?: Record<string, string> },
): Promise<void> {
  const prev = await providerAccounts.get(providerId, id);
  if (!prev) throw new Error(`Unknown ${providerId} account "${id}"`);
  const config = mergeAccountConfig(prev.config, patch.config, await secretKeysFor(providerId));
  await saveProviderAccount({
    ...prev,
    label: patch.label?.trim() || prev.label,
    config,
  });
}

/** Save (create or update) a user-defined provider; live immediately. */
export async function saveCustomProvider(def: CustomProviderDef): Promise<CustomProviderDef> {
  const stored = await customProviderStore.save(
    {
      ...def,
      displayName: def.displayName.trim(),
      description: def.description?.trim() || undefined,
      hint: def.hint?.trim() || undefined,
    },
    builtinProviderIds,
  );
  resetProviderRegistry();
  return stored;
}

/** Delete a custom provider. Refuses while accounts or profiles reference it. */
export async function removeCustomProvider(id: string): Promise<boolean> {
  const def = await customProviderStore.get(id);
  if (!def) return false;
  const accounts = await providerAccounts.list(id);
  if (accounts.length > 0) {
    throw new Error(
      `Provider "${id}" still has ${accounts.length} stored account(s) — remove them first.`,
    );
  }
  const profilesUsing = (await profiles.list()).filter((p) => p.providerId === id);
  if (profilesUsing.length > 0) {
    throw new Error(
      `Provider "${id}" is still used by profile(s) ${profilesUsing.map((p) => `"${p.name}"`).join(", ")} — repoint them first.`,
    );
  }
  const removed = await customProviderStore.remove(id);
  resetProviderRegistry();
  return removed;
}

// ---- Config backup/restore (one registry entry per store) ----

/** Live record counts per bundled store (settings inventory). */
export async function getBundleInventory(): Promise<Record<string, number>> {
  return bundles.inventory();
}

/** Full config bundle. Secrets included only when asked. */
export async function exportConfigBundle(includeSecrets: boolean): Promise<ConfigBundle> {
  return bundles.exportBundle(includeSecrets, "web-ui");
}

/** Restore a bundle. Per-record results; never throws on bad records. */
export async function importConfigBundle(
  bundle: unknown,
  overwrite: boolean,
): Promise<StoreImportResult[]> {
  const results = await bundles.importBundle(bundle, { overwrite });
  resetProviderRegistry();
  return results;
}

export interface ProviderUsageResult {
  accountId: string;
  metrics?: { label: string; value: string }[];
  error?: string;
}

export interface ProviderModelsResult {
  models: ProviderModel[];
  fetchedAt: string;
  stale: boolean;
}

/** Model list for pickers; throws when the provider publishes none. */
export async function getProviderModels(providerId: string): Promise<ProviderModelsResult> {
  const catalog = modelCatalogs.find((c) => c.providerId === providerId);
  if (!catalog) throw new Error(`No model catalog for provider "${providerId}".`);
  return catalog.snapshot();
}

export interface ProviderModelEndpointsResult {
  endpoints: ModelEndpoint[];
  fetchedAt: string;
  stale: boolean;
}

/** Serving providers for one model; throws when the provider lists none. */
export async function getProviderModelEndpoints(
  providerId: string,
  modelId: string,
): Promise<ProviderModelEndpointsResult> {
  const catalog = modelCatalogs.find((c) => c.providerId === providerId);
  if (!catalog) throw new Error(`No model catalog for provider "${providerId}".`);
  return catalog.endpoints(modelId);
}

export async function getProviderUsage(providerId: string): Promise<ProviderUsageResult[]> {
  const reader = usageReaders.find((r) => r.providerId === providerId);
  const all = await providerAccounts.list(providerId);
  if (!reader) return all.map((a) => ({ accountId: a.id, error: "No usage API for this provider." }));
  const out: ProviderUsageResult[] = [];
  for (const account of all) {
    try {
      const snapshot = await reader.readUsage(account);
      out.push({ accountId: account.id, metrics: snapshot.metrics });
    } catch (err) {
      out.push({ accountId: account.id, error: (err as Error).message });
    }
  }
  return out;
}
