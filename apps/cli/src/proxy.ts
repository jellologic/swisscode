// `swisscode proxy ...` — run the subscription proxy, switch its active
// account, or check its status. The proxy itself lives in @swisscode/adapters.

import { appendFile, readFile, stat } from "node:fs/promises";
import {
  AnthropicOAuthClient,
  AnthropicUsageClient,
  CachingUsageClient,
  ClaudeActiveCredentialStore,
  DEFAULT_TRAFFIC_BODY_BYTES,
  FileAccountRepository,
  FileCustomProviderStore,
  FileProfileRepository,
  FileProviderAccountRepository,
  FileSettingsStore,
  FileUsageCache,
  PROXY_TOKEN_REJECTED,
  ProxyControlClient,
  ProxyUnavailableError,
  SqliteTrafficLog,
  SubscriptionProxy,
  createProxyToken,
  createProviderRegistry,
  defaultProxyTokenPath,
  defaultSubscriptionsDir,
  defaultTrafficLogPath,
  defaultTrafficStorePath,
  loadCustomProviderPorts,
  openTrafficStore,
  proxyBaseUrl,
  proxyPort,
  vaultIdentityResolver,
} from "@swisscode/adapters";
import type { ProxyTrafficEntry } from "@swisscode/adapters";
import { SPEND_ESTIMATE_NOTE, formatSpend, matchTrafficFilter, spendRollup, suggestInsights } from "@swisscode/core";
import type { RotationStrategy, TrafficFilter, TrafficRollupGrain } from "@swisscode/core";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function proxyHelp(): string {
  return [
    "swisscode proxy <command>",
    "",
    "  run [--port <n>] [--traffic-log <path>|--no-traffic-log] [--traffic-store <path>]",
    "      [--log-bodies] [--traffic-keep <n>] [--traffic-body-bytes <n>] [--log-body-bytes <n>]",
    "      [--rotation on|off] [--rotation-strategy reset-soonest|least-used]",
    "      [--rotation-poll-ms <ms>]",
    "                          Run the subscription proxy (foreground). Each",
    "                          proxied request is appended as redacted JSONL",
    "                          (default ~/.swisscode/proxy-traffic.jsonl) and",
    "                          indexed as scalar facts in SQLite (default",
    "                          ~/.swisscode/proxy-traffic.sqlite) for `report`;",
    "                          --no-traffic-log disables both. Recent entries",
    "                          are also kept in a memory ring (default 200,",
    "                          0 disables). Bodies are capped",
    "                          at 64KB per side by default; <n> sets the cap",
    "                          (0 = unlimited). Retention: SWISSCODE_TRAFFIC_STORE_DAYS",
    "                          (default 30) and SWISSCODE_TRAFFIC_STORE_ROWS",
    "                          (default 100000), 0 keeps everything.",
    "                          Each run mints a control token (0600) that",
    "                          `use`/`status` send back on control requests.",
    "                          Background rotation polls each vault account's",
    "                          usage (default every 5 min, min 60s) and rolls",
    "                          the active account to the reset-soonest (or",
    "                          least-used) one. Default off; the flags beat",
    "                          SWISSCODE_ROTATION_ENABLED/STRATEGY/POLL_MS,",
    "                          which beat the /settings toggle — and the toggle",
    "                          applies live, no restart needed.",
    "  use <id> [--port <n>]   Switch the proxy's active account",
    "  status [--port <n>]     Show proxy status and accounts",
    "  log [--tail <n>] [--traffic-log <path>] [--profile <name>] [--route <id>]",
    "      [--since <iso>] [--errors]",
    "                          Show recent proxied requests (dev traffic view),",
    "                          newest last, optionally filtered.",
    "  report [--profile <name>] [--days <n>] [--by profile|route|day]",
    "      [--traffic-store <path>]",
    "                          Roll up recorded traffic: requests, errors, latency",
    "                          percentiles, token totals, estimated spend, and",
    "                          read-only route suggestions. Spend is estimated",
    "                          from a static per-model price table — not a bill.",
    "",
    "Profile identity: launches point at <base>/p/<profileName> (path wins)",
    "or send the swisscode-profile/<name> auth tag (fallback). A path/tag",
    "mismatch is noted on the traffic entry, never trusted silently.",
    "Profiles with direct:true skip the proxy entirely.",
  ].join("\n");
}

