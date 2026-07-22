// The last version we heard was published.
//
// THE LAUNCH PATH MAY NOT ASK THE NETWORK — `test/architecture.test.ts` forbids
// `fetch` and every socket module there, and that rule is the product, not a
// preference. So the launcher cannot check for updates; it can only read what
// something else already learned.
//
// This is that something. `config`, `doctor` and the web UI refresh it, and a
// launch reads one tiny file to decide whether to print a single line. No
// network in the launch's causal chain, direct or spawned.
//
// In the STATE directory beside the cursor and the usage snapshot, for the same
// reason all three live there: it is regenerable. Losing it costs one refresh.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stateDir } from './fs-cursor-store.ts'

type ReadableEnv = Record<string, string | undefined>

/** What the registry said, and when. */
export type VersionSnapshot = {
  /** the published `latest` dist-tag, e.g. "0.4.0" */
  latest: string
  /** epoch ms */
  checkedAt: number
}

export type VersionStorePort = {
  read: () => VersionSnapshot | null
  /** best effort; a failed write must never fail the command that triggered it */
  write: (snapshot: VersionSnapshot) => void
}

/**
 * How long a check is worth trusting, and therefore how often the refreshing
 * commands actually reach the network.
 *
 * A DAY. Releases are not frequent enough for anything shorter to find news,
 * and a notice that appears within a day of a release is soon enough for a tool
 * nobody is paged about. Matches the model-catalog cache, which made the same
 * call for the same reason.
 */
export const VERSION_TTL_MS = 24 * 60 * 60 * 1000

export type FsVersionStoreOptions = {
  env?: ReadableEnv
  dir?: string | null
}

export function createFsVersionStore({
  env = process.env,
  dir = null,
}: FsVersionStoreOptions = {}): VersionStorePort {
  const directory = dir ?? stateDir(env)
  const file = join(directory, 'version.json')

  return {
    read() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        if (!parsed || typeof parsed !== 'object') return null
        const { latest, checkedAt } = parsed as Record<string, unknown>
        if (typeof latest !== 'string' || latest === '') return null
        if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt)) return null
        return { latest, checkedAt }
      } catch {
        // Absent, unreadable, or not JSON. All mean "we have not heard".
        return null
      }
    },
    write(snapshot) {
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 })
        writeFileSync(file, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
      } catch {
        // The command that triggered this has already done its real work.
      }
    },
  }
}

/**
 * Whether the cached answer is old enough to be worth re-asking.
 *
 * Separate from `read` because the two callers want different things: a launch
 * reads a stale snapshot happily (a day-old version number is still true enough
 * to warn on), while a refresher needs to know whether to spend a request.
 */
export function isStale(
  snapshot: VersionSnapshot | null,
  now: number,
  ttlMs: number = VERSION_TTL_MS,
): boolean {
  if (!snapshot) return true
  // A clock that moved backwards makes `now - checkedAt` negative, which would
  // otherwise read as "checked in the future, definitely fresh" and could
  // wedge the check off permanently.
  const age = now - snapshot.checkedAt
  return age < 0 || age >= ttlMs
}

/**
 * The version of swisscode that is actually running.
 *
 * Read from the package manifest rather than baked in by the build, because a
 * constant substituted at build time is exactly the thing that goes stale and
 * lies — and this value's whole job is to be compared against the registry.
 *
 * Lives in this module because this is where "which version" is already the
 * subject, and because it keeps the launch path from growing another file for
 * one function.
 *
 * The path is the same from `src/` and from `dist/`: both put this module three
 * levels below the package root. Null on any failure — an unreadable manifest
 * must never be the reason a launch does not happen.
 */
export function installedVersion(): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const parsed: unknown = JSON.parse(readFileSync(join(here, '..', '..', '..', 'package.json'), 'utf8'))
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : null
  } catch {
    return null
  }
}
