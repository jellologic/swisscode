// Adapter: cross-process mutex for one subscription account.
//
// The in-process SingleFlight only covers callers inside one Node process, and
// swisscode routinely runs several: the proxy, `swisscode accounts use`, and
// the web UI all read the same vault. A rotating refresh token is single-use,
// so two processes refreshing the same account at once spend it twice and the
// loser is left holding an invalid_grant — i.e. a logged-out account.
//
// The lock is a file created with O_EXCL next to the account it guards
// (`<id>.lock`, ignored by the vault's `*.json` scan). Two deliberate choices:
// - A lock older than LOCK_STALE_MS is reclaimable, because a crashed process
//   cannot clean up after itself and a permanently stuck account is worse than
//   a rare double refresh.
// - Failing to acquire never fails the caller. The lock is an optimisation
//   against a race; refusing to serve a request because a lock file is busy
//   would turn a rare collision into a hard outage.

import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A lock this old is assumed to belong to a dead process. */
export const LOCK_STALE_MS = 30_000;

export interface AccountLockOptions {
  /** Age at which an existing lock may be reclaimed. */
  staleMs?: number;
  /** Delay between acquisition attempts. */
  pollMs?: number;
  /** Give up waiting (and run unlocked) after this long. */
  maxWaitMs?: number;
}

export interface LockedRun<T> {
  value: T;
  /** False when the lock could not be taken and `fn` ran anyway. */
  locked: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryCreate(path: string): Promise<boolean> {
  try {
    // "wx" is the whole mutex: exactly one creator wins, everybody else sees
    // EEXIST. 0600 because the file names an account the user owns.
    const handle = await open(path, "wx", 0o600);
    try {
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "EEXIST") return false;
    if (code === "ENOENT") {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      return tryCreate(path);
    }
    throw err;
  }
}

/**
 * Reclaim a lock whose mtime is older than `staleMs`. True when this call is
 * the one that cleared it.
 *
 * Reclaiming is itself a critical section. Several waiters can decide the SAME
 * lock is stale at once, and a removal issued on that old observation lands
 * after the winner has already taken a fresh lock — deleting it, so a third
 * waiter creates its own and two processes now believe they hold the account.
 * That is precisely the double refresh (and the invalid_grant behind it) this
 * file exists to prevent, and no by-path removal is atomic enough to avoid it
 * on its own: `rm` and `rename` both act on whatever is at the path WHEN THEY
 * RUN, which may be seconds after the stat that judged it.
 *
 * So the reclaim runs under its own O_EXCL file and re-reads the mtime inside
 * it, immediately before removing. One reclaimer at a time, judging what is
 * actually there.
 */
async function reclaimIfStale(path: string, staleMs: number): Promise<boolean> {
  const guard = `${path}.reclaim`;
  // A reclaimer killed mid-flight would otherwise block every future reclaim.
  // Two waiters clearing an orphaned guard together is harmless: the O_EXCL
  // create below still admits exactly one of them.
  const orphan = await stat(guard).catch(() => undefined);
  if (orphan && Date.now() - orphan.mtimeMs > staleMs) {
    await rm(guard, { force: true }).catch(() => undefined);
  }
  if (!(await tryCreate(guard))) return false; // another waiter is already on it
  try {
    const info = await stat(path).catch(() => undefined);
    if (!info) return false; // released while we looked — the next attempt wins it
    if (Date.now() - info.mtimeMs <= staleMs) return false;
    await rm(path, { force: true }).catch(() => undefined);
    return true;
  } finally {
    await rm(guard, { force: true }).catch(() => undefined);
  }
}

/**
 * Run `fn` while holding the lock for `accountId`, or unlocked if the lock
 * cannot be taken before `maxWaitMs`. Always released, including on throw.
 */
export async function withAccountLock<T>(
  dir: string,
  accountId: string,
  fn: () => Promise<T>,
  options: AccountLockOptions = {},
): Promise<LockedRun<T>> {
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const pollMs = options.pollMs ?? 50;
  // Default deadline is the staleness window: by then either the holder
  // finished or its lock became reclaimable, so waiting longer buys nothing.
  const maxWaitMs = options.maxWaitMs ?? staleMs;
  const path = join(dir, `${accountId}.lock`);
  const deadline = Date.now() + maxWaitMs;

  let locked = false;
  for (;;) {
    locked = await tryCreate(path);
    if (locked) break;
    // The waiter that won the reclaim retries at once instead of sleeping: the
    // shorter `path` stays empty, the smaller the chance anyone else's reclaim
    // lands on the fresh lock rather than the dead one.
    if (await reclaimIfStale(path, staleMs)) continue;
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  try {
    return { value: await fn(), locked };
  } finally {
    // force: the file is already gone if somebody reclaimed it as stale.
    if (locked) await rm(path, { force: true }).catch(() => undefined);
  }
}
