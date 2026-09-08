#!/usr/bin/env node
// swisscode CLI — thin shell over the hexagonal core.
// Usage:
//   swisscode <profileName> [--dry-run] [-- extra args...]
//   swisscode list
//   swisscode show <profileName>

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { delimiter, join } from "node:path";
import {
  FileCustomProviderStore,
  FileProfileRepository,
  FileProviderAccountRepository,
  createAgentRegistry,
  createProviderRegistry,
  defaultProfilesPath,
  loadCustomProviderPorts,
  proxyBaseUrl,
  proxyPort,
} from "@swisscode/adapters";
import {
  ProfileError,
  collectSecretValues,
  redactEnv,
  resolveLaunchSpec,
  resolveProviderConfig,
  secretFieldKeys,
} from "@swisscode/core";
import type { LaunchSpec, Profile, ProviderAccount } from "@swisscode/core";
import { activateAccount, cmdAccounts } from "./accounts.js";
import { cmdProxy, ensureProxyAccount } from "./proxy.js";

const agents = createAgentRegistry();
const repo = new FileProfileRepository(defaultProfilesPath());

/** Registry = built-ins + stored customs (cached per process). */
let registryPromise: Promise<ReturnType<typeof createProviderRegistry>> | undefined;
async function providerRegistry() {
  registryPromise ??= (async () =>
    createProviderRegistry(await loadCustomProviderPorts(new FileCustomProviderStore())))();
  return registryPromise;
}

function help(): string {
  return [
    "swisscode — launch coding agents with the right env vars",
    "",
    "Usage:",
    "  swisscode <profileName> [--dry-run] [--force] [-- extra args...]",
    "  swisscode list",
    "  swisscode show <profileName>",
    "  swisscode accounts <import|list|usage|use|remove> ...",
    "  swisscode proxy <run|use|status> ...",
    "",
    "Profiles live in ~/.swisscode/profiles.json (or $SWISSCODE_HOME).",
    "Create them in the TanStack Start UI or by editing that file.",
  ].join("\n");
}

/** A profile plus the stored account (if any) whose config was merged in. */
interface ResolvedProfile {
  profile: Profile;
  /** Kept for redaction: every value it holds is a candidate secret. */
  account?: ProviderAccount;
}

/**
 * Merge a referenced provider account under the profile's inline config.
 * Launch and show share this so `show` can never describe a launch the
 * launcher would not produce. Throws ProfileError on a dangling reference.
 */
async function resolveProfileForLaunch(stored: Profile): Promise<ResolvedProfile> {
  if (!stored.providerAccountId) return { profile: stored };
  const accountStore = new FileProviderAccountRepository();
  const account = await accountStore.get(stored.providerId, stored.providerAccountId);
  return {
    profile: resolveProviderConfig(stored, () => account ?? undefined),
    account: account ?? undefined,
  };
}

/**
 * Values that must never reach a terminal: whatever is stored under a field the
 * provider declares secret (or whose key reads like one), from both the resolved
 * config and the account behind it. Name-based masking alone is not enough — a
 * custom provider can map its API key to any env name it likes (MY_PASSWORD).
 */
async function secretValues(resolved: ResolvedProfile): Promise<string[]> {
  const provider = (await providerRegistry()).get(resolved.profile.providerId);
  const secretKeys = secretFieldKeys(provider?.fields ?? []);
  return [resolved.profile.providerConfig, resolved.account?.config].flatMap((config) =>
    collectSecretValues(config, secretKeys),
  );
}

async function cmdList(): Promise<void> {
  const profiles = await repo.list();
  if (profiles.length === 0) {
    console.log(`No profiles yet. Store: ${repo.path}`);
    return;
  }
  for (const p of profiles) {
    console.log(`${p.name}\tagent=${p.agentId}\tprovider=${p.providerId}${p.model ? `\tmodel=${p.model}` : ""}`);
  }
}

