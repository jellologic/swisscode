// Adapter: file-backed subscription account vault.
// One JSON file per account under ~/.swisscode/subscriptions/, mode 0600.
// Layout mirrors the profile store (SWISSCODE_HOME override) so both move together.

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  AccountRepository,
  OAuthCredential,
  SubscriptionAccount,
} from "@swisscode/core";
import { validateAccountId } from "@swisscode/core";

interface VaultFile {
  account: SubscriptionAccount;
  credential: OAuthCredential;
}

export function defaultSubscriptionsDir(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "subscriptions");
}

export class FileAccountRepository implements AccountRepository {
  constructor(private readonly dir: string = defaultSubscriptionsDir()) {}

  private path(id: string): string {
    validateAccountId(id);
    return join(this.dir, `${id}.json`);
  }

  private async readFile(id: string): Promise<VaultFile | undefined> {
    try {
      return JSON.parse(await readFile(this.path(id), "utf8")) as VaultFile;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
      throw err;
    }
  }

  private async writeVault(id: string, vault: VaultFile): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    // 0600: refresh tokens are as sensitive as passwords.
    await writeFile(this.path(id), JSON.stringify(vault, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async list(): Promise<SubscriptionAccount[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw err;
    }
    const out: SubscriptionAccount[] = [];
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      const vault = await this.readFile(f.slice(0, -".json".length));
      if (vault) out.push(vault.account);
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<SubscriptionAccount | undefined> {
    return (await this.readFile(id))?.account;
  }

  async save(account: SubscriptionAccount, credential: OAuthCredential): Promise<void> {
    validateAccountId(account.id);
    const now = new Date().toISOString();
    const prev = await this.readFile(account.id);
    await this.writeVault(account.id, {
      account: {
        ...account,
        createdAt: prev?.account.createdAt ?? now,
        updatedAt: now,
      },
      credential,
    });
  }

  async loadCredential(id: string): Promise<OAuthCredential | undefined> {
    return (await this.readFile(id))?.credential;
  }

  async saveCredential(id: string, credential: OAuthCredential): Promise<void> {
    const vault = await this.readFile(id);
    if (!vault) throw new Error(`Unknown subscription account "${id}"`);
    vault.credential = credential;
    vault.account.updatedAt = new Date().toISOString();
    await this.writeVault(id, vault);
  }

  async remove(id: string): Promise<boolean> {
    try {
      await rm(this.path(id));
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return false;
      throw err;
    }
  }
}