function trafficLine(e: ProxyTrafficEntry): string {
  const hops = e.attempts.map((a) => `${a.accountId}:${a.status}`).join("→") || "-";
  const route = e.route ? ` route=${e.route}${e.upstreamModel ? ` sent=${e.upstreamModel}` : ""}` : "";
  return `${e.ts} ${e.method} ${e.path} → ${e.status} ${e.ms}ms prof=${e.profile ?? "-"}${route} acct=${e.accountId ?? "-"} up=${e.reqBytes}B down=${e.resBytes}B [${hops}]${e.error ? ` err=${e.error}` : ""}${e.note ? ` note=${e.note}` : ""}`;
}

/**
 * Shared report filters for `log` and `report`: both surfaces build the same
 * core filter object, so the JSONL tail and the SQLite rollup answer the same
 * questions. `filtering` tells the log reader whether unparseable lines are
 * still worth showing raw (unfiltered tail) or must be skipped (a filter the
 * line cannot satisfy).
 */
function trafficFilterFromArgs(rest: string[]): { filter: TrafficFilter; filtering: boolean } {
  const filter: TrafficFilter = {};
  let filtering = false;
  const profile = flag(rest, "--profile");
  if (profile !== undefined) {
    filter.profile = profile;
    filtering = true;
  }
  const route = flag(rest, "--route");
  if (route !== undefined) {
    filter.route = route;
    filtering = true;
  }
  const since = flag(rest, "--since");
  if (since !== undefined) {
    filter.since = since;
    filtering = true;
  }
  if (rest.includes("--errors")) {
    filter.errorsOnly = true;
    filtering = true;
  }
  return { filter, filtering };
}

async function showTrafficLog(
  path: string,
  tail: number,
  filter: TrafficFilter,
  filtering: boolean,
): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    console.error(`No traffic log yet at ${path}. Start the proxy with \`swisscode proxy run\`.`);
    process.exitCode = 1;
    return;
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const rows: string[] = [];
  for (const line of lines) {
    let entry: ProxyTrafficEntry;
    try {
      entry = JSON.parse(line) as ProxyTrafficEntry;
    } catch {
      if (!filtering) rows.push(line);
      continue;
    }
    if (filtering && !matchTrafficFilter(entry, filter)) continue;
    rows.push(trafficLine(entry));
  }
  for (const row of rows.slice(Math.max(0, rows.length - tail))) console.log(row);
  if (rows.length === 0) {
    console.log(filtering ? "(no matching requests)" : "(empty — no proxied requests yet)");
  }
}

async function showTrafficReport(
  storePath: string,
  filter: TrafficFilter,
  grain: TrafficRollupGrain,
  windowLabel?: string,
): Promise<void> {
  // Stat first: opening would create an empty DB as a side effect, and a
  // home that never ran the proxy deserves guidance, not a stray file.
  try {
    await stat(storePath);
  } catch {
    console.error(
      `No queryable traffic store yet at ${storePath}. Start the proxy with \`swisscode proxy run\`.`,
    );
    process.exitCode = 1;
    return;
  }
  let store: SqliteTrafficLog;
  try {
    store = await openTrafficStore(storePath);
  } catch (err) {
    console.error(`Cannot open the traffic store at ${storePath} (${(err as Error).message}).`);
    process.exitCode = 1;
    return;
  }
  try {
    const rows = await store.rollup(filter, grain);
    if (rows.length === 0) {
      console.log("(no traffic recorded for this selection yet)");
      return;
    }
    // Spend prices the same uncapped selection the rollup grouped, so the
    // figures join row-by-row instead of disagreeing with the table.
    const spendByKey = new Map(
      spendRollup(await store.query({ ...filter, limit: 0 }), grain).map((r) => [r.key, r.estSpendUsd]),
    );
    console.log("key\trequests\terrors\terr%\tp50ms\tp95ms\tin-tok\tout-tok\test-spend");
    for (const r of rows) {
      console.log(
        `${r.key}\t${r.requests}\t${r.errors}\t${(r.errorRate * 100).toFixed(1)}\t${r.p50Ms}\t${r.p95Ms}\t${r.reqTokens}\t${r.resTokens}\t${formatSpend(spendByKey.get(r.key) ?? 0)}`,
      );
    }
    const spendLookup: Record<string, number> = {};
    for (const [key, spend] of spendByKey) spendLookup[key] = spend;
    for (const tip of suggestInsights(rows, spendLookup, windowLabel ? { windowLabel } : {})) {
      console.log(`- ${tip}`);
    }
    console.log(SPEND_ESTIMATE_NOTE);
  } finally {
    store.close();
  }
}

