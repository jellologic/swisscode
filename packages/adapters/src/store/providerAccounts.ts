// Adapter: generic per-provider account vault (key-based providers).
// Layout: ~/.swisscode/accounts/<providerId>/<id>.json, files mode 0600.
// Secrets are stored under the provider's own field keys (e.g. apiKey).

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProviderAccount, ProviderAccountRepository } from "@swisscode/core";
import { validateAccountId } from "@swisscode/core";

export function defaultProviderAccountsDir(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "accounts");
}

export class FileProviderAccountRepository implements ProviderAccountRepository {
  constructor(private readonly dir: string = defaultProviderAccountsDir()) {}

  private path(providerId: string, id: string): string {
    validateAccountId(id);
    if (!/^[a-z0-9-]+$/.test(providerId)) throw new Error(`Invalid provider id "${providerId}"`);
    return join(this.dir, providerId, `${id}.json`);
  }

  private async readOne(providerId: string, id: string): Promise<ProviderAccount | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.path(providerId, id), "utf8")) as ProviderAccount;
      if (parsed.providerId !== providerId || parsed.id !== id) return undefined;
      return parsed;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw err;
    }
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
    const now = new Date().toISOString();
    const prev = await this.readOne(account.providerId, account.id);
    const next: ProviderAccount = {
      ...account,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    await mkdir(join(this.dir, account.providerId), { recursive: true, mode: 0o700 });
    await writeFile(this.path(account.providerId, account.id), JSON.stringify(next, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
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
