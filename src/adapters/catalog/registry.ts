import type { CatalogRegistryPort, ModelCatalogPort } from '../../ports/catalog.ts'
import type { CatalogDeps } from './cached-catalog.ts'
import { createOpenRouterCatalog } from './openrouter.ts'
import { createModelScopeCatalog } from './modelscope.ts'
import { createOllamaCatalog } from './ollama.ts'

const FACTORIES = Object.freeze({
  openrouter: createOpenRouterCatalog,
  modelscope: createModelScopeCatalog,
  ollama: createOllamaCatalog,
})

/** The ids this build ships a catalog for, derived from the table itself. */
export type CatalogId = keyof typeof FACTORIES

export const CATALOG_IDS: readonly string[] = Object.freeze(Object.keys(FACTORIES))

/** Narrows so `FACTORIES[id]` is a checked index under noUncheckedIndexedAccess. */
function isCatalogId(id: string): id is CatalogId {
  return Object.prototype.hasOwnProperty.call(FACTORIES, id)
}

/**
 * Catalogs are constructed lazily and memoized: a wizard run that never opens a
 * picker should build no clock, no net port and no cache.
 */
export function createCatalogRegistry(deps: CatalogDeps): CatalogRegistryPort {
  const built = new Map<CatalogId, ModelCatalogPort>()
  return {
    ids: () => CATALOG_IDS,
    has: (id: string) => Object.prototype.hasOwnProperty.call(FACTORIES, id),
    byId(id: string | null | undefined): ModelCatalogPort | null {
      if (!id || !isCatalogId(id)) return null
      if (!built.has(id)) built.set(id, FACTORIES[id](deps))
      // Present after the set above; `?? null` matches the port's "absent" value.
      return built.get(id) ?? null
    },
  }
}