/**
 * Control-plane client for this invocation. The token read, the header, the
 * 401/403 reading and the "not running" message all live in adapters — the CLI
 * and the web UI must not diagnose the same dead proxy differently.
 */
function control(port: number): ProxyControlClient {
  return new ProxyControlClient({ baseUrl: proxyBaseUrl(port) });
}

/** CLI `--rotation*` flag overrides: top precedence, above env, above the file. */
export interface RotationFlagOverrides {
  enabled?: boolean;
  strategy?: RotationStrategy;
  pollMs?: number;
}

/**
 * Parse the rotation flags. Pure — no env, no file (the poller resolves those
 * layers itself). Throws on a bad value; the caller reports it and aborts
 * before any side effect (no token minted, no store opened).
 */
export function parseRotationFlags(rest: string[]): RotationFlagOverrides {
  const overrides: RotationFlagOverrides = {};
  const rawEnabled = flag(rest, "--rotation");
  if (rawEnabled !== undefined) {
    const v = rawEnabled.toLowerCase();
    if (["on", "true", "1", "yes"].includes(v)) overrides.enabled = true;
    else if (["off", "false", "0", "no"].includes(v)) overrides.enabled = false;
    else throw new Error(`--rotation expects on|off, got "${rawEnabled}".`);
  }
  const rawStrategy = flag(rest, "--rotation-strategy");
  if (rawStrategy !== undefined) {
    if (rawStrategy === "reset-soonest" || rawStrategy === "least-used") overrides.strategy = rawStrategy;
    else throw new Error(`--rotation-strategy expects reset-soonest|least-used, got "${rawStrategy}".`);
  }
  const rawPollMs = flag(rest, "--rotation-poll-ms");
  if (rawPollMs !== undefined) {
    const n = parseInt(rawPollMs, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`--rotation-poll-ms expects a positive millisecond count, got "${rawPollMs}".`);
    }
    overrides.pollMs = n;
  }
  return overrides;
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
  const rot = body.rotation;
  if (rot) {
    if (!rot.enabled) console.log("  rotation: off");
    else if (rot.lastRunAt === null) console.log(`  rotation: on (${rot.strategy}), waiting for first tick`);
    else {
      console.log(
        `  rotation: on (${rot.strategy}) — checked ${rot.checked} (${rot.usable} usable), ${rot.switched ?? "no switch"}: ${rot.reason ?? "—"}`,
      );
    }
  }
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

/**
 * Proxy-down preflight for launches without a bound subscription account
 * (key profiles, account-less subscription profiles). Same diagnosis as
 * everywhere else: the adapters-owned "not running" message. False = abort.
 */
