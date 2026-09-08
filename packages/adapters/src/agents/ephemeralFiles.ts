// Materialize LaunchSpec.ephemeralFiles for a real launch. The descriptors
// themselves are pure core data; only this helper (called from cmdLaunch,
// never show/--dry-run) touches the filesystem. Files land 0600 in a fresh
// mkdtemp dir that outlives the detached spawn — no cleanup by the parent
// (documented lifetime; a SWISSCODE_HOME/tmp sweep is a later Track B item).

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EphemeralFile } from "@swisscode/core";

/** Fresh dir for one launch's ephemeral files (0600 files inside). */
export async function makeEphemeralDir(prefix = "swisscode-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/**
 * Write each descriptor under `dir` (creating nothing else) with its stated
 * mode. Returns the absolute paths in descriptor order. Rejects any `rel`
 * that would escape `dir` — descriptors are our own builders' output today,
 * but a crafted LaunchSpec must never turn this into an arbitrary write.
 */
export async function writeEphemeralFiles(
  files: EphemeralFile[],
  dir: string,
): Promise<string[]> {
  const paths: string[] = [];
  for (const file of files) {
    if (
      file.rel.includes("/") ||
      file.rel.includes("\\") ||
      file.rel === "" ||
      file.rel === "." ||
      file.rel === ".."
    ) {
      throw new Error(`refusing to materialize ephemeral file outside its dir: ${JSON.stringify(file.rel)}`);
    }
    const abs = join(dir, file.rel);
    await writeFile(abs, file.content, { mode: file.mode });
    paths.push(abs);
  }
  return paths;
}
