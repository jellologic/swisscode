// Adapter: last-good usage cache + stale-while-revalidate decorator.
// The usage endpoint 429s under load; every page render refetching every
// account guarantees hammering. This keeps the last successful snapshot per
// account, serves it labeled stale on failure, and honors Retry-After so a
// rate-limited account isn't re-polled in a tight loop.
//
// Two properties the file itself has to guarantee:
// - One shared JSON file is read-modify-written by the proxy, the CLI and the
//   web UI at once. Writes go through writeJsonAtomic (no torn file), and the
//   read-modify-write is serialized per instance so a concurrent `set` cannot
//   drop the other account's entry it never saw.
// - Entries are keyed by account id AND credential identity. Deleting an
//   account and re-importing a DIFFERENT login under the same id would
//   otherwise show the previous login's utilization as if it were live.

import { join } from "node:path";
import { homedir } from "node:os";
import type { AccountRepository, AccountUsage, UsageClient } from "@swisscode/core";
import { isRecord } from "@swisscode/core";
import { readJsonFile, withStoreLock, writeJsonAtomic } from "../store/atomicJson.js";
import { credentialIdentity } from "./identity.js";
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

/** Identity resolver over the vault, for {@link CachingUsageOptions}. */
export function vaultIdentityResolver(
  accounts: AccountRepository,
): (accountId: string) => Promise<string | undefined> {
  return async (accountId: string) => {
    const credential = await accounts.loadCredential(accountId).catch(() => undefined);
    return credential ? credentialIdentity(credential) : undefined;
  };
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
      all[key] = entry;
      await writeJsonAtomic(this.path, all);
    });
  }
}

export interface CachingUsageOptions {
  now?: () => number;
  /**
   * Stable identity of the account's current credential (see
   * {@link vaultIdentityResolver}). Without it entries key on the id alone.
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
    if (!this.options.accountIdentity) return usageCacheKey(accountId);
    // An identity we cannot resolve degrades to the id-only key rather than
    // failing a usage read.
    const identity = await this.options.accountIdentity(accountId).catch(() => undefined);
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