export async function checkProxyUp(port: number): Promise<boolean> {
  try {
    await control(port).status();
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

/** A proxy this process started: caller owns the socket and the store. */
export interface OwnedProxy {
  proxy: SubscriptionProxy;
  trafficStore: SqliteTrafficLog | undefined;
  vaultCount: number;
  keyCount: number;
  trafficLog: string | undefined;
  logBodies: boolean;
}

/**
 * Build, guard, and listen the subscription proxy in-process. Shared by
 * `proxy run` and `swisscode web` so both construct the same proxy from the
 * same flags. Returns undefined when the home holds no accounts at all (the
 * abort is already reported); throws an actionable error when the port is
 * taken by something that is not a swisscode proxy.
 */
export async function startOwnedProxy(port: number, rest: string[]): Promise<OwnedProxy | undefined> {
  let rotation: RotationFlagOverrides;
  try {
    rotation = parseRotationFlags(rest);
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return undefined;
  }
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
  const vault = new FileAccountRepository(defaultSubscriptionsDir());
  const usageCache = new FileUsageCache();
  const keyAccounts = await new FileProviderAccountRepository().list();
  // The queryable store opens beside the JSONL firehose unless recording is
  // off entirely. A store failure (e.g. an old Node without node:sqlite)
  // degrades to JSONL-only — reporting never breaks proxying.
  const storePath = noLog ? undefined : (flag(rest, "--traffic-store") ?? defaultTrafficStorePath());
  let trafficStore: SqliteTrafficLog | undefined;
  if (storePath) {
    try {
      trafficStore = await openTrafficStore(storePath);
    } catch (err) {
      console.error(`traffic store unavailable (${(err as Error).message}) — continuing JSONL-only.`);
    }
  }
  const proxy = new SubscriptionProxy(
    vault,
    new AnthropicOAuthClient(),
    {
      profiles: new FileProfileRepository(),
      providerAccounts: new FileProviderAccountRepository(),
      providers: createProviderRegistry(
        await loadCustomProviderPorts(new FileCustomProviderStore()),
      ),
      logBodies,
      controlToken,
      trafficStore,
      // Adopt Claude Code's live lineage when the vault copy rotated away.
      liveStore: new ClaudeActiveCredentialStore(),
      trafficBufferSize: keep,
      trafficBodyBytes: bodyBytes("--traffic-body-bytes", "SWISSCODE_TRAFFIC_BODY_BYTES", DEFAULT_TRAFFIC_BODY_BYTES),
      maxLoggedBodyBytes: bodyBytes("--log-body-bytes", "SWISSCODE_LOG_BODY_BYTES", 8192),
      // Always wired: the poller re-reads settings every tick, so the
      // /settings toggle applies live with no restart. Disabled is a settings
      // read per cycle and zero network — the same client/cache the poller
      // pre-checks, keyed by the same vault identity.
      rotation: {
        usageClient: new CachingUsageClient(new AnthropicUsageClient(), usageCache, {
          accountIdentity: vaultIdentityResolver(vault),
        }),
        usageCache,
        settings: new FileSettingsStore(),
        ...(rotation.enabled !== undefined ? { enabled: rotation.enabled } : {}),
        ...(rotation.strategy ? { strategy: rotation.strategy } : {}),
        ...(rotation.pollMs !== undefined ? { pollMs: rotation.pollMs } : {}),
      },
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
  // Key-only users get a working proxy too: subscription requests then fail
  // per-request with a clear error instead of refusing to start. Only a
  // home with neither kind of credential is a misconfiguration worth
  // aborting over.
  if (count === 0 && keyAccounts.length === 0) {
    console.error(
      "No accounts stored. Run `swisscode accounts import <id>` (subscription) or store a provider key first.",
    );
    process.exitCode = 1;
    return undefined;
  }
  try {
    await proxy.listen(port);
  } catch (err) {
    // The probe-first caller already ruled out a live swisscode proxy, so an
    // occupied port belongs to something foreign — say which flag moves us.
    if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
      throw new Error(`Proxy port ${port} is in use by something that is not a swisscode proxy. Stop it or retry with --proxy-port <n>.`);
    }
    throw err;
  }
  return { proxy, trafficStore, vaultCount: count, keyCount: keyAccounts.length, trafficLog, logBodies };
}

export async function cmdProxy(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const port = proxyPort(flag(rest, "--port"));
  if (sub === "run") {
    const started = await startOwnedProxy(port, rest);
    if (!started) return;
    const { proxy, trafficStore, vaultCount: count, keyCount, trafficLog, logBodies } = started;
    // Handlers before the ready line: a SIGTERM that lands the moment our
    // supervisor sees "key account(s)" must shut down cleanly (exit 0), not
    // kill us with the default disposition (exit null).
    const shutdown = () => {
      try {
        trafficStore?.close();
      } catch {
        // Already closing down — the original signal is what matters.
      }
      void proxy.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    console.log(
      `Subscription proxy on ${proxyBaseUrl(port)} (${count} vault account(s), ${keyCount} key account(s)). Ctrl-C to stop.`,
    );
    if (count === 0) {
      console.log("No subscription accounts — subscription requests will fail until one is imported.");
    }
    if (trafficLog) console.log(`Traffic: ${trafficLog}${logBodies ? " (bodies on)" : ""}`);
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
    const { filter, filtering } = trafficFilterFromArgs(rest);
    await showTrafficLog(flag(rest, "--traffic-log") ?? defaultTrafficLogPath(), tail, filter, filtering);
    return;
  }
  if (sub === "report") {
    const byRaw = flag(rest, "--by") ?? "day";
    const grain: TrafficRollupGrain = byRaw === "profile" || byRaw === "route" ? byRaw : "day";
    const { filter } = trafficFilterFromArgs(rest);
    const daysRaw = flag(rest, "--days");
    let windowLabel: string | undefined;
    if (daysRaw !== undefined) {
      const days = Math.max(0, parseInt(daysRaw, 10) || 0);
      filter.since = new Date(Date.now() - days * 86_400_000).toISOString();
      windowLabel = `last ${days} day${days === 1 ? "" : "s"}`;
    }
    await showTrafficReport(flag(rest, "--traffic-store") ?? defaultTrafficStorePath(), filter, grain, windowLabel);
    return;
  }
  console.log(proxyHelp());
}
