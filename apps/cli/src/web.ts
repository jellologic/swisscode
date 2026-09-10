// `swisscode web` — web UI plus subscription proxy in one foreground process.
// The proxy runs in-process (same construction as `proxy run`); the UI runs as
// a child (`node server.mjs` with cwd=apps/web). Ctrl-C stops both, in order.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProxyControlClient,
  ProxyUnavailableError,
  proxyBaseUrl,
  proxyPort,
} from "@swisscode/adapters";
import { startOwnedProxy } from "./proxy.js";
import type { OwnedProxy } from "./proxy.js";
import { ensureAutoUpdate } from "./update.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function webHelp(): string {
  return [
    "swisscode web [--port <n>] [--proxy-port <n>] [--no-proxy]",
    "",
    "  Run the web UI and the subscription proxy together (foreground).",
    "  Create accounts and profiles in the browser, then launch them with",
    "  `swisscode <profileName>`. Prints both URLs; Ctrl-C stops everything.",
    "  UI port defaults to 8124 (next to the 8123 proxy default); a live proxy",
    "  on the proxy port is reused, never replaced. Flags after",
    "  `--` are ignored, not forwarded. `--no-proxy` runs the UI alone;",
    "  proxy pages then show not-running until `swisscode proxy run` starts.",
  ].join("\n");
}

/** Shell convention: a process killed by signal N reports 128+N. */
function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + (osConstants.signals[signal] ?? 0);
}

function parsePort(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid ${name} "${raw}". Use 1-65535.`);
  }
  return n;
}

/**
 * Locate the built web UI. The bundled CLI resolves from its own file, never
 * the invocation directory — `swisscode web` must work from anywhere. An
 * explicit SWISSCODE_WEB_ROOT that fails validation is a user error, not a
 * cue to keep searching: fail fast naming the override.
 */
async function resolveWebDir(): Promise<string> {
  const attempted: string[] = [];
  const likeRoot = async (dir: string): Promise<boolean> => {
    attempted.push(dir);
    try {
      await stat(join(dir, "server.mjs"));
      await stat(join(dir, "dist", "server", "server.js"));
      return true;
    } catch {
      return false;
    }
  };
  const override = process.env["SWISSCODE_WEB_ROOT"];
  if (override) {
    if (await likeRoot(override)) return override;
    throw new Error(
      `SWISSCODE_WEB_ROOT=${override} has no built web UI. Build it with \`npm run build -w @swisscode/web\`.`,
    );
  }
  const fromBundle = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
  if (await likeRoot(fromBundle)) return fromBundle;
  // Embedded artifact: a true global install ships the built UI at the
  // package root beside dist (apps/cli `files` includes `web/`), so the
  // bundle at <root>/dist/bundle.js resolves <root>/web.
  const fromEmbed = join(dirname(fileURLToPath(import.meta.url)), "..", "web");
  if (await likeRoot(fromEmbed)) return fromEmbed;
  const fromCwd = join(process.cwd(), "apps", "web");
  if (await likeRoot(fromCwd)) return fromCwd;
  if (await likeRoot(process.cwd())) return process.cwd();
  throw new Error(
    `Cannot find the built web UI (looked in ${attempted.join(", ")}). Build it with \`npm run build -w @swisscode/web\` or run \`swisscode web\` from a monorepo checkout.`,
  );
}

/** True when a swisscode proxy already answers on the port. Other errors throw. */
async function proxyAlive(port: number): Promise<boolean> {
  try {
    await new ProxyControlClient({ baseUrl: proxyBaseUrl(port) }).status();
    return true;
  } catch (err) {
    if (err instanceof ProxyUnavailableError) return false;
    throw err;
  }
}

