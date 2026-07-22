// Where a round-robin cursor is remembered between launches.
//
// DELIBERATELY NOT config.json, and deliberately not the config store. The
// launch path writes no config — `test/core/overrides.test.ts` asserts zero
// `store.save` calls across the whole override matrix — and a rotation counter
// is not configuration: nobody edits it, nobody backs it up, and losing it
// costs one repeated account rather than a broken setup.
//
// So it lives in the STATE directory, which is what XDG has for exactly this:
// data a program regenerates without complaint. Keeping it out of the config
// directory also keeps `config.json` free of a field that would churn on every
// launch and show up in every diff a user pastes into a bug report.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CursorPort } from '../../core/resolve.ts'

type ReadableEnv = Record<string, string | undefined>

/**
 * `$XDG_STATE_HOME/swisscode`, or `~/.local/state/swisscode`.
 *
 * The state spec's fallback is `~/.local/state` on every platform this ships
 * for. macOS has no XDG convention of its own and the config store already
 * resolves `~/.config` there rather than `~/Library`, so following the same
 * rule keeps a user's two swisscode directories siblings instead of scattering
 * them by platform.
 */
export function stateDir(env: ReadableEnv = process.env): string {
  return join(
    env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state'),
    'swisscode',
  )
}

export type FsCursorStoreOptions = {
  env?: ReadableEnv
  dir?: string | null
}

/**
 * Cursors for every profile, in one small JSON file.
 *
 * EVERY OPERATION IS BEST EFFORT. A read that fails yields null, which
 * `selectAccount` treats as "start at the beginning" — a normal state, not an
 * error. A write that fails is swallowed entirely: the launch has already been
 * decided by the time it happens, and failing a launch because a counter could
 * not be persisted would trade a working session for a tidy file.
 *
 * The consequence is stated rather than hidden: if the directory is unwritable,
 * rotation silently stops advancing and every launch uses the same account.
 * That is visible in the profile banner, which names the account.
 */
export function createFsCursorStore({
  env = process.env,
  dir = null,
}: FsCursorStoreOptions = {}): CursorPort {
  const DIR = dir ?? stateDir(env)
  const PATH = join(DIR, 'cursors.json')

  function readAll(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(PATH, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    } catch {
      // Absent, unreadable, or not JSON. All three mean "no cursor yet".
      return {}
    }
  }

  return {
    read(profileName: string): number | null {
      const value = readAll()[profileName]
      // A hand-edited or corrupted entry must not index an array out of range,
      // so anything that is not a non-negative integer restarts the rotation.
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
    },

    advance(profileName: string, next: number): void {
      try {
        // 0700: the file names PROFILES, which are user-chosen and can carry
        // client names, exactly like the binding paths SECURITY.md already
        // flags. It holds no credential, but it is nobody else's business.
        mkdirSync(DIR, { recursive: true, mode: 0o700 })
        const all = readAll()
        all[profileName] = next
        // Not atomic, and it does not need to be: the worst outcome of a torn
        // write is an unparseable file, which `readAll` treats as "no cursor"
        // and the next launch overwrites. Compare the config store, where a
        // torn write would destroy an API key and every write is atomic.
        writeFileSync(PATH, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
      } catch {
        /* rotation stops advancing; the launch already succeeded */
      }
    },
  }
}
