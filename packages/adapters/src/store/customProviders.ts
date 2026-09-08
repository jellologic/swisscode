// Adapter: file-backed custom provider definitions.
// Single JSON file (~/.swisscode/custom-providers.json), 0600 — static env
// values are user-entered and could hold a secret. Definitions carry no
// credentials themselves; those live in the account stores.

import { join } from "node:path";
import { homedir } from "node:os";
import type { CustomProviderDef, ProviderPort } from "@swisscode/core";
import { validateCustomProviderDef } from "@swisscode/core";
import { customProviderPort } from "../providers/customProvider.js";
import { defaultProviders } from "../registry.js";
import { readJsonOrDefault, withStoreLock, writeJsonAtomic } from "./atomicJson.js";

export function defaultCustomProvidersPath(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "custom-providers.json");
}

export class FileCustomProviderStore {
  constructor(private readonly filePath: string = defaultCustomProvidersPath()) {}

  get path(): string {
    return this.filePath;
  }

  private async readAll(): Promise<CustomProviderDef[]> {
    const parsed = await readJsonOrDefault<unknown>(this.filePath, []);
    const list = (parsed as { providers?: unknown })?.providers ?? parsed;
    return Array.isArray(list) ? (list as CustomProviderDef[]) : [];
  }

  private async writeAll(defs: CustomProviderDef[]): Promise<void> {
    const sorted = [...defs].sort((a, b) => a.id.localeCompare(b.id));
    await writeJsonAtomic(this.filePath, { providers: sorted }, { mode: 0o600, keepBackup: true });
  }

  async list(): Promise<CustomProviderDef[]> {
    return this.readAll();
  }

  async get(id: string): Promise<CustomProviderDef | undefined> {
    return (await this.readAll()).find((d) => d.id === id);
  }

  /**
   * Validate + upsert. reservedIds are built-in ids the def must not shadow
   * (passed by the caller, which owns the built-in registry).
   */
  async save(def: CustomProviderDef, reservedIds: string[] = []): Promise<CustomProviderDef> {
    validateCustomProviderDef(def, { reservedIds });
    // Validation is pure, so it stays outside the lock; only the
    // read-merge-write below may interleave with another save.
    return withStoreLock(this.filePath, async () => {
      const all = await this.readAll();
      const now = new Date().toISOString();
      const prev = all.find((d) => d.id === def.id);
      const stored: CustomProviderDef = {
        ...def,
        id: def.id,
        displayName: def.displayName.trim(),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      await this.writeAll([...all.filter((d) => d.id !== def.id), stored]);
      return stored;
    });
  }

  async remove(id: string): Promise<boolean> {
    return withStoreLock(this.filePath, async () => {
      const all = await this.readAll();
      if (!all.some((d) => d.id === id)) return false;
      await this.writeAll(all.filter((d) => d.id !== id));
      return true;
    });
  }
}

export interface LoadCustomProvidersOptions {
  /** Ids a stored def must not shadow. Default: the built-in provider ids. */
  reservedIds?: string[];
  /** Where a rejected def is reported. Default: stderr via console.warn. */
  onWarn?: (message: string) => void;
}

/**
 * Interpret every stored custom def as a ProviderPort (merge into the registry).
 *
 * Reserved ids are enforced on save and on import, but the file is a plain JSON
 * document a user can hand-edit: a def calling itself "claude-subscription"
 * would otherwise silently replace the built-in in the registry Map and
 * redirect every launch that names it. Skip it and say so.
 */
export async function loadCustomProviderPorts(
  store: FileCustomProviderStore = new FileCustomProviderStore(),
  opts: LoadCustomProvidersOptions = {},
): Promise<ProviderPort[]> {
  const reserved = new Set(opts.reservedIds ?? defaultProviders().map((p) => p.id));
  const warn = opts.onWarn ?? ((message: string) => console.warn(message));
  const ports: ProviderPort[] = [];
  const seen = new Set<string>();
  for (const def of await store.list()) {
    if (reserved.has(def.id)) {
      warn(
        `swisscode: custom provider "${def.id}" shadows a built-in provider and was ignored (${store.path}). Rename it.`,
      );
      continue;
    }
    if (seen.has(def.id)) {
      warn(`swisscode: duplicate custom provider "${def.id}" ignored (${store.path}).`);
      continue;
    }
    seen.add(def.id);
    ports.push(customProviderPort(def));
  }
  return ports;
}
