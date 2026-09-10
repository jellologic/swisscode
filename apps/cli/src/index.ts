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
  FileAccountRepository,
  FileCustomProviderStore,
  FileProfileRepository,
  FileProviderAccountRepository,
  createAgentRegistry,
  createProviderRegistry,
  defaultProfilesPath,
  defaultSubscriptionsDir,
  defaultTrafficStorePath,
  loadCustomProviderPorts,
  makeEphemeralDir,
  openTrafficStore,
  proxyLaunchEnv,
  proxyPort,
  usesProxy,
  writeEphemeralFiles,
} from "@swisscode/adapters";
import {
  ProfileError,
  SPEND_ESTIMATE_NOTE,
  collectSecretValues,
  describeModelRoute,
  formatSpend,
  redactEnv,
  resolveEphemeralPaths,
  resolveLaunchSpec,
  resolveProviderConfig,
  secretFieldKeys,
  spendRollup,
  spendTotal,
  suggestInsights,
} from "@swisscode/core";
import type { LaunchSpec, ModelRouteLabels, Profile, ProviderAccount } from "@swisscode/core";
import { activateAccount, cmdAccounts } from "./accounts.js";
import { checkProxyUp, cmdProxy, ensureProxyAccount } from "./proxy.js";
import { cmdInit } from "./init.js";
import { cmdWeb } from "./web.js";
import { cmdUpdate, ensureAutoUpdate } from "./update.js";
import { currentVersion } from "./version.js";

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
  "  swisscode web [--port <n>] [--proxy-port <n>] [--no-proxy]",
    "  swisscode init [<preset>] [--name <name>] [--dry-run]",
  "  swisscode update [--check|--apply]",
  "  swisscode --version",
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
    const routes = p.modelRoutes?.length ? `\troutes=${p.modelRoutes.length}` : "";
    console.log(
      `${p.name}\tagent=${p.agentId}\tprovider=${p.providerId}${p.model ? `\tmodel=${p.model}` : ""}${p.direct === true ? "\tdirect" : ""}${routes}`,
    );
  }
}

/**
 * Labels for describeModelRoute, read live from the stores so a renamed
 * account shows under its current label. Missing entries fall back to raw
 * ids inside the renderer — never blank, never throwing here.
 */
