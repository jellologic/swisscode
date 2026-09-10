// Adapter: Claude Code's OWN credential store (file or macOS Keychain).
// Read path mirrors claude-swap's resolution: the default Keychain service
// first, then `<configHome>/.credentials.json`. Write path preserves every
// key it didn't set (e.g. `mcpOAuth`) via read-merge-write.
//
// A Keychain read that FAILS is not the same as a Keychain that is empty:
// if an item exists but `security` will not hand it over, writing only the
// file leaves Claude Code authenticated as the previous account while
// swisscode reports a successful switch. So the two cases are separate states
// (`keychain: "not-found"` vs `"unreadable"`) and a write refuses on the
// second one instead of half-switching.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import type {
  ActiveCredentialState,
  ActiveCredentialStore,
  OAuthCredential,
} from "@swisscode/core";
import { CredentialStoreError, isRecord } from "@swisscode/core";
import { credentialIdentity } from "./identity.js";
import { readJsonFile, writeJsonAtomic } from "../store/atomicJson.js";

const execFileAsync = promisify(execFile);

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** `security` exit code for "the item is not in the keychain" (errSecItemNotFound). */
const SECURITY_ITEM_NOT_FOUND = 44;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Injectable `security` runner; rejects with an Error carrying `code`. */
export type ExecFn = (file: string, args: string[]) => Promise<ExecResult>;

/**
 * Outcome of looking at the Keychain:
 * - ok: an item was read.
 * - not-found: `security` says the item does not exist (exit 44).
 * - unreadable: an item may well exist but access was denied or `security`
 *   failed for another reason — the ambiguous case that must block writes.
 * - unavailable: no `security` binary at all (non-macOS).
 * - skipped: the caller disabled Keychain use.
 */
export type KeychainReadState = "ok" | "not-found" | "unreadable" | "unavailable" | "skipped";

/** ActiveCredentialDetail plus why the Keychain leg produced what it did. */
export interface ActiveCredentialDetail extends ActiveCredentialState {
  keychain: KeychainReadState;
  /** `security` diagnostic; only set when `keychain` is "unreadable". */
  keychainError?: string;
}

/**
 * What a switch write did, per leg, plus what the verifying reread found.
 * `verifiedIdentity` is the reread's credentialIdentity() ("none" when the
 * reread found no credential) — a one-way hash, safe to log and return.
 */
export interface ActiveWriteReport {
  file: "written" | "failed";
  keychain: "written" | "absent" | "unavailable" | "skipped" | "failed";
  verifiedBackend: "keychain" | "file" | "none";
  verifiedIdentity: string;
  keychainError?: string;
}

export interface ActiveStoreOptions {
  /** Defaults to CLAUDE_CONFIG_DIR or ~/.claude. */
  configHome?: string;
  /** Set false in tests to avoid touching the real Keychain. */
  keychain?: boolean;
  /** Override the `security` invocation (tests inject exit codes). */
  execFn?: ExecFn;
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

/** core's isRecord in the `Record | undefined` shape the merge sites want. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Exit status of a failed `security` run, or undefined when it never ran. */
function exitCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "number") return code;
  if (typeof code === "string" && /^\d+$/.test(code)) return Number(code);
  return undefined;
}

