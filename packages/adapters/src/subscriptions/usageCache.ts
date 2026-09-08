// Adapter: last-good usage cache + stale-while-revalidate decorator.
// The usage endpoint 429s under load; every page render refetching every
// account guarantees hammering. This keeps the last successful snapshot per
// account, serves it labeled stale on failure, and honors Retry-After so a
// rate-limited account isn't re-polled in a tight loop.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AccountUsage, UsageClient } from "@swisscode/core";
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

export class FileUsageCache {
  constructor(private readonly path: string = defaultUsageCachePath()) {}

  private async readAll(): Promise<Record<string, UsageCacheEntry>> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (parsed && typeof parsed === "object") return parsed as Record<string, UsageCacheEntry>;
      return {};
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return {};
      throw err;
    }
  }

  async get(accountId: string): Promise<UsageCacheEntry | undefined> {
    return (await this.readAll())[accountId];
  }

  async set(accountId: string, entry: UsageCacheEntry): Promise<void> {
    const all = await this.readAll();
    all[accountId] = entry;
    await mkdir(join(this.path, ".."), { recursive: true });
    await writeFile(this.path, JSON.stringify(all, null, 2), "utf8");
  }
}

export interface CachingUsageOptions {
  now?: () => number;
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

  async fetchUsage(accountId: string, accessToken: string): Promise<AccountUsage> {
    const cached = await this.cache.get(accountId);
    if (cached?.notBeforeMs !== undefined && cached.notBeforeMs > this.now()) {
      if (cached.snapshot) return { ...cached.snapshot, stale: true };
      throw new UsageError("Usage endpoint is rate-limited; retry in a few minutes.", 429);
    }
    try {
      const fresh = await this.inner.fetchUsage(accountId, accessToken);
      const snapshot = { ...fresh, stale: false };
      await this.cache.set(accountId, { snapshot });
      return snapshot;
    } catch (err) {
      if (err instanceof UsageError && (err.status === 401 || err.status === 403)) throw err;
      const backoff =
        err instanceof UsageError && err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : DEFAULT_429_BACKOFF_MS;
      if (cached?.snapshot) {
        await this.cache.set(accountId, {
          snapshot: cached.snapshot,
          notBeforeMs: this.now() + backoff,
        });
        return { ...cached.snapshot, stale: true };
      }
      // Nothing to serve: record the cooldown so we stop hammering anyway.
      await this.cache.set(accountId, { notBeforeMs: this.now() + backoff });
      throw err;
    }
  }
}
