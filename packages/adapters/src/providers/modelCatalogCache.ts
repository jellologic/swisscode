// Adapter: file-backed model-catalog cache + stale-while-revalidate decorator.
// Model lists change slowly but pickers render often; without a cache every
// /accounts render would hit the provider. Within the TTL the file is served
// without touching the network; past it we refetch, and on failure serve the
// last-good list labeled stale instead of erroring the picker.
// Per-model endpoint (serving provider) lists are cached the same way under
// `endpoints/<provider>/<model>` keys.

import { join } from "node:path";
import { homedir } from "node:os";
import type { ModelEndpoint, ProviderModel, ProviderModelCatalog } from "@swisscode/core";
import { readJsonOrDefault, withStoreLock, writeJsonAtomic } from "../store/atomicJson.js";

export interface ModelCatalogCacheEntry {
  models: ProviderModel[];
  /** ISO timestamp of the last successful fetch. */
  fetchedAt: string;
}

export interface ModelEndpointsCacheEntry {
  endpoints: ModelEndpoint[];
  /** ISO timestamp of the last successful fetch. */
  fetchedAt: string;
}

/** Model lists change slowly; 6h keeps pickers fresh without hammering. */
export const DEFAULT_MODEL_CACHE_TTL_MS = 6 * 3600 * 1000;

export function defaultModelCatalogCachePath(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "model-catalog-cache.json");
}

export class FileModelCatalogCache {
  constructor(private readonly path: string = defaultModelCatalogCachePath()) {}

  private async readAll(): Promise<Record<string, unknown>> {
    const parsed = await readJsonOrDefault<unknown>(this.path, {});
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  }

  private async writeAll(all: Record<string, unknown>): Promise<void> {
    await writeJsonAtomic(this.path, all, { keepBackup: true });
  }

  /**
   * Every setter is a read-modify-write over one shared file: caching a model
   * list and an endpoint list at the same time would otherwise drop one of them.
   */
  private async update(mutate: (all: Record<string, unknown>) => void): Promise<void> {
    await withStoreLock(this.path, async () => {
      const all = await this.readAll();
      mutate(all);
      await this.writeAll(all);
    });
  }

  async get(providerId: string): Promise<ModelCatalogCacheEntry | undefined> {
    const entry = (await this.readAll())[providerId];
    if (!entry || typeof entry !== "object") return undefined;
    const rec = entry as Record<string, unknown>;
    if (!Array.isArray(rec["models"]) || typeof rec["fetchedAt"] !== "string") return undefined;
    return rec as unknown as ModelCatalogCacheEntry;
  }

  async set(providerId: string, entry: ModelCatalogCacheEntry): Promise<void> {
    await this.update((all) => {
      all[providerId] = entry;
    });
  }

  async getEndpoints(
    providerId: string,
    modelId: string,
  ): Promise<ModelEndpointsCacheEntry | undefined> {
    const entry = (await this.readAll())[this.endpointsKey(providerId, modelId)];
    if (!entry || typeof entry !== "object") return undefined;
    const rec = entry as Record<string, unknown>;
    if (!Array.isArray(rec["endpoints"]) || typeof rec["fetchedAt"] !== "string") return undefined;
    return rec as unknown as ModelEndpointsCacheEntry;
  }

  async setEndpoints(
    providerId: string,
    modelId: string,
    entry: ModelEndpointsCacheEntry,
  ): Promise<void> {
    await this.update((all) => {
      all[this.endpointsKey(providerId, modelId)] = entry;
    });
  }

  private endpointsKey(providerId: string, modelId: string): string {
    return `endpoints/${providerId}/${modelId}`;
  }
}

export interface ModelCatalogSnapshot {
  models: ProviderModel[];
  fetchedAt: string;
  /** True when served from cache because the live fetch failed. */
  stale: boolean;
}

