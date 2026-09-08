// Adapter: JSON-file ProfileRepository (infra detail, owns all fs access).
// Default location: ~/.swisscode/profiles.json (override with SWISSCODE_HOME).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Profile, ProfileRepository } from "@swisscode/core";
import { validateProfile } from "@swisscode/core";

export function defaultProfilesPath(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "profiles.json");
}

async function readAll(filePath: string): Promise<Profile[]> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as Profile[];
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

async function writeAll(filePath: string, profiles: Profile[]): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(profiles, null, 2) + "\n", "utf8");
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
    const all = await readAll(this.filePath);
    const i = all.findIndex((p) => p.name === profile.name);
    if (i >= 0) all[i] = profile;
    else all.push(profile);
    await writeAll(this.filePath, all);
  }

  async remove(name: string): Promise<boolean> {
    const all = await readAll(this.filePath);
    const next = all.filter((p) => p.name !== name);
    if (next.length === all.length) return false;
    await writeAll(this.filePath, next);
    return true;
  }
}