export async function cmdWeb(args: string[]): Promise<void> {
  const uiPort = parsePort(
    flag(args, "--port") ?? process.env["PORT"],
    "--port",
    8124,
  );
  const pport = parsePort(flag(args, "--proxy-port"), "--proxy-port", proxyPort());
  const noProxy = args.includes("--no-proxy");
  // Missing build aborts before the proxy is probed or a token is minted.
  let webDir = await resolveWebDir();
  let owned: OwnedProxy | undefined;
  if (!noProxy) {
    if (await proxyAlive(pport)) {
      console.log(`Reusing running proxy on ${proxyBaseUrl(pport)}.`);
    } else {
      owned = await startOwnedProxy(pport, []);
      if (!owned) return; // no-accounts abort is already reported
      console.log(
        `Subscription proxy on ${proxyBaseUrl(pport)} (${owned.vaultCount} vault account(s), ${owned.keyCount} key account(s)).`,
      );
    }
  } else {
    console.log("Proxy disabled (--no-proxy): proxy pages will show not-running.");
  }
  const host = process.env["SWISSCODE_WEB_HOST"] ?? "127.0.0.1";
  // One deferred unblocks the foreground wait from either trigger: our signal
  // (kill child, then close what we own) or the child's own exit (crash or a
  // taken UI port — the inherited stderr already shows why).
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let exitCode = 0;
  let signalled = false;
  let lastSignal: NodeJS.Signals | null = null;
  const closeOwned = async (): Promise<void> => {
    try {
      owned?.trafficStore?.close();
    } catch {
      // Already closing down — the original trigger is what matters.
    }
    if (owned) {
      try {
        await owned.proxy.close();
      } catch {
        // Same: report the trigger, not the teardown.
      }
    }
  };
  // The UI child is restartable (self-update swaps the files under it), so the
  // spawn + exit wiring is a function and every exit handler carries the
  // generation it was born in. A superseded child resolves nothing — the
  // restart owns what happens next.
  let generation = 0;
  let child: ChildProcess;
  const watchChild = (proc: ChildProcess, myGeneration: number): void => {
    proc.once("exit", (code, signal) => {
      if (myGeneration !== generation) return;
      void closeOwned().finally(() => {
        if (!signalled) {
          if (code !== 0 && code !== null) {
            console.error(`Web UI exited with code ${code}. If the port is taken, retry with --port <n>.`);
          }
          exitCode = signal ? signalExitCode(signal) : (code ?? 0);
        }
        resolveDone();
      });
    });
  };
  const spawnUI = (): void => {
    const myGeneration = ++generation;
    child = spawn(process.execPath, ["server.mjs"], {
      cwd: webDir,
      env: { ...process.env, PORT: String(uiPort), SWISSCODE_PROXY_PORT: String(pport) },
      stdio: "inherit",
    });
    watchChild(child, myGeneration);
  };
  spawnUI();
  console.log(`Web UI on http://${host}:${uiPort}. Ctrl-C to stop.`);
  /**
   * Restart only the UI child onto freshly installed files. The in-process
   * proxy keeps running; the user's `claude` sessions are untouched. A stop
   * signal landing mid-restart wins: no respawn, normal teardown instead.
   */
  const restartUI = async (latest: string): Promise<void> => {
    let freshDir: string;
    try {
      freshDir = await resolveWebDir();
    } catch {
      return; // New files unresolvable — stay on the running child.
    }
    console.error(`Updated swisscode to ${latest} — restarting UI…`);
    generation++; // detach the old child's exit handler
    const prev = child;
    const exited = new Promise<void>((resolve) => prev.once("exit", () => resolve()));
    try {
      prev.kill("SIGTERM");
    } catch {
      // Already gone — the wait below returns at once.
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (prev.exitCode === null && prev.signalCode === null) {
      try {
        prev.kill("SIGKILL");
      } catch {
        // The exit wait still settles teardown.
      }
      await exited;
    }
    if (signalled) {
      exitCode = lastSignal ? signalExitCode(lastSignal) : 0;
      await closeOwned();
      resolveDone();
      return;
    }
    webDir = freshDir;
    spawnUI();
  };
  // This command's own update pass: apply restarts the child above, anything
  // else is a stderr line. Fire-and-forget — UI startup never waits on it.
  void ensureAutoUpdate().then((r) => {
    if (r.applied && r.latest) void restartUI(r.latest);
    else if (r.notice) console.error(r.notice);
  });
  const onSignal = (signal: NodeJS.Signals): void => {
    if (signalled) return;
    signalled = true;
    lastSignal = signal;
    try {
      child.kill(signal);
    } catch {
      // Already gone — the exit handler still runs teardown.
    }
    // A wedged child must not hold the terminal forever.
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The exit handler still runs teardown.
      }
    }, 5000).unref();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  await done;
  process.exitCode = exitCode;
}
