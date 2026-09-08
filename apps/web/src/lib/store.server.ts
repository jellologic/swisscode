// Server-only data access. The `.server.` suffix keeps node:fs + API keys
// out of the client bundle. All domain logic goes through @swisscode/core.

import {
  AnthropicOAuthClient,
  AnthropicUsageClient,
  CachingModelCatalog,
  CachingUsageClient,
  ClaudeActiveCredentialStore,
  CustomAccountValidator,
  DEFAULT_PROXY_PORT,
  FileAccountRepository,
  FileCustomProviderStore,
  FileModelCatalogCache,
  FileProfileRepository,
  FileProviderAccountRepository,
  liveResyncHook,
  FileUsageCache,
  OpenRouterAccountValidator,
  OpenRouterModelCatalog,
  OpenRouterUsageReader,
  createBundleRegistry,
  defaultProviders,
  findAccountByCredential,
  loadCustomProviderPorts,
  createAgentRegistry,
  createProviderRegistry,
  defaultProfilesPath,
  maskSecret,
  groupTrafficConversations,
  summarizeTrafficEntry,
  type ProxyTrafficEntry,
  type SessionContext,
  type TrafficConversation,
  type TrafficSummary,
} from "@swisscode/adapters";
import {
  ensureFreshCredential,
  resolveLaunchSpec,
  resolveProviderConfig,
  validateAccountId,
  validateProfile,
  type AccountValidation,
  type AccountUsage,
  type ConfigBundle,
  type CustomProviderDef,
  type FieldDef,
  type ModelEndpoint,
  type PluginHelp,
  type Profile,
  type ProviderAccount,
  type ProviderAccountCapabilities,
  type ProviderAccountValidator,
  type ProviderModel,
  type ProviderRegistry,
  type StoreImportResult,
  type SubscriptionAccount,
} from "@swisscode/core";

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
/** Adopt Claude Code's live lineage when the vault refresh token rotated away. */
const resync = liveResyncHook({ accounts: vault, oauth, live: activeStore });
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

/** Stored as-is (secrets live in ~/.swisscode, same machine as the CLI). */
export async function saveProfile(profile: Profile): Promise<void> {
  validateProfile(profile);
  await profiles.save(profile);
}

export async function deleteProfile(name: string): Promise<void> {
  await profiles.remove(name);
}

/** Resolve a profile to its launch spec, with secrets redacted. */
export async function previewProfile(name: string) {
  const stored = await profiles.get(name);
  if (!stored) throw new Error(`Unknown profile "${name}"`);
  let profile = stored;
  if (stored.providerAccountId) {
    const account = await providerAccounts.get(stored.providerId, stored.providerAccountId);
    profile = resolveProviderConfig(stored, () => account ?? undefined);
  }
  const spec = resolveLaunchSpec(agents, await providerRegistry(), profile);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(spec.env)) {
    env[k] = /TOKEN|KEY|SECRET/i.test(k) && v ? "***redacted***" : v;
  }
  return { command: spec.command, args: spec.args, env };
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

function proxyPort(): number {
  const raw = process.env["SWISSCODE_PROXY_PORT"];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PROXY_PORT;
}

function proxyBase(): string {
  return `http://127.0.0.1:${proxyPort()}`;
}

export async function getProxyState(): Promise<ProxyState> {
  const port = proxyPort();
  try {
    const res = await fetch(`${proxyBase()}/__swisscode/status`);
    if (!res.ok) return { running: false, activeAccountId: null, port };
    const body = (await res.json()) as { activeAccountId?: string | null };
    return { running: true, activeAccountId: body.activeAccountId ?? null, port };
  } catch {
    return { running: false, activeAccountId: null, port };
  }
}

