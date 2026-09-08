#!/usr/bin/env node
// swisscode CLI — thin shell over the hexagonal core.
// Usage:
//   swisscode <profileName> [--dry-run] [-- extra args...]
//   swisscode list
//   swisscode show <profileName>

import { spawn } from "node:child_process";
import {
  FileCustomProviderStore,
  FileProfileRepository,
  createAgentRegistry,
  createProviderRegistry,
  defaultProfilesPath,
  loadCustomProviderPorts,
} from "@swisscode/adapters";
import { ProfileError, resolveLaunchSpec, resolveProviderConfig } from "@swisscode/core";
import { activateAccount, cmdAccounts } from "./accounts.js";
import { cmdProxy, ensureProxyAccount } from "./proxy.js";
import {
  FileProviderAccountRepository,
  proxyBaseUrl,
  proxyPort,
} from "@swisscode/adapters";

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

function redact(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = /TOKEN|KEY|SECRET/i.test(k) && v ? "***redacted***" : v;
  }
  return out;
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
  const profile = await repo.get(name);
  if (!profile) {
    console.error(`Unknown profile "${name}".`);
    process.exitCode = 1;
    return;
  }
  const spec = resolveLaunchSpec(agents, await providerRegistry(), profile);
  console.log(JSON.stringify({ profile, launch: { ...spec, env: redact(spec.env) } }, null, 2));
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
  let profile = stored;
  if (stored.providerAccountId) {
    const accountStore = new FileProviderAccountRepository();
    const account = await accountStore.get(stored.providerId, stored.providerAccountId);
    try {
      profile = resolveProviderConfig(stored, () => account ?? undefined);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }
  }
  // Subscription account binding: activate before resolving the launch.
  // Dry-run never touches the active credential store or the proxy.
  const useProxy = profile.providerId === "claude-subscription" && profile.useProxy === true;
  if (profile.providerId === "claude-subscription" && profile.subscriptionAccountId && !dryRun) {
    if (useProxy) {
      const ok = await ensureProxyAccount(profile.subscriptionAccountId, proxyPort());
      if (!ok) return;
    } else {
      const ok = await activateAccount(profile.subscriptionAccountId, force);
      if (!ok) return;
    }
  }
  let spec;
  try {
    spec = resolveLaunchSpec(agents, await providerRegistry(), profile);
  } catch (err) {
    if (err instanceof ProfileError) {
      console.error(`Invalid profile "${name}": ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const args = [...spec.args, ...extraArgs];
  const env = useProxy
    ? { ...spec.env, ANTHROPIC_BASE_URL: proxyBaseUrl() }
    : spec.env;
  if (dryRun) {
    console.log(JSON.stringify({ command: spec.command, args, env: redact(env) }, null, 2));
    return;
  }
  const child = spawn(spec.command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  child.on("error", (err: Error) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      console.error(`Cannot launch "${spec.command}": binary not found on PATH.`);
    } else {
      console.error(`Failed to launch "${spec.command}": ${err.message}`);
    }
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 0;
  });
}

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  if (raw.length === 0 || raw.includes("-h") || raw.includes("--help")) {
    console.log(help());
    return;
  }
  const [first, ...rest] = raw;
  if (first === "list") return cmdList();
  if (first === "show") {
    if (!rest[0]) {
      console.error("Usage: swisscode show <profileName>");
      process.exitCode = 1;
      return;
    }
    return cmdShow(rest[0] as string);
  }
  if (first === "accounts") return cmdAccounts(rest);
  if (first === "proxy") return cmdProxy(rest);
  // Launch path: swisscode <profile> [--dry-run] [--force] [-- extra...]
  const dryRun = rest.includes("--dry-run");
  const force = rest.includes("--force");
  const dashDash = rest.indexOf("--");
  const extraArgs =
    dashDash >= 0
      ? rest.slice(dashDash + 1)
      : rest.filter((a) => a !== "--dry-run" && a !== "--force");
  await cmdLaunch(first as string, extraArgs, dryRun, force);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
