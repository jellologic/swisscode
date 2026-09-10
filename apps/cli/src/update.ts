// Self-update for the npm install: check the registry, decide per updateMode
// plus install kind, and optionally apply `npm i -g swisscode@latest`.
//
// Safety shape: `off` never touches the network; `auto` only ever installs
// over an npm-global layout (a checkout degrades to a notify with a hint —
// `npm i -g` over a linked checkout would pave the user's symlink); every
// entry here is total (failures are data or silence, never throws out of
// ensureAutoUpdate) so a dead registry can never break a launch. All I/O is
// injected for hermetic tests — production defaults live in one place each.

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { FileSettingsStore } from "@swisscode/adapters";
import type { UpdateMode } from "@swisscode/core";
import { isNewerVersion } from "@swisscode/core";
import { currentVersion } from "./version.js";

/** How often a successful registry answer stays authoritative. */
export const UPDATE_CHECK_TTL_MS = 6 * 3600 * 1000;
/** The one network call self-update ever makes. */
export const REGISTRY_URL = "https://registry.npmjs.org/swisscode/latest";
/** Cap on the registry round-trip: a hanging check must not hang a launch. */
const REGISTRY_TIMEOUT_MS = 5000;
/** How far up from the bundle to look for a checkout marker. */
const ANCESTOR_WALK_LIMIT = 12;

export type InstallKind = "npm-global" | "git-checkout" | "linked-checkout" | "unknown";
export type UpdateDecision = "apply" | "notify" | "skip";

export interface UpdateCheck {
  current: string;
  latest: string;
  updateAvailable: boolean;
}

export interface UpdateCache {
  checkedAt: number;
  latest: string;
}

/** $SWISSCODE_HOME/update-check.json, same home rule as every other store. */
export function defaultUpdateCheckPath(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "update-check.json");
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Classify this install. A bundle reached through a symlink is a linked
 * checkout (npm-link style); a `.git` ancestor is a source checkout; under a
 * `node_modules` dir with no checkout marker is a real global install;
 * anything else is unknown and treated like a checkout (notify, never apply).
 */
export async function detectInstallKind(opts?: {
  /** Absolute path of the running bundle; defaults to this process's. */
  bundleFile?: string;
  dirExists?: (path: string) => Promise<boolean>;
  realpath?: (path: string) => Promise<string>;
}): Promise<InstallKind> {
  const exists = opts?.dirExists ?? dirExists;
  const resolveLink = opts?.realpath ?? realpath;
  const self = opts?.bundleFile ?? process.argv[1] ?? "";
  if (!self) return "unknown";
  let real = self;
  try {
    real = await resolveLink(self);
  } catch {
    return "unknown";
  }
  if (real !== self) return "linked-checkout";
  let dir = dirname(resolve(real));
  for (let i = 0; i < ANCESTOR_WALK_LIMIT; i++) {
    if (await exists(join(dir, ".git"))) return "git-checkout";
    const parent = dirname(dir);
    // node_modules/swisscode with no checkout above it: a true global install.
    if (parent.endsWith("node_modules") || dir.endsWith("node_modules")) return "npm-global";
    if (parent === dir) return "unknown";
    dir = parent;
  }
  return "unknown";
}

/** Pure policy: mode × kind × availability → what to do. */
export function decideUpdate(
  mode: UpdateMode,
  kind: InstallKind,
  updateAvailable: boolean,
): UpdateDecision {
  if (mode === "off" || !updateAvailable) return "skip";
  if (mode === "notify-only") return "notify";
  return kind === "npm-global" ? "apply" : "notify";
}

function asCache(value: unknown): UpdateCache | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { checkedAt, latest } = value as Record<string, unknown>;
  if (typeof checkedAt !== "number" || typeof latest !== "string" || latest === "") {
    return undefined;
  }
  return { checkedAt, latest };
}

/**
 * Registry check with a TTL'd file cache. Fresh cache answers with zero
 * network; any failure (offline, 404, timeout, torn cache) is silent null,
 * never a throw. `ttlMs: 0` forces a live check (used by `update --apply`).
 */
