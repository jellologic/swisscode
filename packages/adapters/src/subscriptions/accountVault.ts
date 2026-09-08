// Adapter: file-backed subscription account vault.
// One JSON file per account under ~/.swisscode/subscriptions/, mode 0600.
// Layout mirrors the profile store (SWISSCODE_HOME override) so both move together.
//
// One account per file is the blast-radius rule: a torn or hand-edited file
// must cost exactly that account. So reads never throw on bad content — the
// record is skipped and reported through `onWarning` — and writes go through
// writeJsonAtomic, which renames a fully-written temp file over the target.

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  AccountRepository,
  OAuthCredential,
  SubscriptionAccount,
} from "@swisscode/core";
import {
  isOAuthCredentialShape,
  isRecord,
  isSubscriptionAccountShape,
  validateAccountId,
} from "@swisscode/core";
import { readJsonFile, writeJsonAtomic } from "../store/atomicJson.js";

interface VaultFile {
  account: SubscriptionAccount;
  credential: OAuthCredential;
}

/** One unusable vault file. Data, not an exception: the rest still works. */
export interface VaultWarning {
  /** Account id the file name claims. */
  id: string;
  path: string;
  reason: "corrupt" | "invalid";
  detail?: string;
}

export interface AccountVaultOptions {
  /** Notified once per unusable file encountered by a read. */
  onWarning?: (warning: VaultWarning) => void;
}

type VaultRead =
  | { state: "ok"; file: VaultFile }
  | { state: "missing" | "corrupt" | "invalid" };

export function defaultSubscriptionsDir(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "subscriptions");
}

function isVaultFile(value: unknown): value is VaultFile {
  if (!isRecord(value)) return false;
  return (
    isSubscriptionAccountShape(value["account"]) && isOAuthCredentialShape(value["credential"])
  );
}

export class FileAccountRepository implements AccountRepository {
  constructor(
    private readonly dir: string = defaultSubscriptionsDir(),
    private readonly options: AccountVaultOptions = {},
  ) {}

  private path(id: string): string {
    validateAccountId(id);
    return join(this.dir, `${id}.json`);
  }

  private warn(warning: VaultWarning): void {
    this.options.onWarning?.(warning);
  }

  private async readVault(id: string): Promise<VaultRead> {
    const path = this.path(id);
    const read = await readJsonFile<unknown>(path);
    if (!read.ok) {
      if (read.reason === "missing") return { state: "missing" };
      const warning: VaultWarning = { id, path, reason: "corrupt" };
      if (read.error !== undefined) warning.detail = read.error;
      this.warn(warning);
      return { state: "corrupt" };
    }
    if (!isVaultFile(read.value)) {
      this.warn({ id, path, reason: "invalid", detail: "not an account/credential pair" });
      return { state: "invalid" };
    }
    return { state: "ok", file: read.value };
  }

  private async readFile(id: string): Promise<VaultFile | undefined> {
    const read = await this.readVault(id);
    return read.state === "ok" ? read.file : undefined;
  }

  private async writeVault(id: string, vault: VaultFile): Promise<void> {
    // 0600: refresh tokens are as sensitive as passwords.
    await writeJsonAtomic(this.path(id), vault, { mode: 0o600 });
  }

  async list(): Promise<SubscriptionAccount[]> {
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw err;
    }
    const out: SubscriptionAccount[] = [];
    for (const name of files.filter((x) => x.endsWith(".json"))) {
      const id = name.slice(0, -".json".length);
      try {
        validateAccountId(id);
      } catch {
        // A file name that is not a legal id can never be addressed by any
        // command, so surface it rather than pretending the vault is clean.
        this.warn({ id, path: join(this.dir, name), reason: "invalid", detail: "illegal account id" });
        continue;
      }
      const vault = await this.readFile(id);
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
    const read = await this.readVault(id);
    if (read.state === "missing") throw new Error(`Unknown subscription account "${id}"`);
    if (read.state !== "ok") {
      // Writing here would replace the unreadable metadata with nothing;
      // re-importing the account is the only honest recovery.
      throw new Error(
        `Subscription account "${id}" is unreadable (${this.path(id)}) — re-import it before switching.`,
      );
    }
    const vault = read.file;
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
