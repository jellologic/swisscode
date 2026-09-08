// Adapter: JSON-file ProfileRepository (infra detail, owns all fs access).
// Default location: ~/.swisscode/profiles.json (override with SWISSCODE_HOME).

import { join } from "node:path";
import { homedir } from "node:os";
import type { Profile, ProfileRepository } from "@swisscode/core";
import { validateProfile } from "@swisscode/core";
import { readJsonOrDefault, withStoreLock, writeJsonAtomic } from "./atomicJson.js";

export function defaultProfilesPath(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "profiles.json");
}

async function readAll(filePath: string): Promise<Profile[]> {
  const parsed = await readJsonOrDefault<unknown>(filePath, []);
  if (!Array.isArray(parsed)) return [];
  return parsed as Profile[];
}

/**
 * 0600 in a 0700 dir: a profile's `providerConfig` may hold an inline API key,
 * so this file is as sensitive as the account stores. The atomic rename also
 * re-modes a legacy 0644 profiles.json on the next write.
 */
async function writeAll(filePath: string, profiles: Profile[]): Promise<void> {
  await writeJsonAtomic(filePath, profiles, { mode: 0o600, keepBackup: true });
}

export class FileProfileRepository implements ProfileRepository {
  constructor(private readonly filePath: string = defaultProfilesPath()) {}

  get path(): string {
    return this.filePath;
  }

  async list(): Promise<Profile[]> {
    return readAll(this.filePath);
  }

  async get(name: string): Promise<Profile | undefined> {
    return (await readAll(this.filePath)).find((p) => p.name === name);
  }

  async save(profile: Profile): Promise<void> {
    validateProfile(profile);
    // Read-modify-write under the lock, or a concurrent save of another profile
    // reads the same old list and its rename drops this one.
    await withStoreLock(this.filePath, async () => {
      const all = await readAll(this.filePath);
      const i = all.findIndex((p) => p.name === profile.name);
      if (i >= 0) all[i] = profile;
      else all.push(profile);
      await writeAll(this.filePath, all);
    });
  }

  async remove(name: string): Promise<boolean> {
    return withStoreLock(this.filePath, async () => {
      const all = await readAll(this.filePath);
      const next = all.filter((p) => p.name !== name);
      if (next.length === all.length) return false;
      await writeAll(this.filePath, next);
      return true;
    });
  }
}