async function routeLabels(): Promise<ModelRouteLabels> {
  const [vault, keys, registry] = await Promise.all([
    new FileAccountRepository(defaultSubscriptionsDir()).list().catch(() => []),
    new FileProviderAccountRepository().list().catch(() => []),
    providerRegistry(),
  ]);
  const vaultById = new Map(vault.map((a) => [a.id, a.label]));
  const keyById = new Map(keys.map((a) => [`${a.providerId}:${a.id}`, a.label]));
  const providerName = new Map(registry.list().map((p) => [p.id, p.displayName]));
  return {
    subscriptionAccountLabel: (id) => vaultById.get(id),
    providerAccountLabel: (providerId, id) => keyById.get(`${providerId}:${id}`),
    providerDisplayName: (providerId) => providerName.get(providerId),
  };
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
    // Spend at a glance over the same store `proxy report` reads, scoped to
    // this profile. A home that never ran the proxy has no store file — that
    // degrades to null, not an error; a present-but-unreadable store warns.
    const { spend, suggestions } = await profileSpend(name, resolved.profile.modelRoutes ?? []);
    // Routes read as sentences (the same renderer the web form will use),
    // not raw JSON — the match string alone says nothing about destination.
    const labels = await routeLabels();
    const routes = (resolved.profile.modelRoutes ?? []).map((r) => describeModelRoute(r, labels));
    console.log(JSON.stringify({ profile, launch, routes, spend, suggestions }, null, 2));
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
 * Estimated spend + read-only suggestions for one profile, from stored proxy
 * traffic. Null when the proxy never ran here (no store file yet).
 */
async function profileSpend(
  profileName: string,
  routes: { match: string }[],
): Promise<{
  spend: {
    requests: number;
    estSpendUsd: number;
    estSpend: string;
    pricedRequests: number;
    unpricedRequests: number;
    note: string;
  } | null;
  suggestions: string[];
}> {
  try {
    statSync(defaultTrafficStorePath());
  } catch {
    return { spend: null, suggestions: [] };
  }
  let store;
  try {
    store = await openTrafficStore(defaultTrafficStorePath());
  } catch (err) {
    console.error(`Cannot open the traffic store (${(err as Error).message}); spend unavailable.`);
    return { spend: null, suggestions: [] };
  }
  try {
    const filter = { profile: profileName, limit: 0 } as const;
    const entries = await store.query(filter);
    if (entries.length === 0) return { spend: null, suggestions: [] };
    const total = spendTotal(entries);
    const byRoute = await store.rollup(filter, "route");
    const spendLookup: Record<string, number> = {};
    for (const row of spendRollup(entries, "route")) spendLookup[row.key] = row.estSpendUsd;
    return {
      spend: {
        requests: total.requests,
        estSpendUsd: total.estSpendUsd,
        estSpend: formatSpend(total.estSpendUsd),
        pricedRequests: total.pricedRequests,
        unpricedRequests: total.unpricedRequests,
        note: SPEND_ESTIMATE_NOTE,
      },
      suggestions: suggestInsights(byRoute, spendLookup, {
        configuredRoutes: routes.map((r) => r.match),
        windowLabel: "in stored history",
      }),
    };
  } finally {
    store.close();
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

/**
 * The env a launch actually applies: the shared adapters rewrite over the
 * resolved spec env, so `show`, the launch path and the web Preview modal all
 * describe the launch that would actually happen.
 */
function launchEnv(profile: Profile, spec: LaunchSpec): Record<string, string> {
  return proxyLaunchEnv(profile, spec.env);
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
  // Proxy-mode profiles need a live proxy before the agent spawns — a silent
  // direct fallback would bill (or leak to) the wrong upstream. Key profiles
  // and account-less subscription profiles only ping it; a bound subscription
  // account also selects itself via the control plane (which proves liveness).
  // Dry-run never touches the active credential store or the proxy.
  if (!dryRun) {
    if (usesProxy(profile)) {
      const ok =
        profile.providerId === "claude-subscription" && profile.subscriptionAccountId
          ? await ensureProxyAccount(profile.subscriptionAccountId, proxyPort())
          : await checkProxyUp(proxyPort());
      if (!ok) return;
    } else if (profile.providerId === "claude-subscription" && profile.subscriptionAccountId) {
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
  let args = [...spec.args, ...extraArgs];
  const env = launchEnv(profile, spec);
  const command = resolveExecutable(spec.command);
  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          command,
          args,
          env: redactEnv(env, await secretValues(resolved)),
          ephemeralFiles: spec.ephemeralFiles ?? [],
          ...(spec.cwd ? { cwd: spec.cwd } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  // The working directory is a spawn option, not env: fail loudly when it is
  // gone instead of letting spawn surface a misleading "binary not found".
  if (spec.cwd) {
    try {
      if (!statSync(spec.cwd).isDirectory()) throw new Error("not a directory");
    } catch {
      console.error(`Working directory "${spec.cwd}" from profile "${name}" is missing or not a directory.`);
      process.exitCode = 1;
      return;
    }
  }
  // Session files materialize for real launches only: show/--dry-run render
  // the EPHEMERAL_DIR_TOKEN placeholder plus the file contents, never paths.
  if (spec.ephemeralFiles && spec.ephemeralFiles.length > 0) {
    try {
      const dir = await makeEphemeralDir();
      await writeEphemeralFiles(spec.ephemeralFiles, dir);
      args = resolveEphemeralPaths(args, dir);
    } catch (err) {
      console.error(`Could not stage session files: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
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
  if (first === "--version" || first === "-V") {
    console.log(currentVersion());
    return;
  }
  // Background self-update check: fire-and-forget (a slow registry must not
  // delay a launch), stderr only — stdout may be machine-readable JSON. Past
  // this point --version/--help already returned; the long-lived `web`
  // command owns its own pass (it can restart the UI child), and `update`
  // already checked explicitly.
  if (first !== "web" && first !== "update") {
    void ensureAutoUpdate().then((r) => {
      if (r.notice) console.error(r.notice);
    });
  }
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
  if (first === "web") return cmdWeb(rest);
  if (first === "init") return cmdInit(rest);
  if (first === "update") return cmdUpdate(rest);
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
