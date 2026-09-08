// `swisscode accounts ...` — subscription account vault management.
// import: snapshot Claude Code's CURRENT login into the vault (read-only
// against the active store). use: file-swap switch (writes active store).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AnthropicOAuthClient,
  AnthropicUsageClient,
  CachingUsageClient,
  ClaudeActiveCredentialStore,
  FileAccountRepository,
  FileUsageCache,
  defaultSubscriptionsDir,
} from "@swisscode/adapters";
import {
  OAuthError,
  ensureFreshCredential,
  validateAccountId,
} from "@swisscode/core";

const execFileAsync = promisify(execFile);

const accounts = new FileAccountRepository(defaultSubscriptionsDir());
const activeStore = new ClaudeActiveCredentialStore();
const oauth = new AnthropicOAuthClient();
const usageApi = new AnthropicUsageClient();
const usageClient = new CachingUsageClient(usageApi, new FileUsageCache());

export function accountsHelp(): string {
  return [
    "swisscode accounts <command>  (Claude subscription vault)",
    "swisscode accounts --provider <id> <command>  (per-provider accounts)",
    "",
    "  current                        Show the current Claude Code login",
    "  import <id> [--label <label>]  Snapshot the current Claude Code login",
    "  list                           List stored accounts",
    "  usage [id]                     Show live 5h/7d utilization",
    "  use <id> [--force]             Switch Claude Code to this account (file swap)",
    "  remove <id>                    Delete a stored account",
  ].join("\n");
}

export async function cmdAccountsCurrent(): Promise<void> {
  const { credentialIdentity } = await import("@swisscode/adapters");
  const active = await activeStore.readActive();
  if (!active.credential) {
    console.log("No Claude Code login stored (backend: none). Log in first.");
    return;
  }
  const email = await usageApi.fetchEmail(active.credential.accessToken);
  const identity = credentialIdentity(active.credential);
  let matched: string | null = null;
  for (const a of await accounts.list()) {
    const cred = await accounts.loadCredential(a.id);
    if (cred && credentialIdentity(cred) === identity) {
      matched = a.id;
      break;
    }
  }
  console.log(`Backend: ${active.backend}${active.source ? ` (${active.source})` : ""}`);
  console.log(`Login: ${email ?? "(email unavailable)"}`);
  console.log(matched ? `Matches vault account: ${matched}` : "Not imported yet — run `swisscode accounts import <id>`.");
}

function bar(pct: number | null): string {
  if (pct === null || pct === undefined) return "n/a";
  const filled = Math.round(pct / 10);
  return `${"█".repeat(filled)}${"░".repeat(10 - filled)} ${pct}%`;
}

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

export async function cmdAccountsImport(id: string, label?: string, force = false): Promise<void> {
  validateAccountId(id);
  if (!force && (await accounts.get(id))) {
    console.error(`Account "${id}" already exists. Re-run with --force to re-import.`);
    process.exitCode = 1;
    return;
  }
  const active = await activeStore.readActive();
  if (!active.credential) {
    console.error(
      active.backend === "none"
        ? "Claude Code has no stored login (file or Keychain). Log in first."
        : "Could not read the active Claude Code login (Keychain access may need approval).",
    );
    process.exitCode = 1;
    return;
  }
  const email = await usageApi.fetchEmail(active.credential.accessToken);
  const now = new Date().toISOString();
  await accounts.save(
    { id, label: label ?? email ?? id, email, createdAt: now, updatedAt: now },
    active.credential,
  );
  console.log(`Imported "${id}" from ${active.backend}${email ? ` (${email})` : ""}.`);
}

export async function cmdAccountsList(): Promise<void> {
  const all = await accounts.list();
  if (all.length === 0) {
    console.log("No stored accounts. Run `swisscode accounts import <id>` first.");
    return;
  }
  for (const a of all) {
    console.log(`${a.id}\t${a.label}${a.email ? `\t${a.email}` : ""}`);
  }
}

