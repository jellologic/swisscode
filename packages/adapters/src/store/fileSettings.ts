// Adapter: JSON-file GlobalSettings store (infra detail, owns all fs access).
// Default location: ~/.swisscode/settings.json (override with SWISSCODE_HOME).
// A single record, not a list: missing, corrupt or shape-bad reads fall back
// to DEFAULT_GLOBAL_SETTINGS so a torn settings.json can never crash listen().

import { stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { GlobalSettings } from "@swisscode/core";
import { DEFAULT_GLOBAL_SETTINGS, isGlobalSettingsShape } from "@swisscode/core";
import { readJsonOrDefault, withStoreLock, writeJsonAtomic } from "./atomicJson.js";

export function defaultSettingsPath(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "settings.json");
}

/** 0600 in a 0700 dir, like every other home store. */
async function writeAll(filePath: string, settings: GlobalSettings): Promise<void> {
  await writeJsonAtomic(filePath, settings, { mode: 0o600 });
}

export class FileSettingsStore {
  constructor(private readonly filePath: string = defaultSettingsPath()) {}

  get path(): string {
    return this.filePath;
  }

  /** True when a settings file exists on disk (torn counts as present). */
  async present(): Promise<boolean> {
    try {
      await stat(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async get(): Promise<GlobalSettings> {
    let parsed: unknown;
    try {
      parsed = await readJsonOrDefault<unknown>(this.filePath, undefined);
    } catch {
      // Corrupt JSON: defaults, never a StoreFileError up the stack.
      return { ...DEFAULT_GLOBAL_SETTINGS };
    }
    if (!isGlobalSettingsShape(parsed)) return { ...DEFAULT_GLOBAL_SETTINGS };
    return parsed;
  }

  async save(settings: GlobalSettings): Promise<void> {
    await withStoreLock(this.filePath, async () => {
      await writeAll(this.filePath, settings);
    });
  }
}
