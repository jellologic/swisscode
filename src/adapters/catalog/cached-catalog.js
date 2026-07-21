import { isStale, rank, sanitizeModels } from '../../core/catalog.js'

/**
 * Shared plumbing for a network catalog with a 24h on-disk cache.
 *
 * `list()` never throws — that contract is what lets the picker work offline
 * with a warm cache and degrade to typing an id by hand with a cold one.
 *
 * @returns {import('../../ports/catalog.js').ModelCatalogPort}
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
}) {
  async function list({ force = false } = {}) {
    const cached = cache?.read(id) ?? null
    // A#8: anything that is not a sane past timestamp counts as stale, so a
    // hand-edited or clock-skewed fetchedAt cannot pin the cache as fresh.
    const cachedModels = cached ? sanitizeModels(cached.models) : []
    const cachedUsable = cachedModels.length > 0
    const fresh = cachedUsable && !isStale(cached.fetchedAt, clock.now())

    if (!force && fresh) {
      return { models: cachedModels, fromCache: true, stale: false, error: null }
    }

    try {
      const body = await net.getJson(endpoint, { headers })
      const models = sanitizeModels(normalize(body)).sort(rank)
      if (models.length === 0) throw new Error('catalog returned no usable models')
      cache?.write(id, models)
      return { models, fromCache: false, stale: false, error: null }
    } catch (err) {
      if (cachedUsable) {
        return { models: cachedModels, fromCache: true, stale: true, error: err.message }
      }
      return { models: [], fromCache: false, stale: false, error: err.message }
    }
  }

  return { id, label, capabilities: Object.freeze(capabilities), list }
}
