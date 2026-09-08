// Adapter: crash- and race-safe file writes for every swisscode store.
//
// The stores are read-modify-write over single files. `writeFile` truncates
// first, so a crash (or two concurrent saves) can leave a half-written file
// that makes `list`, the proxy's account scan and the whole web UI fail with a
// raw SyntaxError. Write to a unique temp file in the SAME directory (rename is
// only atomic within a filesystem), fsync it, then rename over the target: a
// reader sees either the old bytes or the new ones, never a mix.

import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

export interface WriteAtomicOptions {
  /** File mode for the new content. Default 0600 — stores hold secrets. */
  mode?: number;
  /** Copy the previous content to `<path>.bak` before replacing it. */
  keepBackup?: boolean;
}

export type ReadJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "missing" | "corrupt"; error?: string };

/**
 * A store file exists but cannot be read as JSON. Named so the message points
 * at the file to fix — a bare "Unexpected end of JSON input" from `list`, the
 * proxy or the web UI tells the user nothing about which store is torn.
 */
export class StoreFileError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path} is corrupt: ${reason}`);
    this.name = "StoreFileError";
  }
}

/** Write text to `path` atomically. Creates the parent directory (0700). */
export async function writeFileAtomic(
  path: string,
  contents: string,
  opts: WriteAtomicOptions = {},
): Promise<void> {
  const mode = opts.mode ?? 0o600;
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (opts.keepBackup) await backup(path, mode);
  // "wx" fails rather than clobbers: the temp name must be ours alone, which
  // also makes a hostile pre-created symlink at that path an error, not a write.
  const tmp = join(dir, `${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(tmp, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
    // chmod explicitly: open() applies the umask, and a store file that ends up
    // group/world readable is the bug we are trying to prevent.
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Write `value` as pretty JSON atomically (see {@link writeFileAtomic}). */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  opts: WriteAtomicOptions = {},
): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", opts);
}

/**
 * Read and parse a JSON file. Never throws: an unreadable store is data the
 * caller has to report (skip the record, warn about the path), not an
 * exception that takes down an unrelated command.
 */
export async function readJsonFile<T>(path: string): Promise<ReadJsonResult<T>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOTDIR: a path component is a file, so the target cannot exist either.
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "missing" };
    return { ok: false, reason: "corrupt", error: message(err) };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (err: unknown) {
    return { ok: false, reason: "corrupt", error: message(err) };
  }
}

/**
 * Read a single-file store: absent means "no records yet" (`fallback`), but a
 * present-and-unparseable file is an error the user must see, not an empty list
 * that a later save would happily overwrite.
 */
export async function readJsonOrDefault<T>(path: string, fallback: T): Promise<T> {
  const result = await readJsonFile<T>(path);
  if (result.ok) return result.value;
  if (result.reason === "missing") return fallback;
  throw new StoreFileError(path, result.error ?? "unreadable");
}

/** One chain per store path; entries are dropped as soon as they drain. */
const storeLocks = new Map<string, Promise<void>>();

/**
 * Serialize a read-modify-write section against one path. The atomic rename
 * stops a *torn* file, not a *lost* one: two concurrent `save()` calls both read
 * the old list and the second rename wins, silently dropping the first record.
 * Chaining makes each section observe the previous one's bytes.
 *
 * In-process only. Separate CLI/web processes still race; a cross-process lock
 * belongs with the credential path that actually needs one.
 */
export function withStoreLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const previous = storeLocks.get(path) ?? Promise.resolve();
  const run = previous.then(fn);
  // A failed section must not poison the queue behind it, so the chain the next
  // caller waits on never rejects.
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  storeLocks.set(path, settled);
  void settled.then(() => {
    if (storeLocks.get(path) === settled) storeLocks.delete(path);
  });
  return run;
}

async function backup(path: string, mode: number): Promise<void> {
  try {
    await copyFile(path, `${path}.bak`);
    // copyFile keeps the source mode; normalize so a legacy 0644 store does not
    // hand its permissions to the backup.
    const handle = await open(`${path}.bak`, "r+");
    try {
      await handle.chmod(mode);
    } finally {
      await handle.close();
    }
  } catch (err: unknown) {
    // Nothing to back up yet is the normal first-write case.
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