export interface ModelEndpointsSnapshot {
  endpoints: ModelEndpoint[];
  fetchedAt: string;
  /** True when served from cache because the live fetch failed. */
  stale: boolean;
}

export interface CachingModelCatalogOptions {
  ttlMs?: number;
  now?: () => number;
}

interface CachedResult {
  data: unknown;
  fetchedAt: string;
  stale: boolean;
}

export class CachingModelCatalog implements ProviderModelCatalog {
  readonly providerId: string;
  /** In-flight fetches, so concurrent renders share one upstream request. */
  private readonly inflight = new Map<string, Promise<CachedResult>>();

  constructor(
    private readonly inner: ProviderModelCatalog,
    private readonly cache: FileModelCatalogCache,
    private readonly options: CachingModelCatalogOptions = {},
  ) {
    this.providerId = inner.providerId;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private ttlMs(): number {
    return this.options.ttlMs ?? DEFAULT_MODEL_CACHE_TTL_MS;
  }

  async listModels(config?: Record<string, string>): Promise<ProviderModel[]> {
    return (await this.snapshot(config)).models;
  }

  async snapshot(config?: Record<string, string>): Promise<ModelCatalogSnapshot> {
    const result = await this.cached(
      `models/${this.providerId}`,
      async () => {
        const cached = await this.cache.get(this.providerId);
        return cached ? { data: cached.models, fetchedAt: cached.fetchedAt } : undefined;
      },
      async () => this.inner.listModels(config),
      async (models, fetchedAt) => this.cache.set(this.providerId, { models, fetchedAt }),
    );
    return { models: result.data as ProviderModel[], fetchedAt: result.fetchedAt, stale: result.stale };
  }

  async listEndpoints(modelId: string, config?: Record<string, string>): Promise<ModelEndpoint[]> {
    return (await this.endpoints(modelId, config)).endpoints;
  }

  async endpoints(modelId: string, config?: Record<string, string>): Promise<ModelEndpointsSnapshot> {
    if (!this.inner.listEndpoints) {
      throw new Error(`No endpoint catalog for provider "${this.providerId}".`);
    }
    const fetchEndpoints = this.inner.listEndpoints.bind(this.inner);
    const result = await this.cached(
      `endpoints/${this.providerId}/${modelId}`,
      async () => {
        const cached = await this.cache.getEndpoints(this.providerId, modelId);
        return cached ? { data: cached.endpoints, fetchedAt: cached.fetchedAt } : undefined;
      },
      () => fetchEndpoints(modelId, config),
      async (endpoints, fetchedAt) =>
        this.cache.setEndpoints(this.providerId, modelId, { endpoints, fetchedAt }),
    );
    return {
      endpoints: result.data as ModelEndpoint[],
      fetchedAt: result.fetchedAt,
      stale: result.stale,
    };
  }

  private async cached<T>(
    key: string,
    read: () => Promise<{ data: T; fetchedAt: string } | undefined>,
    fetch: () => Promise<T>,
    write: (data: T, fetchedAt: string) => Promise<void>,
  ): Promise<{ data: T; fetchedAt: string; stale: boolean }> {
    const fromCache = await read();
    const ageMs = fromCache ? this.now() - new Date(fromCache.fetchedAt).getTime() : Infinity;
    if (fromCache && ageMs < this.ttlMs()) {
      return { ...fromCache, stale: false };
    }
    const running = this.inflight.get(key);
    if (running) return (await running) as { data: T; fetchedAt: string; stale: boolean };
    const pending = (async (): Promise<CachedResult> => {
      try {
        const data = await fetch();
        const fetchedAt = new Date(this.now()).toISOString();
        await write(data, fetchedAt);
        return { data, fetchedAt, stale: false };
      } catch (err) {
        if (fromCache) {
          return { data: fromCache.data, fetchedAt: fromCache.fetchedAt, stale: true };
        }
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, pending);
    return (await pending) as { data: T; fetchedAt: string; stale: boolean };
  }
}
