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
import { CACHE_VERSION } from '../../core/catalog.js'
import { configDir } from './fs-config-store.js'

/**
 * Model-catalog cache. Lives beside config.json, so this can be the code that
 * creates the config directory first — it therefore asserts the same 0700 the
 * config store does rather than leaving a 0755 dir behind for the API key.
 *
 * @param {{env?:Record<string,string>, dir?:string, clock:import('../../ports/clock.js').ClockPort}} opts
 */
export function createFsCacheStore({ env = process.env, dir = null, clock }) {
  const CACHE_DIR = dir ?? configDir(env)

  const pathFor = (id) => join(CACHE_DIR, `models-${id}.json`)

  function read(id) {
    const path = pathFor(id)
    if (!existsSync(path)) return null
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      if (!raw || typeof raw !== 'object') return null
      // A cache written by an older shape is treated as absent and refetched
      // rather than half-trusted.
      if (raw.version !== CACHE_VERSION) return null
      if (!Array.isArray(raw.models)) return null
      return { models: raw.models, fetchedAt: raw.fetchedAt }
    } catch {
      return null
    }
  }

  function write(id, models) {
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
