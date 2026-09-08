// `swisscode proxy ...` — run the subscription proxy, switch its active
// account, or check its status. The proxy itself lives in @swisscode/adapters.

import { appendFile, readFile } from "node:fs/promises";
import {
  AnthropicOAuthClient,
  ClaudeActiveCredentialStore,
  DEFAULT_TRAFFIC_BODY_BYTES,
  FileAccountRepository,
  PROXY_TOKEN_REJECTED,
  ProxyControlClient,
  ProxyUnavailableError,
  SubscriptionProxy,
  createProxyToken,
  defaultProxyTokenPath,
  defaultSubscriptionsDir,
  defaultTrafficLogPath,
  proxyBaseUrl,
  proxyPort,
} from "@swisscode/adapters";
import type { ProxyTrafficEntry } from "@swisscode/adapters";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function proxyHelp(): string {
  return [
    "swisscode proxy <command>",
    "",
    "  run [--port <n>] [--traffic-log <path>|--no-traffic-log] [--log-bodies]",
    "      [--traffic-keep <n>] [--traffic-body-bytes <n>] [--log-body-bytes <n>]",
    "                          Run the subscription proxy (foreground). Each",
    "                          proxied request is appended as redacted JSONL",
    "                          (default ~/.swisscode/proxy-traffic.jsonl) and",
    "                          kept in a memory ring (default 200, 0 disables).",
    "                          Bodies are capped at 64KB per side by default;",
    "                          <n> sets the cap (0 = unlimited).",
    "                          Each run mints a control token (0600) that",
    "                          `use`/`status` send back on control requests.",
    "  use <id> [--port <n>]   Switch the proxy's active account",
    "  status [--port <n>]     Show proxy status and accounts",
    "  log [--tail <n>] [--traffic-log <path>]",
    "                          Show recent proxied requests (dev traffic view)",
  ].join("\n");
}

function trafficLine(e: ProxyTrafficEntry): string {
  const hops = e.attempts.map((a) => `${a.accountId}:${a.status}`).join("→") || "-";
  return `${e.ts} ${e.method} ${e.path} → ${e.status} ${e.ms}ms acct=${e.accountId ?? "-"} up=${e.reqBytes}B down=${e.resBytes}B [${hops}]${e.error ? ` err=${e.error}` : ""}`;
}

async function showTrafficLog(path: string, tail: number): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    console.error(`No traffic log yet at ${path}. Start the proxy with \`swisscode proxy run\`.`);
    process.exitCode = 1;
    return;
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines.slice(Math.max(0, lines.length - tail))) {
    try {
      console.log(trafficLine(JSON.parse(line) as ProxyTrafficEntry));
    } catch {
      console.log(line);
    }
  }
  if (lines.length === 0) console.log("(empty — no proxied requests yet)");
}

/**
 * Control-plane client for this invocation. The token read, the header, the
 * 401/403 reading and the "not running" message all live in adapters — the CLI
 * and the web UI must not diagnose the same dead proxy differently.
 */
function control(port: number): ProxyControlClient {
  return new ProxyControlClient({ baseUrl: proxyBaseUrl(port) });
}

/** The token path is the CLI's own advice: it is the file the user can fix. */
function controlErrorMessage(err: unknown): string {
  const message = (err as Error).message;
  return err instanceof ProxyUnavailableError && message === PROXY_TOKEN_REJECTED
    ? `${message} (token file: ${defaultProxyTokenPath()})`
    : message;
}

export async function proxyStatus(port: number): Promise<{ running: boolean; activeAccountId: string | null }> {
  const body = await control(port).status();
  console.log(`Proxy on :${port} — active: ${body.activeAccountId ?? "(none)"}`);
  for (const a of body.accounts ?? []) console.log(`  ${a.id}\t${a.label}`);
  return { running: body.running ?? true, activeAccountId: body.activeAccountId ?? null };
}

export async function proxyUse(id: string, port: number): Promise<boolean> {
  try {
    await control(port).use(id);
    console.log(`Proxy now using "${id}".`);
    return true;
  } catch (err) {
    console.error(controlErrorMessage(err));
    process.exitCode = 1;
    return false;
  }
}

/** Ensure the proxy is up and set to the account. False = caller should abort. */
export async function ensureProxyAccount(id: string, port: number): Promise<boolean> {
  return proxyUse(id, port);
}

export async function cmdProxy(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const port = proxyPort(flag(rest, "--port"));
  if (sub === "run") {
    const noLog = rest.includes("--no-traffic-log");
    const trafficLog = noLog ? undefined : (flag(rest, "--traffic-log") ?? defaultTrafficLogPath());
    const logBodies = rest.includes("--log-bodies");
    const keepRaw = flag(rest, "--traffic-keep") ?? process.env["SWISSCODE_TRAFFIC_KEEP"];
    const keep = keepRaw === undefined ? 200 : Math.max(0, parseInt(keepRaw, 10) || 0);
    const bodyBytes = (name: string, env: string, fallback: number): number => {
      const raw = flag(rest, name) ?? process.env[env];
      if (raw === undefined) return fallback;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : Number.POSITIVE_INFINITY;
    };
    // One token per run: a token that outlived its server would keep
    // authorizing after the port moved to something else.
    const controlToken = await createProxyToken();
    const proxy = new SubscriptionProxy(
      new FileAccountRepository(defaultSubscriptionsDir()),
      new AnthropicOAuthClient(),
      {
        logBodies,
        controlToken,
        // Adopt Claude Code's live lineage when the vault copy rotated away.
        liveStore: new ClaudeActiveCredentialStore(),
        trafficBufferSize: keep,
        trafficBodyBytes: bodyBytes("--traffic-body-bytes", "SWISSCODE_TRAFFIC_BODY_BYTES", DEFAULT_TRAFFIC_BODY_BYTES),
        maxLoggedBodyBytes: bodyBytes("--log-body-bytes", "SWISSCODE_LOG_BODY_BYTES", 8192),
        onTraffic: trafficLog
          ? (entry) => {
              console.log(trafficLine(entry));
              void appendFile(trafficLog, `${JSON.stringify(entry)}\n`).catch((err: Error) =>
                console.error(`traffic log write failed: ${err.message}`),
              );
            }
          : undefined,
      },
    );
    const count = (await proxy.status()).accounts.length;
    if (count === 0) {
      console.error("No subscription accounts stored. Run `swisscode accounts import <id>` first.");
      process.exitCode = 1;
      return;
    }
    await proxy.listen(port);
    console.log(`Subscription proxy on ${proxyBaseUrl(port)} (${count} account(s)). Ctrl-C to stop.`);
    if (trafficLog) console.log(`Traffic: ${trafficLog}${logBodies ? " (bodies on)" : ""}`);
    const shutdown = () => {
      void proxy.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {}); // run until signal
    return;
  }
  if (sub === "use" && rest[0]) {
    await proxyUse(rest[0] as string, port);
    return;
  }
  if (sub === "status") {
    try {
      await proxyStatus(port);
    } catch (err) {
      console.error(controlErrorMessage(err));
      process.exitCode = 1;
    }
    return;
  }
  if (sub === "log") {
    const rawTail = flag(rest, "--tail");
    const tail = rawTail ? Math.max(1, parseInt(rawTail, 10) || 20) : 20;
    await showTrafficLog(flag(rest, "--traffic-log") ?? defaultTrafficLogPath(), tail);
    return;
  }
  console.log(proxyHelp());
}
