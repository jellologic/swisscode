import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ClockPort } from '../../ports/clock.ts'
import type {
  CatalogCacheEntry,
  ModelCacheStorePort,
  NormalizedModel,
} from '../../ports/catalog.ts'
import { CACHE_VERSION } from '../../core/catalog.ts'
import { configDir } from './fs-config-store.ts'

/**
 * Narrows `unknown` to something indexable, and nothing more.
 *
 * Exactly the `!raw || typeof raw !== 'object'` test it replaces, negated —
 * INCLUDING the fact that it lets arrays through, which the original also did.
 * Duplicated from core/catalog.ts rather than shared: adapters have no util
 * module and inventing one would be restructuring.
 */
function isObjectLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

export type FsCacheStoreOptions = {
  env?: Record<string, string | undefined>
  dir?: string | null
  clock: ClockPort
}

/**
 * Model-catalog cache. Lives beside config.json, so this can be the code that
 * creates the config directory first — it therefore asserts the same 0700 the
 * config store does rather than leaving a 0755 dir behind for the API key.
 */
export function createFsCacheStore({
  env = process.env,
  dir = null,
  clock,
}: FsCacheStoreOptions): ModelCacheStorePort {
  const CACHE_DIR = dir ?? configDir(env)

  const pathFor = (id: string) => join(CACHE_DIR, `models-${id}.json`)

  /**
   * Returns `CatalogCacheEntry`, whose fields are `unknown[]` and `unknown` —
   * NOT `NormalizedModel[]`. That is the point, not an omission.
   *
   * This file is attacker-adjacent: a plain JSON file in the user's config dir
   * whose `id` ends up in ANTHROPIC_DEFAULT_*_MODEL. The only things checked
   * here are the cache VERSION and that `models` is an array. Every row is
   * re-validated by core/catalog.ts `sanitizeModels`, and `fetchedAt` by
   * `isStale`. Typing the return as trusted data would erase exactly the checks
   * that make it safe.
   */
  function read(id: string): CatalogCacheEntry | null {
    const path = pathFor(id)
    if (!existsSync(path)) return null
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (!isObjectLike(raw)) return null
      // A cache written by an older shape is treated as absent and refetched
      // rather than half-trusted.
      if (raw.version !== CACHE_VERSION) return null
      if (!Array.isArray(raw.models)) return null
      return { models: raw.models, fetchedAt: raw.fetchedAt }
    } catch {
      return null
    }
  }

  function write(id: string, models: NormalizedModel[]): void {
    const path = pathFor(id)
    const tmp = `${path}.tmp.${process.pid}`
    try {
      mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 })
      chmodSync(CACHE_DIR, 0o700)
      writeFileSync(
        tmp,
        JSON.stringify({ version: CACHE_VERSION, fetchedAt: clock.now(), models }),
        { mode: 0o600 },
      )
      renameSync(tmp, path)
    } catch {
      // A read-only config dir should not break the picker; we just refetch.
      try {
        unlinkSync(tmp)
      } catch {
        /* nothing useful to do */
      }
    }
  }

  return { read, write, path: pathFor }
}
