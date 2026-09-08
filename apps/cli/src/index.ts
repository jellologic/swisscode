#!/usr/bin/env node
// swisscode CLI — thin shell over the hexagonal core.
// Usage:
//   swisscode <profileName> [--dry-run] [-- extra args...]
//   swisscode list
//   swisscode show <profileName>

import { spawn } from "node:child_process";
import {
  FileProfileRepository,
  createAgentRegistry,
  createProviderRegistry,
  defaultProfilesPath,
} from "@swisscode/adapters";
import { ProfileError, resolveLaunchSpec } from "@swisscode/core";

const agents = createAgentRegistry();
const providers = createProviderRegistry();
const repo = new FileProfileRepository(defaultProfilesPath());

function help(): string {
  return [
    "swisscode — launch coding agents with the right env vars",
    "",
    "Usage:",
    "  swisscode <profileName> [--dry-run] [-- extra args...]",
    "  swisscode list",
    "  swisscode show <profileName>",
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
  const spec = resolveLaunchSpec(agents, providers, profile);
  console.log(JSON.stringify({ profile, launch: { ...spec, env: redact(spec.env) } }, null, 2));
}

async function cmdLaunch(name: string, extraArgs: string[], dryRun: boolean): Promise<void> {
  const profile = await repo.get(name);
  if (!profile) {
    console.error(`Unknown profile "${name}". Run \`swisscode list\` to see profiles.`);
    process.exitCode = 1;
    return;
  }
  let spec;
  try {
    spec = resolveLaunchSpec(agents, providers, profile);
  } catch (err) {
    if (err instanceof ProfileError) {
      console.error(`Invalid profile "${name}": ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  const args = [...spec.args, ...extraArgs];
  if (dryRun) {
    console.log(JSON.stringify({ command: spec.command, args, env: redact(spec.env) }, null, 2));
    return;
  }
  const child = spawn(spec.command, args, {
    stdio: "inherit",
    env: { ...process.env, ...spec.env },
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
  // Launch path: swisscode <profile> [--dry-run] [-- extra...]
  const dryRun = rest.includes("--dry-run");
  const dashDash = rest.indexOf("--");
  const extraArgs =
    dashDash >= 0
      ? rest.slice(dashDash + 1)
      : rest.filter((a) => a !== "--dry-run");
  await cmdLaunch(first as string, extraArgs, dryRun);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
