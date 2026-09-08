// Adapter: Claude Code's OWN credential store (file or macOS Keychain).
// Read path mirrors claude-swap's resolution: the `<configHome>/.credentials.json`
// file first, then the default Keychain service. Write path preserves every
// key it didn't set (e.g. `mcpOAuth`) via read-merge-write.

import { execFile } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ActiveCredentialState,
  ActiveCredentialStore,
  OAuthCredential,
} from "@swisscode/core";

const execFileAsync = promisify(execFile);

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

export interface ActiveStoreOptions {
  /** Defaults to CLAUDE_CONFIG_DIR or ~/.claude. */
  configHome?: string;
  /** Set false in tests to avoid touching the real Keychain. */
  keychain?: boolean;
}

function resolveConfigHome(explicit?: string): string {
  if (explicit) return explicit;
  const env = process.env["CLAUDE_CONFIG_DIR"];
  if (env) return env;
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!home) throw new Error("Cannot resolve home directory");
  return join(home, ".claude");
}

const KNOWN_OAUTH_KEYS = new Set(["accessToken", "refreshToken", "expiresAt", "scopes"]);

function toCredential(oauth: Record<string, unknown>): OAuthCredential | undefined {
  const accessToken = oauth["accessToken"];
  const refreshToken = oauth["refreshToken"];
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") return undefined;
  const cred: OAuthCredential = { accessToken, refreshToken };
  if (typeof oauth["expiresAt"] === "number") cred.expiresAt = oauth["expiresAt"];
  if (Array.isArray(oauth["scopes"])) {
    cred.scopes = (oauth["scopes"] as unknown[]).filter((s): s is string => typeof s === "string");
  }
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(oauth)) {
    if (!KNOWN_OAUTH_KEYS.has(key)) extra[key] = value;
  }
  if (Object.keys(extra).length > 0) cred.extra = extra;
  return cred;
}

function fromCredential(cred: OAuthCredential): Record<string, unknown> {
  return {
    ...(cred.extra ?? {}),
    accessToken: cred.accessToken,
    refreshToken: cred.refreshToken,
    ...(cred.expiresAt !== undefined ? { expiresAt: cred.expiresAt } : {}),
    ...(cred.scopes !== undefined ? { scopes: cred.scopes } : {}),
  };
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw err;
  }
}

async function readKeychainJson(service: string): Promise<Record<string, unknown> | undefined> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
      "-w",
    ]);
    const text = stdout.trim();
    if (!text) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined; // missing item, denied access, or non-macOS: all mean "not here"
  }
}

/**
 * The account name on the existing Keychain item (usually the macOS username).
 * Updates MUST reuse it: `-U` with any other `-a` silently creates a duplicate
 * item Claude Code never reads instead of replacing the credential.
 */
async function keychainAccount(service: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      service,
    ]);
    const match = /"acct"<blob>="([^"]*)"/.exec(stdout);
    return match?.[1];
  } catch {
    return undefined;
  }
}

export class ClaudeActiveCredentialStore implements ActiveCredentialStore {
  private readonly configHome: string;
  private readonly useKeychain: boolean;

  constructor(options: ActiveStoreOptions = {}) {
    this.configHome = resolveConfigHome(options.configHome);
    this.useKeychain = options.keychain ?? true;
  }

  private credentialsPath(): string {
    return join(this.configHome, ".credentials.json");
  }

