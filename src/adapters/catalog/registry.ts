import type { CatalogRegistryPort, ModelCatalogPort } from '../../ports/catalog.ts'
import type { CatalogDeps } from './cached-catalog.ts'
import { createOpenRouterCatalog } from './openrouter.ts'
import { createModelScopeCatalog } from './modelscope.ts'

const FACTORIES = Object.freeze({
  openrouter: createOpenRouterCatalog,
  modelscope: createModelScopeCatalog,
})

/** The ids this build ships a catalog for, derived from the table itself. */
export type CatalogId = keyof typeof FACTORIES

export const CATALOG_IDS: readonly string[] = Object.freeze(Object.keys(FACTORIES))

/**
 * The same `hasOwnProperty` test as before, said so the compiler can use it.
 *
 * Without the predicate, `FACTORIES[id]` on a plain `string` is an unchecked
 * index — exactly what `noUncheckedIndexedAccess` exists to catch. With it, the
 * lookup below is proven present and no assertion is needed.
 */
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
      // Provably present — set on the line above when absent. The `?? null`
      // bridges what `Map.get` cannot express, and lands on the value the port
      // already uses for "no such catalog". Same pattern as core/profile.ts
      // `hit()`.
      return built.get(id) ?? null
    },
  }
}
