// `swisscode accounts ...` — subscription account vault management.
// import: snapshot Claude Code's CURRENT login into the vault (read-only
// against the active store). use: file-swap switch (writes active store).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AnthropicOAuthClient,
  AnthropicUsageClient,
  CachingUsageClient,
  CLAUDE_KEYCHAIN_SERVICE,
  ClaudeActiveCredentialStore,
  FileAccountRepository,
  FileUsageCache,
  countOtherClaudeSessions,
  credentialIdentity,
  defaultSubscriptionsDir,
  findAccountByCredential,
  freshVaultCredential,
} from "@swisscode/adapters";
import type { ActiveWriteReport, ProcessProbe } from "@swisscode/adapters";
import { CredentialStoreError, OAuthError, validateAccountId } from "@swisscode/core";

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
    "  import [id] [--label <label>]  Snapshot the current Claude Code login (id defaults to the login email)",
    "  list                           List stored accounts",
    "  usage [id]                     Show live 5h/7d utilization",
    "  use <id> [--force]             Switch Claude Code to this account (file swap)",
    "  remove <id>                    Delete a stored account",
  ].join("\n");
}

export async function cmdAccountsCurrent(): Promise<void> {
  const active = await activeStore.readActive();
  if (!active.credential) {
    console.log("No Claude Code login stored (backend: none). Log in first.");
    return;
  }
  const email = await usageApi.fetchEmail(active.credential.accessToken);
  const matched = (await findAccountByCredential(accounts, active.credential))?.id ?? null;
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

export async function cmdAccountsImport(id: string | undefined, label?: string, force = false): Promise<void> {
  const explicitId = (id ?? "").trim();
  if (explicitId) validateAccountId(explicitId);
  if (explicitId && !force && (await accounts.get(explicitId))) {
    console.error(`Account "${explicitId}" already exists. Re-run with --force to re-import.`);
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
  const finalId =
    explicitId ||
    (email ? email.toLowerCase().split("@")[0]!.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : "");
  if (!finalId) {
    console.error("Enter an account id — none could be derived from the login.");
    process.exitCode = 1;
    return;
  }
  validateAccountId(finalId);
  if (!force && !explicitId && (await accounts.get(finalId))) {
    console.error(`Account "${finalId}" already exists. Re-run with an explicit id or --force.`);
    process.exitCode = 1;
    return;
  }
  const duplicate = await findAccountByCredential(accounts, active.credential);
  if (duplicate && duplicate.id !== finalId) {
    console.error(
      `This Claude login is already imported as "${duplicate.id}". Re-run \`swisscode accounts import ${duplicate.id} --force\` to re-import it.`,
    );
    process.exitCode = 1;
    return;
  }
  const now = new Date().toISOString();
  await accounts.save(
    { id: finalId, label: label ?? email ?? finalId, email, createdAt: now, updatedAt: now },
    active.credential,
  );
  console.log(`Imported "${finalId}" from ${active.backend}${email ? ` (${email})` : ""}.`);
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
      // freshVaultCredential: one refresh per account, and adopt Claude Code's
      // live lineage when the vault copy was rotated away.
      const { credential } = await freshVaultCredential(accounts, oauth, accountId as string, {
        liveStore: activeStore,
      });
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

/** Runs pgrep for countOtherClaudeSessions; a failure is "no matches". */
const pgrepProbe: ProcessProbe = async (command, args) =>
  (await execFileAsync(command, args)).stdout;

/**
 * Are other Claude Code sessions running? The probe set lives in adapters so
 * the CLI warning and the web UI's count can never describe different process
 * lists.
 */
async function otherClaudeSessions(): Promise<boolean> {
  return (await countOtherClaudeSessions(pgrepProbe)) > 0;
}

/** File-swap switch. Returns false when the caller should abort. */
export async function activateAccount(id: string, force: boolean): Promise<boolean> {
  const account = await accounts.get(id);
  if (!account) {
    console.error(`Unknown subscription account "${id}".`);
    process.exitCode = 1;
    return false;
  }
  // Ask BEFORE refreshing: a refresh rotates the single-use token and persists
  // the new one, so aborting afterwards would still have spent the credential.
  if (!force && (await otherClaudeSessions())) {
    console.error(
      "Other `claude` sessions are running — switching the shared credential file " +
        "will move them to this account too. Re-run with --force to proceed.",
    );
    process.exitCode = 1;
    return false;
  }
  try {
    // adoptLive:false — a switch must never "heal" by adopting whatever login
    // happens to be live: the adopted stranger would be written straight back
    // and verified as a switch that never happened. A dead vault credential
    // surfaces as re-login-needed below instead. The live store is still
    // passed so a shared-lineage refresh mirrors back into Claude's store.
    const { credential, refreshed } = await freshVaultCredential(accounts, oauth, id, {
      liveStore: activeStore,
      adoptLive: false,
    });
    const before = await activeStore.readActive();
    const beforeIdentity = before.credential ? credentialIdentity(before.credential) : null;
    const want = credentialIdentity(credential);
    // Bounded re-write of the SAME credential object (tokens are single-use —
    // never a second freshVaultCredential): one retry covers a single in-flight
    // write-back from a running session. A persistent mismatch is reported.
    let report: ActiveWriteReport;
    for (let attempt = 0; ; attempt += 1) {
      try {
        report = await activeStore.writeActiveReport(credential);
        break;
      } catch (err) {
        if (attempt >= 1 || !(err instanceof CredentialStoreError) || err.kind !== "write-failed") {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    // Post-write proof, read AFTER the report returned: a write-back that landed
    // between the adapter's guard and now is caught here, not printed as success.
    const after = await activeStore.readActiveDetail();
    const afterIdentity = after.credential ? credentialIdentity(after.credential) : null;
    if (!after.credential || afterIdentity !== want) {
      const revertSuspected = beforeIdentity !== null && afterIdentity === beforeIdentity;
      if (revertSuspected) {
        const beforeAccount = before.credential
          ? await findAccountByCredential(accounts, before.credential).catch(() => null)
          : null;
        console.error(
          `The login changed back to "${beforeAccount?.label ?? beforeAccount?.id ?? "the previous account"}" ` +
            `right after the switch — a running Claude Code session wrote back the previous account. ` +
            `Re-run with --force, then let that session exit (or start new sessions after switching).`,
        );
      } else {
        console.error(
          `Switch could not be verified: the active login (${after.backend}) does not hold "${id}" ` +
            `after writing. Retry the switch; if it persists, check which backend your terminal's ` +
            `Claude Code reads (${activeStore.credentialsFilePath()}).`,
        );
      }
      process.exitCode = 1;
      return false;
    }
    const email = await usageApi.fetchEmail(after.credential.accessToken).catch(() => undefined);
    console.log(
      `Switched Claude Code to "${id}" (${email ?? "email unavailable"})${refreshed ? " (token refreshed)" : ""}.`,
    );
    if (report.keychain === "absent") {
      console.log(
        `No Keychain item "${CLAUDE_KEYCHAIN_SERVICE}" exists yet — the credentials file now holds ` +
          `"${id}", which Claude Code reads as fallback. Run \`claude login\` once to restore the Keychain copy.`,
      );
    }
    if (before.backend === "keychain") {
      console.log("macOS caches Keychain reads: restart running `claude` sessions to pick this up immediately.");
    }
    const others = await countOtherClaudeSessions(pgrepProbe);
    if (others > 0) {
      console.log(
        `${others} other claude session(s) still running — they may stay on the previous account ` +
          `until restarted. New sessions use "${id}".`,
      );
    }
    return true;
  } catch (err) {
    if (err instanceof OAuthError || err instanceof CredentialStoreError) {
      console.error(`Cannot switch: ${err.message}`);
      if (err instanceof OAuthError && (err.kind === "invalid_grant" || err.kind === "no_refresh_token")) {
        // The vault credential is dead and the switch refuses to adopt the
        // live login as a replacement: name what IS live so the recovery
        // step is obvious instead of a bare refresh error.
        const live = await activeStore.readActive().catch(() => undefined);
        const owner = live?.credential
          ? await findAccountByCredential(accounts, live.credential).catch(() => null)
          : null;
        console.error(
          owner && owner.id !== id
            ? `Claude Code is currently on "${owner.label ?? owner.id}" — switch to it instead, or log in ` +
              `as "${account.label ?? id}" (\`claude login\`), re-import it, and retry.`
            : `The live login could not be confirmed as "${account.label ?? id}". If Claude Code is already ` +
              `on this account, re-import it (\`swisscode accounts import ${id} --force\`) to heal the vault and retry; ` +
              `otherwise \`claude login\` as the right account first.`,
        );
      }
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
    return cmdAccountsImport(rest[0] as string | undefined, label, rest.includes("--force"));
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
