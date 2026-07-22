import type { ClockPort } from '../../ports/clock.ts'
import type {
  CatalogCapabilities,
  CatalogListOptions,
  CatalogResult,
  ModelCacheStorePort,
  ModelCatalogPort,
} from '../../ports/catalog.ts'
import type { NetPort } from '../../ports/net.ts'
import { isStale, rank, sanitizeModels } from '../../core/catalog.ts'

/**
 * What a catalog adapter turns an upstream body into.
 *
 * `unknown[]`, NOT `NormalizedModel[]`, and that asymmetry is the honest part.
 * A normalizer is a best-effort reshaping of third-party JSON; it is
 * `sanitizeModels` below that decides whether a row is a `NormalizedModel`, by
 * checking every field of the port type. Declaring the normalizer's output as
 * already-normalized would assert something no normalizer proves — and would
 * make the `sanitizeModels` call look redundant when it is the only reason the
 * pipeline is safe.
 *
 * The two shipped normalizers differ in how much they DO prove, and the types
 * say so: `normalizeModelScope` returns `NormalizedModel[]` (it validates `id`
 * and hard-codes every other field), while `normalizeOpenRouter` returns
 * candidate rows whose `id`, `name`, `description`, `context` and `maxOutput`
 * are still `unknown`. Both are assignable here; only one claims more.
 */
export type CatalogNormalizer = (body: unknown) => unknown[]

/** The ports a network-backed catalog is built from. */
export type CatalogDeps = {
  net: NetPort
  cache?: ModelCacheStorePort | null | undefined
  clock: ClockPort
}

export type CachedCatalogOptions = CatalogDeps & {
  id: string
  label: string
  capabilities: CatalogCapabilities
  endpoint: string
  headers?: Record<string, string>
  normalize: CatalogNormalizer
}

/**
 * Shared plumbing for a network catalog with a 24h on-disk cache.
 *
 * `list()` never throws — that contract is what lets the picker work offline
 * with a warm cache and degrade to typing an id by hand with a cold one. It is
 * enforced by the return type: `Promise<CatalogResult>` carries `error`, so a
 * failure has somewhere to go that is not an exception.
 */
export function createCachedCatalog({
  id,
  label,
  capabilities,
  endpoint,
  headers = {},
  normalize,
  net,
  cache,
  clock,
}: CachedCatalogOptions): ModelCatalogPort {
  async function list({ force = false }: CatalogListOptions = {}): Promise<CatalogResult> {
    const cached = cache?.read(id) ?? null
    // A#8: anything that is not a sane past timestamp counts as stale, so a
    // hand-edited or clock-skewed fetchedAt cannot pin the cache as fresh.
    const cachedModels = cached ? sanitizeModels(cached.models) : []
    const cachedUsable = cachedModels.length > 0
    // `cached !== null` is provably redundant: `cachedModels` is `[]` whenever
    // `cached` is null, so `cachedUsable` already implies it. It is a guard
    // rather than an assertion because a guard cannot be wrong, and it sits
    // AFTER `cachedUsable` so the short-circuit order is unchanged.
    const fresh = cachedUsable && cached !== null && !isStale(cached.fetchedAt, clock.now())

    if (!force && fresh) {
      return { models: cachedModels, fromCache: true, stale: false, error: null }
    }

    try {
      const body = await net.getJson(endpoint, { headers })
      // `sanitizeModels` is what turns candidate rows into NormalizedModel[].
      // It is not belt-and-braces over the normalizer: the normalizer is
      // typed as producing `unknown[]` precisely because this is the check.
      const models = sanitizeModels(normalize(body)).sort(rank)
      if (models.length === 0) throw new Error('catalog returned no usable models')
      cache?.write(id, models)
      return { models, fromCache: false, stale: false, error: null }
    } catch (err) {
      // Property read (not `instanceof Error`); see `errMessage` in
      // fs-config-store.ts. `?? null` keeps `CatalogResult.error` as
      // `string | null` when a throw carries no `.message`.
      const message = (err as { message?: string }).message ?? null
      if (cachedUsable) {
        return { models: cachedModels, fromCache: true, stale: true, error: message }
      }
      return { models: [], fromCache: false, stale: false, error: message }
    }
  }

  return { id, label, capabilities: Object.freeze(capabilities), list }
}
