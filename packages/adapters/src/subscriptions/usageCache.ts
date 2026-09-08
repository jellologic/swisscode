// Adapter: last-good usage cache + stale-while-revalidate decorator.
// The usage endpoint 429s under load; every page render refetching every
// account guarantees hammering. This keeps the last successful snapshot per
// account, serves it labeled stale on failure, and honors Retry-After so a
// rate-limited account isn't re-polled in a tight loop.
//
// Two properties the file itself has to guarantee:
// - One shared JSON file is read-modify-written by the proxy, the CLI and the
//   web UI at once. Writes go through writeJsonAtomic (no torn file), and the
//   read-modify-write is serialized per path so a concurrent `set` — even from
//   another FileUsageCache instance — cannot drop an entry it never saw.
// - Entries are keyed by account id AND login identity (the email recorded at
//   import), by default and without the caller opting in. Deleting an account
//   and re-importing a DIFFERENT login under the same id would otherwise show
//   the previous login's utilization as if it were live. The refresh token is
//   deliberately NOT the identity: it rotates on every refresh, which would
//   drop the last-good snapshot and the 429 cooldown each time and leave one
//   orphaned entry per rotation.

import { join } from "node:path";
import { homedir } from "node:os";
import type { AccountRepository, AccountUsage, UsageClient } from "@swisscode/core";
import { isRecord } from "@swisscode/core";
import { readJsonFile, withStoreLock, writeJsonAtomic } from "../store/atomicJson.js";
import { FileAccountRepository, defaultSubscriptionsDir } from "./accountVault.js";
import { UsageError } from "./anthropic.js";

export interface UsageCacheEntry {
  snapshot?: AccountUsage;
  /** Epoch ms before which no refetch should be attempted (Retry-After). */
  notBeforeMs?: number;
}

/** Cooldown applied when the server 429s without a Retry-After header. */
export const DEFAULT_429_BACKOFF_MS = 5 * 60 * 1000;

export function defaultUsageCachePath(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "usage-cache.json");
}

/** Cache key: same id + different login must not share a snapshot. */
export function usageCacheKey(accountId: string, identity?: string): string {
  return identity ? `${accountId}#${identity}` : accountId;
}

/**
 * Identity resolver over the vault, for {@link CachingUsageOptions}: the login
 * email the account was imported with. Stable across token rotation, different
 * for a different login re-imported under the same id. An account with no
 * recorded email degrades to the id-only key.
 */
export function vaultIdentityResolver(
  accounts: AccountRepository,
): (accountId: string) => Promise<string | undefined> {
  return async (accountId: string) => {
    const account = await accounts.get(accountId).catch(() => undefined);
    const email = account?.email?.trim().toLowerCase();
    return email ? `email:${email}` : undefined;
  };
}

/** Account id part of a cache key (`id` or `id#identity`). */
function keyAccountId(key: string): string {
  return key.split("#", 1)[0] ?? key;
}

/**
 * The resolver used when a caller passes no options — identity keying has to
 * be the default, or the shipped wiring (`new CachingUsageClient(api, cache)`
 * in the CLI and the web server) silently keys on the id alone again.
 * The vault handle is built per call because those two call sites construct
 * the client at module load, before a test or a wrapper has set SWISSCODE_HOME.
 */
export function defaultVaultIdentity(accountId: string): Promise<string | undefined> {
  return vaultIdentityResolver(new FileAccountRepository(defaultSubscriptionsDir()))(accountId);
}

export class FileUsageCache {
  constructor(private readonly path: string = defaultUsageCachePath()) {}

  private async readAll(): Promise<Record<string, UsageCacheEntry>> {
    const read = await readJsonFile<unknown>(this.path);
    // A cache is regenerable: a corrupt file is worth nothing but must never
    // take down usage display, so it is simply overwritten on the next set.
    if (!read.ok) return {};
    return isRecord(read.value) ? (read.value as Record<string, UsageCacheEntry>) : {};
  }

  async get(key: string): Promise<UsageCacheEntry | undefined> {
    return (await this.readAll())[key];
  }

  async set(key: string, entry: UsageCacheEntry): Promise<void> {
    // Every set is a read-modify-write over one shared file. withStoreLock keys
    // on the path, so it also serializes two FileUsageCache instances pointed at
    // the same file — a per-instance promise chain would not.
    return withStoreLock(this.path, async () => {
      const all = await this.readAll();
      // One live entry per account: a key for the same id under another
      // identity is a previous login (or the pre-identity id-only key), and
      // keeping it would both leak the old numbers and grow the file forever.
      const id = keyAccountId(key);
      for (const existing of Object.keys(all)) {
        if (existing !== key && keyAccountId(existing) === id) delete all[existing];
      }
      all[key] = entry;
      await writeJsonAtomic(this.path, all);
    });
  }
}

export interface CachingUsageOptions {
  now?: () => number;
  /**
   * Stable identity of the account's current credential. Defaults to
   * {@link defaultVaultIdentity}; override only to point at a vault that is
   * not the one under SWISSCODE_HOME (or, in tests, at a fixed identity).
   */
  accountIdentity?: (accountId: string) => Promise<string | undefined>;
}

/**
 * UsageClient decorator: success caches fresh; 429/transient/5xx falls back
 * to the cached snapshot labeled stale; 401/403 (auth is dead) always throws.
 * While inside a Retry-After window the network isn't touched at all.
 */
export class CachingUsageClient implements UsageClient {
  constructor(
    private readonly inner: UsageClient,
    private readonly cache: FileUsageCache,
    private readonly options: CachingUsageOptions = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async key(accountId: string): Promise<string> {
    const resolve = this.options.accountIdentity ?? defaultVaultIdentity;
    // An identity we cannot resolve degrades to the id-only key rather than
    // failing a usage read: it means the vault has no credential for this id,
    // so there is no second login whose numbers could be confused with it.
    const identity = await resolve(accountId).catch(() => undefined);
    return usageCacheKey(accountId, identity);
  }

  async fetchUsage(accountId: string, accessToken: string): Promise<AccountUsage> {
    const key = await this.key(accountId);
    const cached = await this.cache.get(key);
    if (cached?.notBeforeMs !== undefined && cached.notBeforeMs > this.now()) {
      if (cached.snapshot) return { ...cached.snapshot, stale: true };
      throw new UsageError("Usage endpoint is rate-limited; retry in a few minutes.", 429);
    }
    try {
      const fresh = await this.inner.fetchUsage(accountId, accessToken);
      const snapshot = { ...fresh, stale: false };
      await this.cache.set(key, { snapshot });
      return snapshot;
    } catch (err) {
      if (err instanceof UsageError && (err.status === 401 || err.status === 403)) throw err;
      const backoff =
        err instanceof UsageError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : DEFAULT_429_BACKOFF_MS;
      if (cached?.snapshot) {
        await this.cache.set(key, {
          snapshot: cached.snapshot,
          notBeforeMs: this.now() + backoff,
        });
        return { ...cached.snapshot, stale: true };
      }
      // Nothing to serve: record the cooldown so we stop hammering anyway.
      await this.cache.set(key, { notBeforeMs: this.now() + backoff });
      throw err;
    }
  }
}