export async function useProxyAccount(id: string): Promise<void> {
  const res = await fetch(`${proxyBase()}/__swisscode/use/${id}`, { method: "POST" }).catch(() => {
    throw new Error("Proxy is not running. Start it with `swisscode proxy run`.");
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Proxy returned HTTP ${res.status}`);
  }
}

export interface ProxyTrafficItem extends ProxyTrafficEntry {
  summary: TrafficSummary;
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

/** Buffered proxy traffic (newest first), each with a plain-English summary. Never throws. */
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
    const url =
      profile !== undefined && profile !== ""
        ? `${proxyBase()}/__swisscode/traffic?profile=${encodeURIComponent(profile)}`
        : `${proxyBase()}/__swisscode/traffic`;
    const res = await fetch(url);
    if (!res.ok) return empty;
    const body = (await res.json()) as {
      entries?: ProxyTrafficEntry[];
      kept?: number;
      size?: number;
      profiles?: string[];
    };
    const entries = (body.entries ?? []).map((entry) => ({
      ...entry,
      summary: summarizeTrafficEntry(entry),
    }));
    return {
      running: true,
      entries,
      conversations: groupTrafficConversations(
        entries.map((entry) => ({ entry, summary: entry.summary })),
      ),
      kept: body.kept ?? 0,
      size: body.size ?? 0,
      profiles: body.profiles ?? [],
    };
  } catch {
    return empty;
  }
}

/**
 * Local Claude Code session behind a thread (transcript prompts, Workflow
 * scripts, subagent branches). Null when the proxy is down or the session
 * is not on this machine. Never throws.
 */
export async function getSessionContext(sessionId: string): Promise<SessionContext | null> {
  try {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) return null;
    const res = await fetch(`${proxyBase()}/__swisscode/session/${sessionId}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { context?: SessionContext | null };
    return body.context ?? null;
  } catch {
    return null;
  }
}

export async function clearProxyTraffic(): Promise<{ cleared: number }> {
  const res = await fetch(`${proxyBase()}/__swisscode/traffic`, { method: "DELETE" }).catch(() => {
    throw new Error("Proxy is not running. Start it with `swisscode proxy run`.");
  });
  if (!res.ok) throw new Error(`Proxy returned HTTP ${res.status}`);
  const body = (await res.json()) as { cleared?: number };
  return { cleared: body.cleared ?? 0 };
}

export async function setProxyTrafficSize(size: number): Promise<{ size: number; kept: number }> {
  const n = Math.min(10000, Math.max(0, Math.floor(size)));
  const res = await fetch(`${proxyBase()}/__swisscode/traffic/size/${n}`, { method: "POST" }).catch(() => {
    throw new Error("Proxy is not running. Start it with `swisscode proxy run`.");
  });
  if (!res.ok) throw new Error(`Proxy returned HTTP ${res.status}`);
  const body = (await res.json()) as { size?: number; kept?: number };
  return { size: body.size ?? n, kept: body.kept ?? 0 };
}

/** Live usage per account; never throws — errors are reported per account. */
export async function getUsage(ids?: string[]): Promise<UsageResult[]> {
  const targets = ids ?? (await vault.list()).map((a) => a.id);
  const out: UsageResult[] = [];
  for (const accountId of targets) {
    try {
      const { credential } = await ensureFreshCredential(vault, oauth, accountId, {
        onInvalidGrant: resync,
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

/** Count other live `claude` processes (best-effort; 0 when undetectable). */
async function otherClaudeSessionCount(): Promise<number> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(execFile)("pgrep", ["-x", "claude"]);
    const mine = String(process.pid);
    return stdout.split("\n").filter((line) => line.trim() && line.trim() !== mine).length;
  } catch {
    return 0;
  }
}

/**
 * Make a vault account the system-wide Claude Code login (Keychain/file swap,
 * same path as `swisscode accounts use`). Two-phase: returns needsConfirm
 * instead of moving other live sessions unless force is set.
 */
export async function switchSubscriptionAccount(id: string, force = false): Promise<SwitchResult> {
  const account = await vault.get(id);
  if (!account) throw new Error(`Unknown subscription account "${id}"`);
  const { credential, refreshed } = await ensureFreshCredential(vault, oauth, id, {
    onInvalidGrant: resync,
  });
  const otherSessions = await otherClaudeSessionCount();
  if (!force && otherSessions > 0) {
    return { switched: false, needsConfirm: true, otherSessions };
  }
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
 * Update label and/or config. Blank secret values keep the stored secret;
 * blank non-secrets clear the field. Never receives or returns real secrets
 * beyond the submitted form values.
 */
export async function updateProviderAccount(
  providerId: string,
  id: string,
  patch: { label?: string; config?: Record<string, string> },
): Promise<void> {
  const prev = await providerAccounts.get(providerId, id);
  if (!prev) throw new Error(`Unknown ${providerId} account "${id}"`);
  const provider = (await providerRegistry()).get(providerId);
  const secretKeys = new Set(
    (provider?.fields ?? []).filter((f) => f.secret).map((f) => f.key),
  );
  const config = { ...prev.config };
  for (const [key, value] of Object.entries(patch.config ?? {})) {
    if (value === "" && secretKeys.has(key)) continue; // blank secret = keep
    if (value === "") delete config[key];
    else config[key] = value;
  }
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