function spawnFailed(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Diagnosis for a failed `security` run that never repeats its argv. Used
 * wherever the command line carried the credential payload.
 */
function execDetail(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  const code = exitCode(err);
  return code === undefined ? "`security` failed" : `security exited ${code}`;
}

type KeychainRead =
  | { state: "ok"; item: Record<string, unknown> }
  | { state: "not-found" | "unavailable" }
  | { state: "unreadable"; error: string };

export class ClaudeActiveCredentialStore implements ActiveCredentialStore {
  private readonly configHome: string;
  private readonly useKeychain: boolean;
  private readonly exec: ExecFn;

  constructor(options: ActiveStoreOptions = {}) {
    this.configHome = resolveConfigHome(options.configHome);
    this.useKeychain = options.keychain ?? true;
    this.exec = options.execFn ?? ((file, args) => execFileAsync(file, args));
  }

  private credentialsPath(): string {
    return join(this.configHome, ".credentials.json");
  }

  private async readKeychain(service: string): Promise<KeychainRead> {
    let stdout: string;
    try {
      ({ stdout } = await this.exec("security", ["find-generic-password", "-s", service, "-w"]));
    } catch (err: unknown) {
      // No `security` binary (non-macOS) is "there is no Keychain here", not a
      // permission problem — it must not block file-backed switching.
      if (spawnFailed(err)) return { state: "unavailable" };
      if (exitCode(err) === SECURITY_ITEM_NOT_FOUND) return { state: "not-found" };
      // 36/51/128 and friends: denied, locked, or an unknown failure. We cannot
      // prove the item is absent, so callers must treat it as present.
      return { state: "unreadable", error: message(err) };
    }
    const text = stdout.trim();
    if (!text) return { state: "not-found" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      return { state: "unreadable", error: `Keychain item is not JSON: ${message(err)}` };
    }
    const item = asObject(parsed);
    // A non-object payload is an item we cannot merge into — refusing to write
    // beats silently replacing whatever it is.
    return item ? { state: "ok", item } : { state: "unreadable", error: "Keychain item is not an object" };
  }

  /**
   * The account name on the existing Keychain item (usually the macOS username).
   * Updates MUST reuse it: `-U` with any other `-a` silently creates a duplicate
   * item Claude Code never reads instead of replacing the credential.
   */
  private async keychainAccount(service: string): Promise<string | undefined> {
    try {
      const { stdout } = await this.exec("security", ["find-generic-password", "-s", service]);
      const match = /"acct"<blob>="([^"]*)"/.exec(stdout);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  /** readActive with the Keychain diagnosis attached. */
  async readActiveDetail(): Promise<ActiveCredentialDetail> {
    // Keychain first: on macOS a usable Keychain beats the file (verified live:
    // a fresh `claude` process authed with the Keychain credential while the
    // file held a different one). File is the fallback when Keychain is
    // unavailable or holds no OAuth payload.
    let keychain: KeychainReadState = "skipped";
    let keychainError: string | undefined;
    if (this.useKeychain) {
      const read = await this.readKeychain(CLAUDE_KEYCHAIN_SERVICE);
      keychain = read.state;
      if (read.state === "unreadable") keychainError = read.error;
      if (read.state === "ok") {
        const oauth = asObject(read.item["claudeAiOauth"]);
        const cred = oauth ? toCredential(oauth) : undefined;
        if (cred) {
          return {
            backend: "keychain",
            credential: cred,
            source: CLAUDE_KEYCHAIN_SERVICE,
            keychain,
          };
        }
        // Item exists but carries no OAuth payload: the file is the login.
        keychain = "not-found";
      }
    }
    const file = await this.readCredentialsFile();
    const fileOauth = asObject(file.value?.["claudeAiOauth"]);
    const cred = fileOauth ? toCredential(fileOauth) : undefined;
    // The file credential is still reported when the Keychain is unreadable:
    // it is the best available answer for display. Writes consult `keychain`.
    if (cred) {
      return {
        backend: "file",
        credential: cred,
        source: this.credentialsPath(),
        keychain,
        ...(keychainError !== undefined ? { keychainError } : {}),
      };
    }
    return {
      backend: "none",
      keychain,
      ...(keychainError !== undefined ? { keychainError } : {}),
    };
  }

  async readActive(): Promise<ActiveCredentialState> {
    return this.readActiveDetail();
  }

  /** Where this store reads/writes the credentials file (see resolveConfigHome). */
  configHomeDir(): string {
    return this.configHome;
  }

  /** Full path of the credentials file this store reads/writes. */
  credentialsFilePath(): string {
    return this.credentialsPath();
  }

  async writeActive(credential: OAuthCredential): Promise<void> {
    await this.writeActiveReport(credential);
  }

  /**
   * Write to whichever backends are available, then prove the switch landed by
   * rereading. The old code branched the write target on the PRE-read backend —
   * a `file`/`none` pre-read while the Keychain held the live login produced a
   * file-only write `claude` never saw, reported as success. Now: the Keychain
   * is attempted whenever it might hold the login, the file mirrors whenever
   * the Keychain takes the write, and a reread mismatch throws instead of
   * reporting a switch that is not there. Throws CredentialStoreError on any
   * leg the effective login depends on; the report carries the rest.
   */
  async writeActiveReport(credential: OAuthCredential): Promise<ActiveWriteReport> {
    const current = await this.readActiveDetail();
    if (current.keychain === "unreadable") {
      // Writing the file here would report success while `claude` keeps
      // reading the Keychain item we could not touch.
      throw new CredentialStoreError(
        "keychain-unreadable",
        `The Keychain item "${CLAUDE_KEYCHAIN_SERVICE}" exists but could not be read ` +
          `(${current.keychainError ?? "access denied"}). Approve Keychain access for this ` +
          `terminal and retry — switching only the credentials file would leave Claude Code ` +
          `on the previous account.`,
      );
    }
    // The Keychain holds the live login whenever it is readable — including
    // the `not-found` pre-read, where the item may have appeared between read
    // and write or the pre-read misclassified it. Attempt it either way.
    let keychain: ActiveWriteReport["keychain"];
    if (current.keychain === "ok") {
      // Throws itself (with its own reread guard) when the update does not take.
      await this.writeKeychain(credential);
      keychain = "written";
    } else if (current.keychain === "not-found") {
      try {
        await this.writeKeychain(credential);
        keychain = "written";
      } catch (err) {
        // Genuinely no item to update: the file below IS the switch. Anything
        // else (denied, duplicate) means `claude` may still read the Keychain —
        // a file-only write would half-switch, so let it throw.
        if (!(err instanceof CredentialStoreError && err.kind === "keychain-missing")) throw err;
        keychain = "absent";
      }
    } else {
      keychain = current.keychain;
    }
    // The file is the effective store when the Keychain took nothing, and the
    // fallback mirror when it did (what cswap does). A failed mirror only
    // warns; a failed effective write throws below via the reread check.
    let file: ActiveWriteReport["file"] = "written";
    try {
      await this.writeFile(credential);
    } catch (err) {
      if (keychain !== "written") {
        throw new CredentialStoreError(
          "write-failed",
          `Could not write ${this.credentialsPath()}: ${(err as Error).message}. ` +
            `The active login is unchanged.`,
        );
      }
      console.warn(`Keychain updated; file mirror failed (harmless): ${(err as Error).message}`);
      file = "failed";
    }
    // Prove the switch landed: identity (sha256 of the refresh token, so
    // in-lineage access-token rotation cannot false-fail) must match what we
    // wrote, on a backend we wrote. A mismatch here is a concurrent revert —
    // typically a running `claude` session persisting the previous lineage —
    // or a lost write; either way success must not be reported.
    const reread = await this.readActiveDetail();
    const expected = credentialIdentity(credential);
    const actual = reread.credential ? credentialIdentity(reread.credential) : null;
    const report: ActiveWriteReport = {
      file,
      keychain,
      verifiedBackend: reread.backend,
      verifiedIdentity: actual ?? "none",
    };
    if (reread.keychainError !== undefined) report.keychainError = reread.keychainError;
    if (actual !== expected) {
      throw new CredentialStoreError(
        "write-failed",
        `Switch did not take effect: reread ${reread.backend} holds a different login ` +
          `(want ${expected.slice(0, 12)}…, got ${(actual ?? "none").slice(0, 12)}…). ` +
          `A running Claude Code session likely wrote back the previous account — ` +
          `retry the switch, then restart that session.`,
      );
    }
    if (keychain === "written" && reread.backend !== "keychain") {
      throw new CredentialStoreError(
        "write-failed",
        "Keychain write did not take effect — the active login is unchanged. " +
          "Aborting rather than leaving a half-switched state.",
      );
    }
    return report;
  }

  private async readCredentialsFile(): Promise<{
    value?: Record<string, unknown>;
    corrupt: boolean;
  }> {
    const read = await readJsonFile<unknown>(this.credentialsPath());
    if (!read.ok) return { corrupt: read.reason === "corrupt" };
    const value = asObject(read.value);
    return value ? { value, corrupt: false } : { corrupt: true };
  }

  private async writeFile(credential: OAuthCredential): Promise<void> {
    // Merge so unrelated keys (e.g. mcpOAuth) survive the swap. writeJsonAtomic
    // puts the temp file in the TARGET directory with an unpredictable name and
    // O_EXCL, so /tmp cannot be used to pre-plant a symlink and capture tokens.
    const path = this.credentialsPath();
    const current = await this.readCredentialsFile();
    const existing = current.value ?? {};
    const existingOauth = asObject(existing["claudeAiOauth"]) ?? {};
    const next = {
      ...existing,
      claudeAiOauth: { ...existingOauth, ...fromCredential(credential) },
    };
    // Content we could not parse is content we are about to drop — keep a copy.
    await writeJsonAtomic(path, next, { mode: 0o600, keepBackup: current.corrupt });
  }

  private async writeKeychain(credential: OAuthCredential): Promise<void> {
    // Read-merge-write: preserve every key /login stored that isn't ours —
    // both around claudeAiOauth (e.g. mcpOAuth) and inside it (e.g.
    // rateLimitTier, subscriptionType) — and reuse the item's own account name.
    const read = await this.readKeychain(CLAUDE_KEYCHAIN_SERVICE);
    if (read.state === "unreadable") {
      throw new CredentialStoreError(
        "keychain-unreadable",
        `Could not read the Keychain item "${CLAUDE_KEYCHAIN_SERVICE}" (${read.error}).`,
      );
    }
    const existing = read.state === "ok" ? read.item : {};
    const existingOauth = asObject(existing["claudeAiOauth"]) ?? {};
    const payload = JSON.stringify({
      ...existing,
      claudeAiOauth: { ...existingOauth, ...fromCredential(credential) },
    });
    const account = await this.keychainAccount(CLAUDE_KEYCHAIN_SERVICE);
    if (!account) {
      throw new CredentialStoreError(
        "keychain-missing",
        `No Keychain item "${CLAUDE_KEYCHAIN_SERVICE}" exists. ` +
          `Run \`claude login\` once, then retry.`,
      );
    }
    try {
      // -U updates the existing item in place (same access controls).
      //
      // WON'T FIX (accepted): the credential JSON is an argv element, so it is
      // visible in `ps` for the lifetime of this call. `security
      // add-generic-password` has no stdin mode for the password — `-w` with no
      // value only prompts on an interactive TTY, which a launcher cannot use —
      // so the alternatives are argv or dropping Keychain support entirely.
      // The exposure is a sub-second window on the user's own machine, to
      // processes already running as that user (which can read the Keychain
      // item and ~/.claude/.credentials.json anyway).
      await this.exec("security", [
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
      // NEVER `message(err)` here. execFile's message is "Command failed: <file>
      // <all args>", and the args include `-w <credential JSON>` — so the raw
      // message carries the access AND refresh token into the terminal, the
      // browser and the mirror-back warning. Only the exit status and stderr
      // are safe to repeat.
      throw new CredentialStoreError(
        "write-failed",
        `Could not update the Keychain item "${CLAUDE_KEYCHAIN_SERVICE}" ` +
          `(Keychain access was denied). Approve access for your terminal, then retry. ` +
          `(${execDetail(err)})`,
      );
    }
    // Confirm the item now holds what we wrote — guards silent duplicates.
    const reread = await this.readActiveDetail();
    if (
      reread.backend !== "keychain" ||
      reread.credential?.refreshToken !== credential.refreshToken
    ) {
      throw new CredentialStoreError(
        "write-failed",
        "Keychain write did not take effect — the active login is unchanged. " +
          "Aborting rather than leaving a half-switched state.",
      );
    }
  }
}