export async function checkForUpdate(opts?: {
  current?: string;
  fetchFn?: typeof fetch;
  nowMs?: number;
  ttlMs?: number;
  loadCache?: () => Promise<unknown>;
  saveCache?: (cache: UpdateCache) => Promise<void>;
}): Promise<UpdateCheck | null> {
  const current = opts?.current ?? currentVersion();
  const nowMs = opts?.nowMs ?? Date.now();
  const ttlMs = opts?.ttlMs ?? UPDATE_CHECK_TTL_MS;
  const loadCache =
    opts?.loadCache ??
    (async () => {
      try {
        return JSON.parse(await readFile(defaultUpdateCheckPath(), "utf8")) as unknown;
      } catch {
        return undefined;
      }
    });
  const saveCache =
    opts?.saveCache ??
    (async (cache: UpdateCache) => {
      try {
        const path = defaultUpdateCheckPath();
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, JSON.stringify(cache), { mode: 0o600 });
      } catch {
        // A read-only home must not fail the check that just succeeded.
      }
    });
  if (ttlMs > 0) {
    try {
      const cached = asCache(await loadCache());
      if (cached && nowMs - cached.checkedAt < ttlMs) {
        return {
          current,
          latest: cached.latest,
          updateAvailable: isNewerVersion(cached.latest, current),
        };
      }
    } catch {
      // Torn cache reads as a miss.
    }
  }
  try {
    const fetchFn = opts?.fetchFn ?? fetch;
    const res = await fetchFn(REGISTRY_URL, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    if (!res.ok) return null;
    const latest = (await res.json() as { version?: unknown })?.version;
    if (typeof latest !== "string" || latest === "") return null;
    const cache = { checkedAt: nowMs, latest };
    await saveCache(cache);
    return { current, latest, updateAvailable: isNewerVersion(latest, current) };
  } catch {
    return null;
  }
}

export interface ApplyResult {
  ok: boolean;
  message?: string;
}

/**
 * Install the latest release over a global install. Expected failure (npm
 * exits nonzero, registry hiccup) is data; unexpected throws propagate so a
 * broken execFn surfaces in tests rather than masquerading as "npm failed".
 */
