// Adapter: file-backed custom provider definitions.
// Single JSON file (~/.swisscode/custom-providers.json), 0600 — static env
// values are user-entered and could hold a secret. Definitions carry no
// credentials themselves; those live in the account stores.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CustomProviderDef, ProviderPort } from "@swisscode/core";
import { validateCustomProviderDef } from "@swisscode/core";
import { customProviderPort } from "../providers/customProvider.js";

export function defaultCustomProvidersPath(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "custom-providers.json");
}

export class FileCustomProviderStore {
  constructor(private readonly path: string = defaultCustomProvidersPath()) {}

  private async readAll(): Promise<CustomProviderDef[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.path, "utf8"));
      const list = (parsed as { providers?: unknown })?.providers ?? parsed;
      return Array.isArray(list) ? (list as CustomProviderDef[]) : [];
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }
  }

  private async writeAll(defs: CustomProviderDef[]): Promise<void> {
    const sorted = [...defs].sort((a, b) => a.id.localeCompare(b.id));
    await mkdir(join(this.path, ".."), { recursive: true });
    await writeFile(this.path, JSON.stringify({ providers: sorted }, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
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
  }

  async remove(id: string): Promise<boolean> {
    const all = await this.readAll();
    if (!all.some((d) => d.id === id)) return false;
    await this.writeAll(all.filter((d) => d.id !== id));
    return true;
  }
}

/** Interpret every stored custom def as a ProviderPort (merge into the registry). */
export async function loadCustomProviderPorts(
  store: FileCustomProviderStore = new FileCustomProviderStore(),
): Promise<ProviderPort[]> {
  return (await store.list()).map(customProviderPort);
}
