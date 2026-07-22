// The measured-usage snapshot, between runs.
//
// THIS CLOSES A LOOP THAT WAS OPEN. `core/resolve.ts` has read a `UsageSnapshot`
// since the v3 split, but nothing ever wrote one — so the `usage` strategy
// always took its documented fallback and always warned. That was honest, and
// useless. This is the writer, and it fixes OpenRouter's `usage` selection at
// the same time as enabling the subscription one, because the gap was never
// provider-specific.
//
// In the STATE directory beside the rotation cursor, and for the same reason: a
// measurement is regenerable. Losing it costs one refresh, not a broken setup.
// It is also stale by nature — nothing here pretends otherwise, and `checkedAt`
// travels with the numbers so every consumer can say how old they are.
//
// WRITTEN AT CONFIGURATION TIME ONLY — by the doctor and the web UI. The launch
// path reads it and never refreshes it, because refreshing means the network.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './fs-cursor-store.ts'
import type { UsageSnapshot } from '../../core/resolve.ts'

type ReadableEnv = Record<string, string | undefined>

export type UsageStorePort = {
  /** null when nothing has been measured, or the file is unusable */
  read: () => UsageSnapshot | null
  /** best effort; a failed write must never fail the command that triggered it */
  write: (snapshot: UsageSnapshot) => void
}

export type FsUsageStoreOptions = {
  env?: ReadableEnv
  dir?: string | null
}

/**
 * How long a snapshot is worth reading.
 *
 * Twelve hours. A 5-hour subscription window means a figure older than that
 * describes a window that has since rolled over — routing on it would be
 * routing on a number that is not merely stale but about a different period.
 * Expired snapshots read as ABSENT rather than as zero, so selection falls back
 * to the first account and says so, which is the behaviour that was already
 * there and already tested.
 */
export const SNAPSHOT_TTL_MS = 12 * 60 * 60 * 1000

export function createFsUsageStore({
  env = process.env,
  dir = null,
}: FsUsageStoreOptions = {}): UsageStorePort {
  const DIR = dir ?? stateDir(env)
  const PATH = join(DIR, 'usage.json')

  return {
    read(): UsageSnapshot | null {
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(PATH, 'utf8'))
      } catch {
        return null
      }
      if (!parsed || typeof parsed !== 'object') return null
      const o = parsed as { remaining?: unknown; checkedAt?: unknown }
      if (typeof o.checkedAt !== 'number' || !Number.isFinite(o.checkedAt)) return null
      if (Date.now() - o.checkedAt > SNAPSHOT_TTL_MS) return null
      if (!o.remaining || typeof o.remaining !== 'object' || Array.isArray(o.remaining)) return null

      // Filter rather than trust: a hand-edited or half-written file must not
      // put a NaN or a string into the comparison that decides which account
      // pays. Anything that is not a finite number is simply not a candidate.
      const remaining: Record<string, number> = {}
      for (const [name, value] of Object.entries(o.remaining as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value)) remaining[name] = value
      }
      return Object.keys(remaining).length > 0
        ? { remaining, checkedAt: o.checkedAt }
        : null
    },

    write(snapshot: UsageSnapshot): void {
      try {
        // 0700/0600: the file names ACCOUNTS and how much of each is left. No
        // credential, but it is a map of what you pay for and it is nobody
        // else's business — the same reasoning the cursor file carries.
        mkdirSync(DIR, { recursive: true, mode: 0o700 })
        writeFileSync(PATH, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
      } catch {
        // The measurement already happened and was already displayed. Failing
        // the doctor because a cache could not be written would trade a working
        // diagnosis for a tidy filesystem.
      }
    },
  }
}