export async function applyGlobalUpdate(opts?: {
  execFn?: (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}): Promise<ApplyResult> {
  const execFileAsync = promisify(execFile);
  const execFn =
    opts?.execFn ??
    (async (command: string, args: string[]) => {
      const { stdout, stderr } = await execFileAsync(command, args);
      return { stdout: String(stdout), stderr: String(stderr) };
    });
  try {
    await execFn("npm", ["i", "-g", "swisscode@latest"]);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export interface AutoUpdateResult {
  decision: UpdateDecision;
  current: string;
  latest?: string;
  /** Caller prints this on stderr (stdout may be machine-readable JSON). */
  notice?: string;
  applied?: boolean;
}

function checkoutHint(): string {
  return "This checkout never self-modifies — `git pull` (or your package manager) to upgrade.";
}

/**
 * One background pass: settings → kind → (cached) check → apply or notice.
 * Never throws and never touches the network when mode is off. Callers
 * fire-and-forget it (`void`) so a slow registry cannot delay a launch; the
 * returned notice (if any) is theirs to print.
 */
export async function ensureAutoUpdate(opts?: {
  loadMode?: () => Promise<UpdateMode>;
  detect?: () => Promise<InstallKind>;
  check?: () => Promise<UpdateCheck | null>;
  apply?: () => Promise<ApplyResult>;
}): Promise<AutoUpdateResult> {
  const current = currentVersion();
  try {
    const mode = (await (opts?.loadMode ?? defaultLoadMode)()) ?? "auto";
    if (mode === "off") return { decision: "skip", current };
    const kind = await (opts?.detect ?? detectInstallKind)();
    const checked = await (opts?.check ?? (() => checkForUpdate()))();
    if (!checked) return { decision: "skip", current };
    const decision = decideUpdate(mode, kind, checked.updateAvailable);
    if (decision === "skip") return { decision, current, latest: checked.latest };
    if (decision === "notify") {
      const hint = kind === "npm-global" ? "" : ` ${checkoutHint()}`;
      return {
        decision,
        current,
        latest: checked.latest,
        notice: `Update available: swisscode ${checked.current} → ${checked.latest}.${hint}`,
      };
    }
    const applied = await (opts?.apply ?? (() => applyGlobalUpdate()))();
    if (applied.ok) {
      return {
        decision,
        current,
        latest: checked.latest,
        applied: true,
        notice: `Updated swisscode ${checked.current} → ${checked.latest} — restarting UI…`,
      };
    }
    return {
      decision: "notify",
      current,
      latest: checked.latest,
      notice: `Update available: swisscode ${checked.current} → ${checked.latest} (automatic install failed: ${applied.message ?? "unknown error"}).`,
    };
  } catch {
    return { decision: "skip", current };
  }
}

async function defaultLoadMode(): Promise<UpdateMode> {
  try {
    return (await new FileSettingsStore().get()).updateMode ?? "auto";
  } catch {
    return "auto";
  }
}

function updateHelp(): string {
  return [
    "swisscode update [--check|--apply]",
    "",
    "  --check  Show the installed version against the latest release (default).",
    "           Respects the /settings self-update mode: off makes zero requests.",
    "  --apply  Install the latest release now. Only applies to npm-global",
    "           installs; checkouts print an upgrade hint instead and are never",
    "           modified. Works even when the self-update mode is off.",
  ].join("\n");
}

/**
 * Manual escape hatch: `swisscode update [--check|--apply]`. Expected
 * failures print to stderr with exitCode 1 (repo CLI convention), never throw.
 * Every collaborator is injectable so tests never touch the network, npm, or
 * the real home dir — production defaults are the same ones main() uses.
 */
export async function cmdUpdate(
  args: string[],
  opts?: {
    loadMode?: () => Promise<UpdateMode>;
    check?: (checkOpts?: { ttlMs?: number }) => Promise<UpdateCheck | null>;
    detect?: () => Promise<InstallKind>;
    apply?: () => Promise<ApplyResult>;
  },
): Promise<void> {
  if (args.includes("-h") || args.includes("--help")) {
    console.log(updateHelp());
    return;
  }
  const apply = args.includes("--apply");
  const loadMode =
    opts?.loadMode ??
    (async () => {
      try {
        return (await new FileSettingsStore().get()).updateMode ?? "auto";
      } catch {
        // Torn settings read as auto for an explicit user request.
        return "auto" as UpdateMode;
      }
    });
  let mode: UpdateMode = "auto";
  try {
    mode = await loadMode();
  } catch {
    // A failing loader reads as auto for an explicit user request.
  }
  if (!apply && mode === "off") {
    console.log(`swisscode ${currentVersion()} (update checks are off — enable in /settings to compare against the latest release).`);
    return;
  }
  const checked = await (opts?.check ?? ((o) => checkForUpdate(o)))({
    ttlMs: apply ? 0 : undefined,
  });
  if (!checked) {
    console.error("Could not reach the npm registry. Retry later or install manually with `npm i -g swisscode@latest`.");
    process.exitCode = 1;
    return;
  }
  if (!checked.updateAvailable) {
    console.log(`swisscode ${checked.current} is the latest release.`);
    return;
  }
  if (!apply) {
    console.log(`Update available: swisscode ${checked.current} → ${checked.latest}. Run \`swisscode update --apply\` to install.`);
    return;
  }
  const kind = await (opts?.detect ?? detectInstallKind)();
  if (kind !== "npm-global") {
    console.error(`Update available: swisscode ${checked.current} → ${checked.latest}. ${checkoutHint()}`);
    process.exitCode = 1;
    return;
  }
  const result = await (opts?.apply ?? (() => applyGlobalUpdate()))();
  if (result.ok) {
    console.log(`Updated swisscode ${checked.current} → ${checked.latest}.`);
    return;
  }
  console.error(`Automatic install failed: ${result.message ?? "unknown error"}. Retry later or run \`npm i -g swisscode@latest\`.`);
  process.exitCode = 1;
}