export async function cmdAccountsUsage(id?: string): Promise<void> {
  const targets = id ? [id] : (await accounts.list()).map((a) => a.id);
  if (targets.length === 0) {
    console.log("No stored accounts.");
    return;
  }
  for (const accountId of targets) {
    try {
      const { credential } = await ensureFreshCredential(accounts, oauth, accountId as string);
      const snapshot = await usageClient.fetchUsage(accountId as string, credential.accessToken);
      const stale = snapshot.stale ? `  (stale, as of ${ago(snapshot.fetchedAt)})` : "";
      console.log(`${accountId}:${stale}`);
      console.log(`  5h: ${bar(snapshot.fiveHour?.utilization ?? null)}${snapshot.fiveHour?.resetsAt ? `  resets ${snapshot.fiveHour.resetsAt}` : ""}`);
      console.log(`  7d: ${bar(snapshot.sevenDay?.utilization ?? null)}${snapshot.sevenDay?.resetsAt ? `  resets ${snapshot.sevenDay.resetsAt}` : ""}`);
      for (const [model, window] of Object.entries(snapshot.models ?? {})) {
        console.log(`  ${model}: ${bar(window.utilization)}`);
      }
      for (const entry of snapshot.scoped ?? []) {
        console.log(`  ${entry.name}: ${bar(entry.utilization)}${entry.resetsAt ? `  resets ${entry.resetsAt}` : ""}`);
      }
      for (const window of snapshot.windows ?? []) {
        console.log(`  ${window.key}: ${bar(window.utilization)}${window.resetsAt ? `  resets ${window.resetsAt}` : ""}`);
      }
      if (snapshot.spend) {
        const cap = snapshot.spend.limit !== null ? ` of $${snapshot.spend.limit.toFixed(2)}` : " (no cap)";
        console.log(`  extra: $${snapshot.spend.used.toFixed(2)}${cap}`);
      }
    } catch (err) {
      if (err instanceof OAuthError && (err.kind === "invalid_grant" || err.kind === "no_refresh_token")) {
        console.log(`${accountId}: re-login needed — ${err.message}`);
      } else {
        console.log(`${accountId}: usage unavailable (${(err as Error).message})`);
      }
    }
  }
}

async function otherClaudeSessions(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-x", "claude"]);
    const mine = String(process.pid);
    return stdout.split("\n").some((line) => line.trim() && line.trim() !== mine);
  } catch {
    return false; // pgrep missing or no match: don't block, just don't warn
  }
}

/** File-swap switch. Returns false when the caller should abort. */
export async function activateAccount(id: string, force: boolean): Promise<boolean> {
  const account = await accounts.get(id);
  if (!account) {
    console.error(`Unknown subscription account "${id}".`);
    process.exitCode = 1;
    return false;
  }
  try {
    const { credential, refreshed } = await ensureFreshCredential(accounts, oauth, id);
    if (!force && (await otherClaudeSessions())) {
      console.error(
        "Other `claude` sessions are running — switching the shared credential file " +
          "will move them to this account too. Re-run with --force to proceed.",
      );
      process.exitCode = 1;
      return false;
    }
    const before = await activeStore.readActive();
    await activeStore.writeActive(credential);
    console.log(`Switched Claude Code to "${id}"${refreshed ? " (token refreshed)" : ""}.`);
    if (before.backend === "keychain") {
      console.log("macOS caches Keychain reads: restart running `claude` sessions to pick this up immediately.");
    }
    return true;
  } catch (err) {
    if (err instanceof OAuthError) {
      console.error(`Cannot switch: ${err.message}`);
      process.exitCode = 1;
      return false;
    }
    throw err;
  }
}

export async function cmdAccounts(args: string[]): Promise<void> {
  const providerFlag = args.indexOf("--provider");
  if (providerFlag >= 0) {
    const providerId = args[providerFlag + 1];
    if (!providerId) {
      console.error("Usage: swisscode accounts --provider <id> <command>");
      process.exitCode = 1;
      return;
    }
    const { cmdProviderAccount } = await import("./providerAccounts.js");
    const rest = args.filter((_, i) => i !== providerFlag && i !== providerFlag + 1);
    return cmdProviderAccount(providerId, rest);
  }
  const [sub, ...rest] = args;
  if (sub === "current") return cmdAccountsCurrent();
  if (sub === "import" && rest[0]) {
    const labelFlag = rest.indexOf("--label");
    const label = labelFlag >= 0 ? rest[labelFlag + 1] : undefined;
    return cmdAccountsImport(rest[0] as string, label, rest.includes("--force"));
  }
  if (sub === "list") return cmdAccountsList();
  if (sub === "usage") return cmdAccountsUsage(rest[0]);
  if (sub === "use" && rest[0]) {
    await activateAccount(rest[0] as string, rest.includes("--force"));
    return;
  }
  if (sub === "remove" && rest[0]) {
    const ok = await accounts.remove(rest[0] as string);
    console.log(ok ? `Removed "${rest[0]}".` : `Unknown account "${rest[0]}".`);
    return;
  }
  console.log(accountsHelp());
}
