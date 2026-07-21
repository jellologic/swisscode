import { createOpenRouterCatalog } from './openrouter.js'
import { createModelScopeCatalog } from './modelscope.js'

const FACTORIES = Object.freeze({
  openrouter: createOpenRouterCatalog,
  modelscope: createModelScopeCatalog,
})

export const CATALOG_IDS = Object.freeze(Object.keys(FACTORIES))

/**
 * Catalogs are constructed lazily and memoized: a wizard run that never opens a
 * picker should build no clock, no net port and no cache.
 */
export function createCatalogRegistry(deps) {
  const built = new Map()
  return {
    ids: () => CATALOG_IDS,
    has: (id) => Object.prototype.hasOwnProperty.call(FACTORIES, id),
    byId(id) {
      if (!id || !Object.prototype.hasOwnProperty.call(FACTORIES, id)) return null
      if (!built.has(id)) built.set(id, FACTORIES[id](deps))
      return built.get(id)
    },
  }
}