  async readActive(): Promise<ActiveCredentialState> {
    // Keychain first: on macOS a usable Keychain beats the file (verified live:
    // a fresh `claude` process authed with the Keychain credential while the
    // file held a different one). File is the fallback when Keychain is
    // unavailable or holds no OAuth payload.
    if (this.useKeychain) {
      const item = await readKeychainJson(CLAUDE_KEYCHAIN_SERVICE);
      const oauth = item?.["claudeAiOauth"];
      if (oauth && typeof oauth === "object") {
        const cred = toCredential(oauth as Record<string, unknown>);
        if (cred) return { backend: "keychain", credential: cred, source: CLAUDE_KEYCHAIN_SERVICE };
      }
    }
    const file = await readJsonFile(this.credentialsPath());
    const fileOauth = file?.["claudeAiOauth"];
    if (fileOauth && typeof fileOauth === "object") {
      const cred = toCredential(fileOauth as Record<string, unknown>);
      if (cred) return { backend: "file", credential: cred, source: this.credentialsPath() };
    }
    return { backend: "none" };
  }

  async writeActive(credential: OAuthCredential): Promise<void> {
    const current = await this.readActive();
    if (current.backend === "keychain") {
      await this.writeKeychain(credential);
      // Mirror to the file too (what cswap does): keeps both backends in sync
      // so a future Keychain outage falls back to the same account.
      // Keychain remains the effective store; mirror failure only warns.
      try {
        await this.writeFile(credential);
      } catch (err) {
        console.warn(`Keychain updated; file mirror failed (harmless): ${(err as Error).message}`);
      }
      return;
    }
    // Default (and "none") backend: the credentials file.
    await this.writeFile(credential);
  }

  private async writeFile(credential: OAuthCredential): Promise<void> {
    // Merge so unrelated keys (e.g. mcpOAuth) survive the swap.
    // Atomic rename avoids half-writes.
    const path = this.credentialsPath();
    const existing = (await readJsonFile(path)) ?? {};
    const existingOauth =
      existing["claudeAiOauth"] && typeof existing["claudeAiOauth"] === "object"
        ? (existing["claudeAiOauth"] as Record<string, unknown>)
        : {};
    const next = {
      ...existing,
      claudeAiOauth: { ...existingOauth, ...fromCredential(credential) },
    };
    const tmp = join(tmpdir(), `.swisscode-credentials-${process.pid}.json`);
    await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  }

  private async writeKeychain(credential: OAuthCredential): Promise<void> {
    // Read-merge-write: preserve every key /login stored that isn't ours —
    // both around claudeAiOauth (e.g. mcpOAuth) and inside it (e.g.
    // rateLimitTier, subscriptionType) — and reuse the item's own account name.
    const existing = (await readKeychainJson(CLAUDE_KEYCHAIN_SERVICE)) ?? {};
    const existingOauth =
      existing["claudeAiOauth"] && typeof existing["claudeAiOauth"] === "object"
        ? (existing["claudeAiOauth"] as Record<string, unknown>)
        : {};
    const payload = JSON.stringify({
      ...existing,
      claudeAiOauth: { ...existingOauth, ...fromCredential(credential) },
    });
    const account = await keychainAccount(CLAUDE_KEYCHAIN_SERVICE);
    if (!account) {
      throw new Error(
        `No Keychain item "${CLAUDE_KEYCHAIN_SERVICE}" exists. ` +
          `Run \`claude login\` once, then retry.`,
      );
    }
    try {
      // -U updates the existing item in place (same access controls).
      await execFileAsync("security", [
        "add-generic-password",
        "-U",
        "-s",
        CLAUDE_KEYCHAIN_SERVICE,
        "-a",
        account,
        "-w",
        payload,
      ]);
    } catch (err) {
      throw new Error(
        `Could not update the Keychain item "${CLAUDE_KEYCHAIN_SERVICE}" ` +
          `(Keychain access was denied). Approve access for your terminal, then retry. ` +
          `(${(err as Error).message})`,
      );
    }
    // Confirm the item now holds what we wrote — guards silent duplicates.
    const reread = await this.readActive();
    if (
      reread.backend !== "keychain" ||
      reread.credential?.refreshToken !== credential.refreshToken
    ) {
      throw new Error(
        "Keychain write did not take effect — the active login is unchanged. " +
          "Aborting rather than leaving a half-switched state.",
      );
    }
  }
}
