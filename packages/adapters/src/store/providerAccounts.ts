// Adapter: generic per-provider account vault (key-based providers).
// Layout: ~/.swisscode/accounts/<providerId>/<id>.json, files mode 0600.
// Secrets are stored under the provider's own field keys (e.g. apiKey).

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProviderAccount, ProviderAccountRepository } from "@swisscode/core";
import { isProviderAccountShape, validateAccountId } from "@swisscode/core";
import { readJsonFile, withStoreLock, writeJsonAtomic } from "./atomicJson.js";

export function defaultProviderAccountsDir(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "accounts");
}

export interface ProviderAccountRepositoryOptions {
  /** Where an unusable account file is reported. Default: console.warn. */
  onWarn?: (message: string) => void;
}

export class FileProviderAccountRepository implements ProviderAccountRepository {
  private readonly warn: (message: string) => void;

  constructor(
    private readonly dir: string = defaultProviderAccountsDir(),
    options: ProviderAccountRepositoryOptions = {},
  ) {
    this.warn = options.onWarn ?? ((message: string) => console.warn(message));
  }

  private path(providerId: string, id: string): string {
    validateAccountId(id);
    if (!/^[a-z0-9-]+$/.test(providerId)) throw new Error(`Invalid provider id "${providerId}"`);
    return join(this.dir, providerId, `${id}.json`);
  }

  /**
   * One unusable file is a skipped account, never an exception: a record
   * missing `config` used to load fine here and then throw from
   * `Object.entries(a.config)` deep inside four unrelated pages.
   */
  private async readOne(providerId: string, id: string): Promise<ProviderAccount | undefined> {
    const path = this.path(providerId, id);
    const result = await readJsonFile<unknown>(path);
    if (!result.ok) {
      if (result.reason === "corrupt") this.warn(`swisscode: skipping ${path} (${result.error}).`);
      return undefined;
    }
    if (!isProviderAccountShape(result.value)) {
      this.warn(`swisscode: skipping ${path} — not a provider account (needs id, providerId, label, config).`);
      return undefined;
    }
    const account = result.value;
    if (account.providerId !== providerId || account.id !== id) return undefined;
    return account;
  }

  async list(providerId?: string): Promise<ProviderAccount[]> {
    const scopes = providerId ? [providerId] : await this.scopes();
    const out: ProviderAccount[] = [];
    for (const scope of scopes) {
      let files: string[];
      try {
        files = await readdir(join(this.dir, scope));
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        throw err;
      }
      for (const f of files.filter((x) => x.endsWith(".json"))) {
        const account = await this.readOne(scope, f.slice(0, -".json".length));
        if (account) out.push(account);
      }
    }
    return out.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id));
  }

  private async scopes(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }
  }

  async get(providerId: string, id: string): Promise<ProviderAccount | undefined> {
    return this.readOne(providerId, id);
  }

  async save(account: ProviderAccount): Promise<void> {
    validateAccountId(account.id);
    const path = this.path(account.providerId, account.id);
    // createdAt is read back before writing, so two saves of the same account
    // must not interleave.
    await withStoreLock(path, async () => {
      const now = new Date().toISOString();
      const prev = await this.readOne(account.providerId, account.id);
      const next: ProviderAccount = {
        ...account,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      // No .bak here: one file is one account, so a backup would only serve to
      // leave the API key on disk after `remove` deleted the account.
      await writeJsonAtomic(path, next, { mode: 0o600 });
    });
  }

  async remove(providerId: string, id: string): Promise<boolean> {
    try {
      await rm(this.path(providerId, id));
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw err;
    }
  }
}

/** Mask a secret for display: first 4 + … + last 2. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}
