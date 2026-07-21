import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConfigModes, ConfigStorePort, LoadResult, State } from '../../ports/config-store.ts'
import { migrate, SUPPORTED_VERSION } from '../../core/migrate.ts'

/**
 * An environment map as READ. Values are `string | undefined` because that is
 * what `process.env` is: an unset variable is absent, and reading it yields
 * undefined. `ports/process.ts` `EnvMap` is the narrower `Record<string,string>`
 * used on the way OUT to a child, and it is assignable to this — so both the
 * ambient `process.env` and a caller-supplied EnvMap fit.
 */
type ReadableEnv = Record<string, string | undefined>

/**
 * Read `.message` off a caught value.
 *
 * `useUnknownInCatchVariables` (part of `strict`) types a caught value as
 * `unknown`, so the bare `err.message` this replaces no longer compiles.
 *
 * Deliberately NOT `err instanceof Error ? err.message : String(err)`. That is
 * the idiomatic fix and it is a BEHAVIOUR CHANGE: a non-Error throw yields
 * `undefined` here today, and `String(err)` would put a different string into a
 * warning the user reads. A types-only slice does not get to change that, so
 * the property read stays the property read and the return type says exactly
 * what such a read yields. The `as` claims only that a property MIGHT be there,
 * which is the weakest statement that compiles, and it is not applied to
 * external data — see the catalog adapters for that boundary.
 */
const errMessage = (err: unknown): string | undefined => (err as { message?: string }).message

export function configDir(env: ReadableEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'cuckoocode')
}

export type FsConfigStoreOptions = {
  env?: ReadableEnv
  dir?: string | null
}

/**
 * The file config store, plus one method the port does not declare.
 *
 * `dir()` is implemented here and called by NOBODY — dead surface, confirmed by
 * the ports slice. It is left in place (this is a types-only migration, not a
 * cleanup) but it stays OUT of `ConfigStorePort`, so the contract does not
 * acquire a requirement no consumer has. Spelling the intersection here is what
 * keeps both facts true and visible at once.
 */
export type FsConfigStore = ConfigStorePort & { dir: () => string }

/**
 * The config file holds an API key: mode 0600 inside a 0700 directory, always.
 */
export function createFsConfigStore({
  env = process.env,
  dir = null,
}: FsConfigStoreOptions = {}): FsConfigStore {
  const CONFIG_DIR = dir ?? configDir(env)
  const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

  // Carried from load to save: a file we could not parse must be moved aside
  // before anything is written over the top of it.
  let sawCorrupt = false
  let readOnly = false

  function ensureDir() {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    // mkdirSync's mode only applies when it creates the directory, so a dir
    // that already existed as 0755 would keep those permissions. Re-assert.
    chmodSync(CONFIG_DIR, 0o700)
  }

  function writeAtomic(path: string, contents: string) {
    ensureDir()
    const tmp = `${path}.tmp.${process.pid}`
    try {
      writeFileSync(tmp, contents, { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, path)
    } catch (err) {
      try {
        unlinkSync(tmp)
      } catch {
        /* nothing useful to do */
      }
      throw err
    }
    // writeFileSync's mode only applies on create; re-assert for a file that
    // already existed with looser permissions.
    chmodSync(path, 0o600)
  }

  function quarantine() {
    if (!sawCorrupt || !existsSync(CONFIG_PATH)) return
    const dest = join(CONFIG_DIR, `config.corrupt-${Date.now()}.json`)
    try {
      renameSync(CONFIG_PATH, dest)
      chmodSync(dest, 0o600)
    } catch {
      /* if we cannot move it we still must not overwrite it silently */
    }
    sawCorrupt = false
  }

  function backupV1() {
    const backup = join(CONFIG_DIR, 'config.v1.bak.json')
    try {
      // 'wx' so a second run never clobbers the original snapshot.
      writeFileSync(backup, readFileSync(CONFIG_PATH, 'utf8'), { flag: 'wx', mode: 0o600 })
    } catch {
      /* already backed up, or unwritable — neither is worth failing over */
    }
  }

  function load(): LoadResult {
    // `unknown`, not `any`: this is JSON off the disk and `migrate` is the thing
    // that decides what it is. `migrate(raw: unknown)` already takes it that
    // way, so nothing here has to pretend to know the shape.
    let raw: unknown = null
    let existed = false
    if (existsSync(CONFIG_PATH)) {
      existed = true
      try {
        raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === 'EACCES' || code === 'EPERM') throw err
        raw = null
      }
    }

    const result = migrate(raw)
    sawCorrupt = existed && result.corrupt
    readOnly = result.readOnly

    const warnings = [...(result.warnings ?? [])]
    if (readOnly) {
      warnings.push(
        `config.json is version ${result.state.version}; this cuckoocode understands ` +
          `up to ${SUPPORTED_VERSION}. Reading what it can, and refusing to write. ` +
          'Upgrade cuckoocode.',
      )
    }

    // Persist ONLY a real schema migration. A launch that merely reads must not
    // touch the disk, and a failed write must never block the launch.
    if (result.migratedFrom !== null && !readOnly) {
      try {
        ensureDir()
        backupV1()
        writeAtomic(CONFIG_PATH, `${JSON.stringify(result.state, null, 2)}\n`)
        warnings.push(
          `migrated config.json to the v${SUPPORTED_VERSION} profile format ` +
            `(previous file kept as config.v1.bak.json).`,
        )
      } catch (err) {
        warnings.push(
          `could not rewrite config.json in the new format (${errMessage(err)}); ` +
            'continuing with the migrated settings in memory.',
        )
      }
    }

    return {
      state: result.state,
      corrupt: sawCorrupt,
      readOnly,
      migrated: result.migratedFrom !== null,
      warnings,
    }
  }

  function save(state: State): string {
    if (readOnly) {
      throw new Error(
        `config.json is a newer schema version than this cuckoocode understands ` +
          `(<= ${SUPPORTED_VERSION}); refusing to overwrite it. Upgrade cuckoocode.`,
      )
    }
    quarantine()
    writeAtomic(CONFIG_PATH, `${JSON.stringify(state, null, 2)}\n`)
    return CONFIG_PATH
  }

  function modes(): ConfigModes {
    const out: ConfigModes = { dir: null, file: null }
    try {
      out.dir = statSync(CONFIG_DIR).mode & 0o777
    } catch {
      /* absent */
    }
    try {
      out.file = statSync(CONFIG_PATH).mode & 0o777
    } catch {
      /* absent */
    }
    return out
  }

  return { load, save, path: () => CONFIG_PATH, dir: () => CONFIG_DIR, modes }
}