async function cmdShow(name: string): Promise<void> {
  const stored = await repo.get(name);
  if (!stored) {
    console.error(`Unknown profile "${name}".`);
    process.exitCode = 1;
    return;
  }
  try {
    const resolved = await resolveProfileForLaunch(stored);
    const spec = resolveLaunchSpec(agents, await providerRegistry(), resolved.profile, {
      onDroppedEnv: reportDroppedEnv,
    });
    const secrets = await secretValues(resolved);
    // The stored profile is echoed (not the merged one) so an account's key
    // never appears here even unmasked; inline config is masked by the same rule.
    const profile = stored.providerConfig
      ? { ...stored, providerConfig: redactEnv(stored.providerConfig, secrets) }
      : stored;
    const launch = {
      ...spec,
      command: resolveExecutable(spec.command),
      env: redactEnv(launchEnv(resolved.profile, spec), secrets),
    };
    console.log(JSON.stringify({ profile, launch }, null, 2));
  } catch (err) {
    if (err instanceof ProfileError) {
      console.error(`Invalid profile "${name}": ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

/**
 * Tell the operator which stored env names the launcher refused. The refusal
 * itself is core's (resolveLaunchSpec strips them on both sides of
 * buildLaunch); this only gives it a voice.
 */
function reportDroppedEnv(name: string): void {
  console.error(`Ignoring env "${name}" from provider config — reserved by the launcher.`);
}

/** Proxy routing is a profile-only decision (validated at save time). */
function usesProxy(profile: Profile): boolean {
  return profile.providerId === "claude-subscription" && profile.useProxy === true;
}

/**
 * The env a launch actually applies. Proxy mode: the proxy strips client auth
 * and signs with the vault account, so ANTHROPIC_AUTH_TOKEN carries a profile
 * tag instead of a credential (read for traffic attribution, then discarded).
 * `show` and the launch path share this, so an inspection can never describe a
 * launch that would not happen.
 */
function launchEnv(profile: Profile, spec: LaunchSpec): Record<string, string> {
  // spec.env is already deny-list filtered by resolveLaunchSpec, and the two
  // keys added here are the launcher's own.
  if (!usesProxy(profile)) return spec.env;
  return {
    ...spec.env,
    ANTHROPIC_BASE_URL: proxyBaseUrl(),
    ANTHROPIC_AUTH_TOKEN: `swisscode-profile/${profile.name}`,
  };
}

/**
 * Resolve `command` against the PARENT process PATH and hand spawn an absolute
 * path. The child's env is built from stored provider config, so letting spawn
 * resolve the name there would let that data pick the binary. An explicit path
 * is used as-is; an unresolvable name is returned unchanged so the caller still
 * gets the usual ENOENT message.
 */
function resolveExecutable(command: string): string {
  if (command.includes("/")) return command;
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Missing or not executable here — keep searching the remaining entries.
    }
  }
  return command;
}

/** Signals a foreground launcher must relay, or the agent is orphaned. */
const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGINT"];

/** Shell convention: a process killed by signal N reports 128+N. */
function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (osConstants.signals[signal] ?? 0);
}

async function cmdLaunch(
  name: string,
  extraArgs: string[],
  dryRun: boolean,
  force: boolean,
): Promise<void> {
  const stored = await repo.get(name);
  if (!stored) {
    console.error(`Unknown profile "${name}". Run \`swisscode list\` to see profiles.`);
    process.exitCode = 1;
    return;
  }
  // Generic provider account reference: merge stored config under inline config.
  let resolved: ResolvedProfile;
  try {
    resolved = await resolveProfileForLaunch(stored);
  } catch (err) {
    if (err instanceof ProfileError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const profile = resolved.profile;
  // Subscription account binding: activate before resolving the launch.
  // Dry-run never touches the active credential store or the proxy.
  if (profile.providerId === "claude-subscription" && profile.subscriptionAccountId && !dryRun) {
    if (usesProxy(profile)) {
      const ok = await ensureProxyAccount(profile.subscriptionAccountId, proxyPort());
      if (!ok) return;
    } else {
      const ok = await activateAccount(profile.subscriptionAccountId, force);
      if (!ok) return;
    }
  }
  let spec;
  try {
    spec = resolveLaunchSpec(agents, await providerRegistry(), profile, {
      onDroppedEnv: reportDroppedEnv,
    });
  } catch (err) {
    if (err instanceof ProfileError) {
      console.error(`Invalid profile "${name}": ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const args = [...spec.args, ...extraArgs];
  const env = launchEnv(profile, spec);
  const command = resolveExecutable(spec.command);
  if (dryRun) {
    console.log(
      JSON.stringify({ command, args, env: redactEnv(env, await secretValues(resolved)) }, null, 2),
    );
    return;
  }
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  // Relay signals: without this a SIGTERM to swisscode leaves the agent running
  // with no parent. SIGINT is relayed too — the terminal already delivers it to
  // the foreground group, but a programmatic kill of swisscode alone does not.
  const relays = FORWARDED_SIGNALS.map(
    (signal) => [signal, () => void child.kill(signal)] as const,
  );
  for (const [signal, relay] of relays) process.on(signal, relay);
  const stopRelaying = () => {
    for (const [signal, relay] of relays) process.off(signal, relay);
  };
  child.on("error", (err: Error) => {
    stopRelaying();
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      console.error(`Cannot launch "${spec.command}": binary not found on PATH.`);
    } else {
      console.error(`Failed to launch "${spec.command}": ${err.message}`);
    }
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    stopRelaying();
    process.exitCode = signal ? signalExitCode(signal) : (code ?? 0);
  });
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  // Everything after the first "--" belongs to the agent, verbatim. Scanning it
  // for our own flags makes `swisscode p -- -h` print swisscode's help instead
  // of the agent's, and `swisscode p -- --dry-run` refuse to launch.
  const split = raw.indexOf("--");
  const head = split >= 0 ? raw.slice(0, split) : raw;
  const passthrough = split >= 0 ? raw.slice(split + 1) : [];
  if (head.length === 0 || head.includes("-h") || head.includes("--help")) {
    console.log(help());
    return;
  }
  const [first, ...rest] = head as [string, ...string[]];
  if (first === "list") return cmdList();
  if (first === "show") {
    if (!rest[0]) {
      console.error("Usage: swisscode show <profileName>");
      process.exitCode = 1;
      return;
    }
    return cmdShow(rest[0]);
  }
  if (first === "accounts") return cmdAccounts(rest);
  if (first === "proxy") return cmdProxy(rest);
  // Launch path: swisscode <profile> [--dry-run] [--force] [-- extra...]
  // A leading flag is an option we do not know, never a profile name.
  if (first.startsWith("-")) {
    console.error(`Unknown option "${first}".`);
    console.error(help());
    process.exitCode = 1;
    return;
  }
  const dryRun = rest.includes("--dry-run");
  const force = rest.includes("--force");
  const extraArgs = [
    ...rest.filter((a) => a !== "--dry-run" && a !== "--force"),
    ...passthrough,
  ];
  await cmdLaunch(first, extraArgs, dryRun, force);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
