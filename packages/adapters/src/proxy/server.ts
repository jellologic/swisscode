// Adapter: localhost Anthropic proxy with transparent subscription switching.
// Claude Code points ANTHROPIC_BASE_URL here; the proxy forwards everything to
// the real API with the ACTIVE vault account's bearer token. Switches happen
// via the control endpoint — the client never knows.
//
// v1 semantics are deliberately simple:
// - one active account at a time (POST /__swisscode/use/:id to change it)
// - on 401: refresh once and retry
// - on 429/529 (rate limit / overload): fail over to the next vault account,
//   one pass, then return the last error; the limited account cools down so
//   the next request does not re-hit it
// - responses (incl. SSE streams) are piped byte-for-byte, never buffered
// - a client that hangs up aborts the upstream request (no quota burned for
//   an answer nobody reads)
// - loopback is a network boundary, not an authorization one: Host is pinned,
//   browser-originated requests are refused, and control routes want a token

import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  AccountRepository,
  ActiveCredentialStore,
  OAuthClient,
  OAuthCredential,
  SubscriptionAccount,
  TrafficParser,
  TrafficRequestSummary,
} from "@swisscode/core";
import { SingleFlight, isCredentialExpired } from "@swisscode/core";
import { defaultTrafficParsers } from "../registry.js";
import { readSessionContext } from "./sessionContext.js";
import { resyncSubscriptionCredential } from "../subscriptions/liveResync.js";
import { freshVaultCredential } from "../subscriptions/freshCredential.js";
import { PROXY_TOKEN_HEADER } from "./proxyToken.js";

export const DEFAULT_PROXY_PORT = 8123;

/** Max entries the traffic ring buffer may hold. */
export const MAX_TRAFFIC_BUFFER_SIZE = 10000;

/**
 * Default per-side body cap inside buffered entries (64KB). Whole bodies are
 * far too expensive to keep: 200 entries of unbounded Claude traffic reached
 * ~90MB of heap and shipped the same again on every inspection poll.
 */
export const DEFAULT_TRAFFIC_BODY_BYTES = 65536;

/** Requests with a body over this are refused with 413 (32MB). */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;

/**
 * How long to wait for upstream response HEADERS. Streaming bodies run for
 * minutes legitimately, so the timer is cancelled the moment headers land.
 */
export const DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS = 60_000;

/** Cooldown applied to an account that answered 429/529 without a Retry-After. */
const DEFAULT_COOLDOWN_MS = 60_000;

/** Upper bound on a Retry-After honoured as a cooldown (15 min). */
const MAX_COOLDOWN_MS = 15 * 60_000;

/** Bodies larger than this skip structured pre-truncation parsing (2MB). */
const MAX_STRUCTURED_PARSE_BYTES = 2 * 1024 * 1024;

/**
 * Hosts the proxy answers on. 127.0.0.1 is a network boundary, not an
 * authorization one: a browser page can reach it, and DNS rebinding turns any
 * attacker domain into "same origin" unless the Host header is pinned.
 */
const LOCAL_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

/** True when the Host header names this machine's loopback interface. */
export function isLoopbackHost(host: string | undefined): boolean {
  return typeof host === "string" && LOCAL_HOST_RE.test(host.trim());
}

/** Shape of the ids minted in trace(): `t<started36>-<seq36>`. */
const TRAFFIC_ID_RE = /^t[a-z0-9]+-[a-z0-9]+$/;

/**
 * Profile tag the launcher puts in ANTHROPIC_AUTH_TOKEN for proxy launches
 * (`swisscode-profile/<name>`). Claude Code forwards it as the Bearer token;
 * the proxy reads it before swapping in the vault credential, so entries can
 * be attributed to the profile that made them. Never a real credential.
 */
const PROFILE_TAG_RE = /^swisscode-profile\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;

/** Extract a profile name from an Authorization/x-api-key header value. */
export function parseProfileTag(headerValue: string | string[] | undefined): string | undefined {
  if (!headerValue) return undefined;
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw) return undefined;
  const token = raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : raw;
  return PROFILE_TAG_RE.exec(token.trim())?.[1];
}

function clampBufferSize(n: number): number {
  if (!Number.isFinite(n)) return 200;
  return Math.min(MAX_TRAFFIC_BUFFER_SIZE, Math.max(0, Math.floor(n)));
}

/** Bounded capture of one streamed response side. */
interface BodyCapture {
  chunks: Buffer[];
  kept: number;
  bytes: number;
  cap: number;
}

function truncateText(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
}

/** Entry copy with both bodies limited to `cap` chars. */
function withBodyCap(entry: ProxyTrafficEntry, cap: number): ProxyTrafficEntry {
  const out: ProxyTrafficEntry = { ...entry };
  if (out.reqBody !== undefined) {
    const t = truncateText(out.reqBody, cap);
    out.reqBody = t.text;
    out.reqBodyTruncated = out.reqBodyTruncated || t.truncated;
  }
  if (out.resBody !== undefined) {
    const t = truncateText(out.resBody, cap);
    out.resBody = t.text;
    out.resBodyTruncated = out.resBodyTruncated || t.truncated;
  }
  return out;
}

/** Entry copy without raw bodies but with the parsed request facts kept. */
function omitBodies(entry: ProxyTrafficEntry): ProxyTrafficEntry {
  const out: ProxyTrafficEntry = { ...entry };
  delete out.reqBody;
  delete out.reqBodyTruncated;
  delete out.resBody;
  delete out.resBodyTruncated;
  return out;
}

/** Entry copy with no bodies (metadata only). */
function stripBodies(entry: ProxyTrafficEntry): ProxyTrafficEntry {
  const out = omitBodies(entry);
  delete out.request;
  return out;
}

const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length", // fetch recomputes it for the upstream request
  // undici decodes the upstream body for us; relaying the client's own
  // accept-encoding invites an encoding we cannot decode, which then reaches
  // the client as compressed bytes with the content-encoding header stripped.
  "accept-encoding",
  "cookie", // never proxy ambient browser credentials to the API
]);

/**
 * Header names the client marked connection-scoped (`Connection: a, b`).
 * RFC 9110 says a proxy must not forward them; forwarding is how a hop-only
 * header (an upgrade, a private extension) leaks to the origin.
 */
function connectionScopedHeaders(value: string | string[] | undefined): Set<string> {
  const raw = Array.isArray(value) ? value.join(",") : (value ?? "");
  const names = new Set<string>();
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if (name) names.add(name);
  }
  return names;
}

/** Single place that answers with JSON; never double-writes a sent response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Seconds to park an account after a 429/529, from Retry-After when present. */
export function cooldownMsFromRetryAfter(value: string | null | undefined): number {
  if (!value) return DEFAULT_COOLDOWN_MS;
  const seconds = Number.parseInt(value.trim(), 10);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(MAX_COOLDOWN_MS, seconds * 1000);
  }
  const at = Date.parse(value);
  if (Number.isFinite(at)) {
    return Math.min(MAX_COOLDOWN_MS, Math.max(0, at - Date.now()));
  }
  return DEFAULT_COOLDOWN_MS;
}

export interface ProxyOptions {
  port?: number;
  upstream?: string; // default https://api.anthropic.com
  fetchFn?: typeof fetch;
  /** Called once per proxied API request with a redacted metadata entry. */
  onTraffic?: (entry: ProxyTrafficEntry) => void;
  /** Also capture (truncated) request/response bodies. Off by default. */
  logBodies?: boolean;
  /** Max body bytes kept per side when logBodies is on. Default 8192. */
  maxLoggedBodyBytes?: number;
  /**
   * Claude Code's live credential store (Keychain/file). When the vault
   * refresh token was rotated away, the proxy adopts the live lineage
   * instead of failing — read-only, never writes Claude's store.
   */
  liveStore?: ActiveCredentialStore;
  /**
   * In-memory ring buffer of recent traffic entries for inspection
   * (backs GET /__swisscode/traffic). Default 200; 0 disables.
   */
  trafficBufferSize?: number;
  /**
   * Max body bytes kept per side inside buffered entries. Default 64KB;
   * 0 means unlimited (the ring size then bounds total memory alone).
   */
  trafficBodyBytes?: number;
  /**
   * Provider traffic parsers, tried in order. Defaults to every provider
   * adapter that defines one — the proxy never parses wire formats itself.
   */
  trafficParsers?: TrafficParser[];
  /**
   * Shared secret required on every `/__swisscode/*` control route
   * (header `x-swisscode-token`). Unset leaves the control plane open, which
   * is only safe for tests and in-process use.
   */
  controlToken?: string;
  /** Wait for upstream response headers. Default 60s; bodies stream freely. */
  upstreamHeadersTimeoutMs?: number;
}

/** One failover step inside a proxied request. */
export interface ProxyTrafficAttempt {
  accountId: string;
  status: number | "network-error" | "refresh-failed" | "stale-credential";
}

/**
 * Redacted traffic record for one proxied API request. Never contains
 * headers or tokens — only metadata, plus opt-in truncated bodies.
 */
export interface ProxyTrafficEntry {
  /**
   * Stable id for inspection links (`t<started36>-<seq36>`). Set at capture;
   * absent only on entries recorded before ids existed.
   */
  id?: string;
  ts: string;
  method: string;
  /** Path with the query string stripped. */
  path: string;
  /**
   * What the client actually got: the upstream status, or 499 when the client
   * hung up mid-stream and 502 when the upstream stream broke after headers.
   * `attempts` keeps the raw upstream statuses either way.
   */
  status: number;
  ms: number;
  /** Account whose token served the response, or null when none did. */
  accountId: string | null;
  /**
   * Provider that claimed this route (matched parser id). Set at capture so
   * inspection renders with the same provider reading, even for entries whose
   * bodies were dropped. Undefined when no provider parser claimed the route.
   */
  providerId?: string;
  reqBytes: number;
  resBytes: number;
  attempts: ProxyTrafficAttempt[];
  error?: string;
  /** Profile that launched the client, from the swisscode-profile tag (if any). */
  profile?: string;
  /**
   * Request facts parsed from the FULL body before truncation (small and
   * bounded). Present even when reqBody holds only the kept head.
   */
  request?: TrafficRequestSummary;
  reqBody?: string;
  reqBodyTruncated?: boolean;
  resBody?: string;
  resBodyTruncated?: boolean;
}

export interface ProxyStatus {
  running: boolean;
  upstream: string;
  activeAccountId: string | null;
  accounts: { id: string; label: string; email?: string }[];
  traffic: { kept: number; size: number };
}

export class SubscriptionProxy {
  private server: Server | null = null;
  private activeAccountId: string | null = null;
  private readonly upstream: string;
  private readonly fetchFn: typeof fetch;
  private readonly onTraffic?: (entry: ProxyTrafficEntry) => void;
  private readonly liveStore?: ActiveCredentialStore;
  private readonly logBodies: boolean;
  private readonly maxLoggedBodyBytes: number;
  private trafficBufferSize: number;
  private readonly trafficBodyBytes: number;
  private readonly trafficParsers: TrafficParser[];
  private readonly controlToken?: string;
  private readonly upstreamHeadersTimeoutMs: number;
  private trafficSeq = 0;
  private readonly traffic: ProxyTrafficEntry[] = [];
  /** accountId → epoch ms until which a 429/529 says not to use it. */
  private readonly cooldowns = new Map<string, number>();
  /** Concurrent 401s on one account must cost one rotation, not one each. */
  private readonly recovering = new SingleFlight<string | undefined>();

  constructor(
    private readonly accounts: AccountRepository,
    private readonly oauth: OAuthClient,
    options: ProxyOptions = {},
  ) {
    this.upstream = (options.upstream ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    this.onTraffic = options.onTraffic;
    this.liveStore = options.liveStore;
    this.logBodies = options.logBodies ?? false;
    this.maxLoggedBodyBytes = options.maxLoggedBodyBytes ?? 8192;
    this.trafficBufferSize = clampBufferSize(options.trafficBufferSize ?? 200);
    const bodyBytes = options.trafficBodyBytes ?? DEFAULT_TRAFFIC_BODY_BYTES;
    this.trafficBodyBytes = bodyBytes > 0 ? bodyBytes : Number.POSITIVE_INFINITY;
    this.trafficParsers = options.trafficParsers ?? defaultTrafficParsers();
    this.controlToken = options.controlToken;
    this.upstreamHeadersTimeoutMs =
      options.upstreamHeadersTimeoutMs ?? DEFAULT_UPSTREAM_HEADERS_TIMEOUT_MS;
    void options.port;
  }

  async status(): Promise<ProxyStatus> {
    const all = await this.accounts.list();
    return {
      running: this.server !== null,
      upstream: this.upstream,
      activeAccountId: this.activeAccountId ?? all[0]?.id ?? null,
      accounts: all.map((a) => ({ id: a.id, label: a.label, email: a.email })),
      traffic: { kept: this.traffic.length, size: this.trafficBufferSize },
    };
  }

  /** Newest-first copy of the buffered traffic entries, optionally filtered by profile. */
  getTraffic(onlyProfile?: string): ProxyTrafficEntry[] {
    const all = [...this.traffic].reverse();
    if (onlyProfile === undefined) return all;
    return all.filter((e) => e.profile === onlyProfile);
  }

  /** One buffered entry with its bodies, or undefined when it aged out. */
  getTrafficEntry(id: string): ProxyTrafficEntry | undefined {
    return this.traffic.find((e) => e.id === id);
  }

  /** Distinct profile names present in the buffer, sorted. */
  trafficProfiles(): string[] {
    const names = new Set<string>();
    for (const e of this.traffic) {
      if (e.profile !== undefined) names.add(e.profile);
    }
    return [...names].sort();
  }

  /** Drop all buffered entries; returns how many were cleared. */
  clearTraffic(): number {
    const n = this.traffic.length;
    this.traffic.length = 0;
    return n;
  }

  /** Resize the ring buffer (0 disables); trims excess oldest entries. */
  setTrafficBufferSize(n: number): number {
    this.trafficBufferSize = clampBufferSize(n);
    while (this.traffic.length > this.trafficBufferSize) this.traffic.shift();
    return this.trafficBufferSize;
  }

  async setActive(id: string): Promise<SubscriptionAccount> {
    const account = await this.accounts.get(id);
    if (!account) throw new Error(`Unknown subscription account "${id}"`);
    this.activeAccountId = id;
    return account;
  }

  /**
   * Park an account after a rate-limit answer. Without this the active
   * account never moves, so every following request pays another round trip
   * to the same exhausted quota before failing over again.
   */
  private cooldown(accountId: string, retryAfter: string | null | undefined): void {
    this.cooldowns.set(accountId, Date.now() + cooldownMsFromRetryAfter(retryAfter));
  }

  /**
   * Ordered candidate account ids: active first, then the rest, with cooled
   * accounts moved out of the way. When every account is cooling we try them
   * anyway — a stale Retry-After must never make the proxy unusable.
   */
  private async candidates(): Promise<string[]> {
    const all = await this.accounts.list();
    const ids = all.map((a) => a.id);
    const ordered =
      this.activeAccountId && ids.includes(this.activeAccountId)
        ? [this.activeAccountId, ...ids.filter((id) => id !== this.activeAccountId)]
        : ids;
    const now = Date.now();
    for (const [id, until] of this.cooldowns) {
      if (until <= now) this.cooldowns.delete(id);
    }
    const usable = ordered.filter((id) => (this.cooldowns.get(id) ?? 0) <= now);
    return usable.length > 0 ? usable : ordered;
  }

  /**
   * Recover from a mid-flight 401 with a usable access token (persisted).
   * When Claude's live lineage moved on, adopt it — refreshing our stale
   * copy would burn a rotation pointlessly and 401 again. Otherwise one
   * refresh-retry on the lineage we hold. Undefined = give up on this account.
   */
  private async recoverUnauthorized(accountId: string, rejected: string): Promise<string | undefined> {
    return this.recovering.run(accountId, () => this.recoverUnauthorizedOnce(accountId, rejected));
  }

  private async recoverUnauthorizedOnce(
    accountId: string,
    rejected: string,
  ): Promise<string | undefined> {
    if (this.liveStore) {
      const stored = await this.accounts.loadCredential(accountId).catch(() => undefined);
      const adopted = await resyncSubscriptionCredential(
        { accounts: this.accounts, oauth: this.oauth, live: this.liveStore },
        accountId,
      ).catch(() => undefined);
      if (adopted) {
        if (!stored || adopted.refreshToken !== stored.refreshToken) {
          await this.accounts.saveCredential(accountId, adopted);
        }
        return adopted.accessToken;
      }
      // Resync declines when the vault already holds the live lineage (same
      // dead copy) or no live login exists: fall through to the legacy retry,
      // which either rotates our own lineage or fails closed.
      if (!stored) return undefined;
    }
    try {
      const stored = await this.accounts.loadCredential(accountId);
      if (!stored) return undefined;
      // A request that overlapped ours may already have rotated the account.
      // Its token was never rejected, so retry with it instead of spending
      // another single-use refresh token on the same 401.
      if (stored.accessToken !== rejected) return stored.accessToken;
      if (isCredentialExpired(stored)) {
        // Clock agrees: the shared entry point rotates, persists, and
        // coalesces with any other caller waiting on this account.
        return (
          await freshVaultCredential(this.accounts, this.oauth, accountId, {
            liveStore: this.liveStore,
          })
        ).credential.accessToken;
      }
      // Upstream rejected a token our clock still calls valid (revoked or
      // rotated behind our back): rotate anyway — this method is already
      // single-flighted, so it happens once per account.
      const next = await this.oauth.refresh(stored);
      await this.accounts.saveCredential(accountId, next);
      return next.accessToken;
    } catch {
      return undefined;
    }
  }

  private async freshToken(accountId: string): Promise<OAuthCredential> {
    return (
      await freshVaultCredential(this.accounts, this.oauth, accountId, {
        liveStore: this.liveStore,
      })
    ).credential;
  }

  private async forward(
    method: string,
    path: string,
    headers: Headers,
    body: Buffer | undefined,
    token: string,
    signal: AbortSignal,
  ): Promise<Response> {
    headers.set("authorization", `Bearer ${token}`);
    headers.set("host", new URL(this.upstream).host);
    // The timeout covers the response HEADERS only: an SSE answer legitimately
    // streams for minutes, so the timer is cleared as soon as fetch resolves
    // while the client-abort signal keeps governing the body.
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new Error("upstream headers timeout"));
    }, this.upstreamHeadersTimeoutMs);
    try {
      // Buffer is a valid undici body; the DOM lib types disagree (ArrayBufferLike
      // generics), so the single cast stays at this call site.
      return await this.fetchFn(`${this.upstream}${path}`, {
        method,
        headers,
        body: body as unknown as BodyInit | undefined,
        signal: AbortSignal.any([signal, timeout.signal]),
      });
    } catch (err) {
      if (timeout.signal.aborted && !signal.aborted) {
        throw new Error(`upstream did not answer within ${this.upstreamHeadersTimeoutMs}ms`);
      }
      throw err as Error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, body: Buffer | undefined): Promise<void> {
    const started = Date.now();
    // Profile tag rides in the client credential, which we strip below —
    // read it first so the entry can be attributed to the launching profile.
    const profile =
      parseProfileTag(req.headers["authorization"]) ?? parseProfileTag(req.headers["x-api-key"]);
    // Esc in Claude Code closes the socket. Without propagating that upstream
    // the model keeps generating — and billing — for an answer nobody reads.
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort(new Error("client aborted"));
    });
    const connectionScoped = connectionScopedHeaders(req.headers["connection"]);
    const inHeaders = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      if (value === undefined || HOP_HEADERS.has(lower) || connectionScoped.has(lower)) continue;
      // The proxy signs every request with the vault credential: client
      // credentials are never forwarded. A stray client x-api-key would
      // otherwise take precedence upstream and 401 a request our own
      // Bearer would have served (burning a rotation on the retry).
      if (lower === "authorization" || lower === "x-api-key") continue;
      inHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const path = req.url ?? "/";
    const cleanPath = path.split("?")[0] ?? "/";
    const reqBytes = body?.length ?? 0;
    const attempts: ProxyTrafficAttempt[] = [];
    const trace = (entry: Omit<ProxyTrafficEntry, "id" | "ts" | "method" | "path" | "ms" | "reqBytes" | "profile" | "request" | "providerId">) => {
      const method = req.method ?? "GET";
      const parser = this.trafficParsers.find((p) => p.canParse({ method, path: cleanPath }));
      const full: ProxyTrafficEntry = {
        id: `t${started.toString(36)}-${(this.trafficSeq += 1).toString(36)}`,
        ts: new Date(started).toISOString(),
        method,
        path: cleanPath,
        ms: Date.now() - started,
        reqBytes,
        ...(profile !== undefined ? { profile } : {}),
        ...(parser ? { providerId: parser.providerId } : {}),
        ...entry,
      };
      // Parse request facts from the FULL body before views truncate it —
      // large Claude requests would otherwise be unparseable from the head.
      // The owning provider reads its own format; the proxy never parses.
      if (parser && body && body.length <= MAX_STRUCTURED_PARSE_BYTES) {
        try {
          const facts = parser.parseRequestBody(body.toString("utf8"), reqBytes);
          if (facts) full.request = facts;
        } catch {
          // Malformed bodies still trace; the raw head (if kept) tells the story.
        }
      }
      if (this.trafficBufferSize > 0) {
        this.traffic.push(withBodyCap(full, this.trafficBodyBytes));
        while (this.traffic.length > this.trafficBufferSize) this.traffic.shift();
      }
      if (this.onTraffic) {
        this.onTraffic(this.logBodies ? withBodyCap(full, this.maxLoggedBodyBytes) : stripBodies(full));
      }
    };
    // Largest capture either consumer needs; views are truncated in trace().
    const captureCap = Math.max(
      this.logBodies ? this.maxLoggedBodyBytes : 0,
      this.trafficBufferSize > 0 ? this.trafficBodyBytes : 0,
    );
    const ids = await this.candidates();
    if (ids.length === 0) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no subscription accounts stored" }));
      trace({ status: 503, accountId: null, resBytes: 0, attempts, error: "no subscription accounts stored" });
      return;
    }
    const loggedRequest = () => (body && captureCap > 0 ? this.loggedBody(body, captureCap) : {});
    // 499 (client closed request) so an abandoned stream can never be read
    // back as a completed 200.
    const traceAborted = (accountId: string | null, resBytes: number) =>
      trace({ status: 499, accountId, resBytes, attempts, error: "client aborted", ...loggedRequest() });
    let lastStatus = 502;
    let lastBody = "all accounts exhausted or need re-login";
    for (const accountId of ids) {
      let token: string;
      try {
        token = (await this.freshToken(accountId)).accessToken;
      } catch (err) {
        lastBody = `account "${accountId}": ${(err as Error).message}`;
        attempts.push({ accountId, status: "stale-credential" });
        continue; // dead account (needs re-login): try the next one
      }
      let upstream: Response;
      try {
        upstream = await this.forward(req.method ?? "GET", path, new Headers(inHeaders), body, token, abort.signal);
      } catch (err) {
        if (abort.signal.aborted) return traceAborted(accountId, 0);
        lastBody = (err as Error).message;
        attempts.push({ accountId, status: "network-error" });
        continue;
      }
      if (upstream.status === 401) {
        // Access rejected mid-flight. Recover once: adopt Claude's live
        // lineage when it moved (never rotate a stale copy), else one
        // refresh-retry when the vault still holds the current lineage.
        attempts.push({ accountId, status: 401 });
        await upstream.arrayBuffer().catch(() => undefined); // release the socket first
        const recovered = await this.recoverUnauthorized(accountId, token);
        if (!recovered) {
          attempts.push({ accountId, status: "refresh-failed" });
          continue;
        }
        try {
          upstream = await this.forward(req.method ?? "GET", path, new Headers(inHeaders), body, recovered, abort.signal);
        } catch (err) {
          // Unguarded, this rejection escaped handleApi as a raw 500 with no
          // traffic entry at all — the one failure mode with no record.
          if (abort.signal.aborted) return traceAborted(accountId, 0);
          lastBody = (err as Error).message;
          attempts.push({ accountId, status: "network-error" });
          continue;
        }
      }
      if (upstream.status === 429 || upstream.status === 529) {
        this.cooldown(accountId, upstream.headers.get("retry-after"));
        if (accountId !== ids[ids.length - 1]) {
          attempts.push({ accountId, status: upstream.status });
          lastStatus = upstream.status;
          // Read once: a second read of a consumed body always throws, which
          // used to put the literal string "rate limited" on the wire.
          lastBody = await upstream.text().catch(() => "rate limited");
          continue;
        }
      }
      attempts.push({ accountId, status: upstream.status });
      const piped = await this.pipe(
        upstream,
        res,
        captureCap > 0 ? this.capture(captureCap) : undefined,
        abort.signal,
      );
      if (piped.error === "client aborted") return traceAborted(accountId, piped.bytes);
      trace({
        // A broken stream is a gateway failure even though 200 headers went
        // out before the break; attempts still carry what upstream answered.
        status: piped.error ? 502 : upstream.status,
        accountId,
        resBytes: piped.bytes,
        attempts,
        ...(piped.error ? { error: piped.error } : {}),
        ...(piped.text !== undefined ? { resBody: piped.text, resBodyTruncated: piped.truncated } : {}),
        ...loggedRequest(),
      });
      return;
    }
    if (abort.signal.aborted) return traceAborted(null, 0);
    // Valid JSON: the exhausted path used to answer with the upstream's raw
    // text under an application/json content type.
    res.writeHead(lastStatus, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: lastBody, attempts }));
    trace({
      status: lastStatus,
      accountId: null,
      resBytes: 0,
      attempts,
      error: lastBody.slice(0, 500),
      ...loggedRequest(),
    });
  }

  /** Bounded in-memory capture of a streamed side for opt-in body logging. */
  private capture(cap: number): BodyCapture {
    return { chunks: [], kept: 0, bytes: 0, cap };
  }

  private loggedBody(body: Buffer, cap: number): { reqBody: string; reqBodyTruncated: boolean } {
    const slice = body.subarray(0, cap);
    return { reqBody: slice.toString("utf8"), reqBodyTruncated: body.length > slice.length };
  }

  private async pipe(
    upstream: Response,
    res: ServerResponse,
    capture: BodyCapture | undefined,
    signal: AbortSignal,
  ): Promise<{ bytes: number; text?: string; truncated?: boolean; error?: string }> {
    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      // fetch (undici) already decoded the body, so the original
      // content-encoding/content-length would corrupt the relay.
      if (lower === "content-encoding" || lower === "content-length") return;
      if (!HOP_HEADERS.has(lower)) outHeaders[key] = value;
    });
    res.writeHead(upstream.status, outHeaders);
    let bytes = 0;
    let error: string | undefined;
    if (upstream.body) {
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (capture && capture.kept < capture.cap) {
            const room = capture.cap - capture.kept;
            const chunk = Buffer.from(value.subarray(0, room));
            capture.chunks.push(chunk);
            capture.kept += chunk.length;
          }
          // Backpressure: a slow reader must not make the socket's write queue
          // hold the whole stream in memory. `once` rejects on abort, which
          // the catch below turns into the same client-gone record.
          if (!res.write(value)) await once(res, "drain", { signal });
        }
      } catch {
        // Status and headers are already on the wire, so there is no error
        // code left to send: cut the connection and let the entry say why.
        // (Calling writeHead again here is what used to throw
        // ERR_HTTP_HEADERS_SENT inside the catch and kill the process.)
        error = signal.aborted ? "client aborted" : "upstream stream error";
        void reader.cancel().catch(() => undefined);
        if (res.headersSent) {
          res.destroy();
        } else {
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error }));
        }
      } finally {
        reader.releaseLock();
      }
    }
    if (!error) res.end();
    const result = { bytes, ...(error !== undefined ? { error } : {}) };
    if (!capture) return result;
    return {
      ...result,
      text: Buffer.concat(capture.chunks).toString("utf8"),
      truncated: bytes > capture.kept,
    };
  }

  /**
   * Gate every request before it reaches a route. Binding 127.0.0.1 keeps
   * other machines out; it does nothing about the browser already running on
   * this one, which can POST to the control plane (switching the billed
   * account) or read whole conversations back out via DNS rebinding.
   */
  private denyRequest(
    req: IncomingMessage,
    url: string,
  ): { status: number; error: string } | undefined {
    if (!isLoopbackHost(req.headers["host"])) {
      // Rebinding survives only if the attacker's own hostname reaches us.
      return { status: 403, error: "proxy answers loopback Host headers only" };
    }
    if (req.headers["origin"] !== undefined || req.headers["sec-fetch-site"] !== undefined) {
      // Claude Code sends neither; every browser fetch sends at least one.
      return { status: 403, error: "browser-originated requests are not accepted" };
    }
    if (this.controlToken !== undefined && url.startsWith("/__swisscode/")) {
      const sent = req.headers[PROXY_TOKEN_HEADER];
      const value = Array.isArray(sent) ? sent[0] : sent;
      if (value !== this.controlToken) {
        return { status: 401, error: `missing or invalid ${PROXY_TOKEN_HEADER}` };
      }
    }
    return undefined;
  }

  async listen(port: number = DEFAULT_PROXY_PORT): Promise<number> {
    if (this.server) return port;
    const st = await this.status();
    if (st.activeAccountId) this.activeAccountId = st.activeAccountId;
    this.server = createServer((req, res) => {
      void (async () => {
        try {
          const url = req.url ?? "/";
          const denied = this.denyRequest(req, url);
          if (denied) {
            sendJson(res, denied.status, { error: denied.error });
            return;
          }
          if (url === "/__swisscode/status" && req.method === "GET") {
            sendJson(res, 200, await this.status());
            return;
          }
          const useMatch = /^\/__swisscode\/use\/([A-Za-z0-9][A-Za-z0-9-_]*)$/.exec(url);
          if (useMatch && req.method === "POST") {
            try {
              const account = await this.setActive(useMatch[1] as string);
              sendJson(res, 200, { ok: true, activeAccountId: account.id });
            } catch (err) {
              sendJson(res, 404, { error: (err as Error).message });
            }
            return;
          }
          const trafficUrl = new URL(url, "http://127.0.0.1");
          if (trafficUrl.pathname === "/__swisscode/traffic" && req.method === "GET") {
            const onlyProfile = trafficUrl.searchParams.get("profile") ?? undefined;
            // ?bodies=0 is the list view: same entries and metadata, minus the
            // raw bodies that make a full poll tens of megabytes.
            const withBodies = trafficUrl.searchParams.get("bodies") !== "0";
            const found = this.getTraffic(onlyProfile);
            sendJson(res, 200, {
              entries: withBodies ? found : found.map(omitBodies),
              kept: this.traffic.length,
              size: this.trafficBufferSize,
              profiles: this.trafficProfiles(),
            });
            return;
          }
          const entryMatch = /^\/__swisscode\/traffic\/entry\/(.+)$/.exec(trafficUrl.pathname);
          if (entryMatch && req.method === "GET") {
            const id = entryMatch[1] as string;
            const entry = TRAFFIC_ID_RE.test(id) ? this.getTrafficEntry(id) : undefined;
            if (!entry) {
              sendJson(res, 404, { error: `No buffered traffic entry "${id}"` });
              return;
            }
            sendJson(res, 200, { entry });
            return;
          }
          const sessionMatch = /^\/__swisscode\/session\/([A-Za-z0-9][A-Za-z0-9_-]*)$/.exec(
            trafficUrl.pathname,
          );
          if (sessionMatch && req.method === "GET") {
            // Local Claude Code session behind a thread: transcript prompts,
            // Workflow scripts, Task launches, subagent branches. Read-only,
            // bounded, null when the session is not on this machine.
            const context = await readSessionContext(sessionMatch[1] as string);
            sendJson(res, 200, { context });
            return;
          }
          if (url === "/__swisscode/traffic" && req.method === "DELETE") {
            sendJson(res, 200, { ok: true, cleared: this.clearTraffic() });
            return;
          }
          const sizeMatch = /^\/__swisscode\/traffic\/size\/(\d+)$/.exec(url);
          if (sizeMatch && req.method === "POST") {
            const size = this.setTrafficBufferSize(parseInt(sizeMatch[1] as string, 10));
            sendJson(res, 200, { ok: true, size, kept: this.traffic.length });
            return;
          }
          const chunks: Buffer[] = [];
          let received = 0;
          let tooLarge = false;
          req.on("data", (c: Buffer) => {
            if (tooLarge) return; // draining: the answer is already on the wire
            received += c.length;
            if (received > MAX_REQUEST_BODY_BYTES) {
              // Buffering the whole request is what lets us replay it on
              // failover, so the size of one request is a hard memory bound.
              tooLarge = true;
              chunks.length = 0;
              sendJson(res, 413, {
                error: `request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes`,
              });
              return;
            }
            chunks.push(c);
          });
          req.on("end", () => {
            if (tooLarge) return;
            void this.handleApi(
              req,
              res,
              chunks.length > 0 ? Buffer.concat(chunks) : undefined,
            ).catch((err: Error) => {
              if (res.headersSent) {
                res.destroy();
                return;
              }
              sendJson(res, 500, { error: err.message });
            });
          });
        } catch (err) {
          if (res.headersSent) {
            res.destroy();
            return;
          }
          sendJson(res, 500, { error: (err as Error).message });
        }
      })();
    });
    await new Promise<void>((resolve) => this.server?.listen(port, "127.0.0.1", resolve));
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : port;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) =>
      this.server?.close((err) => (err ? reject(err) : resolve())),
    );
    this.server = null;
  }

  baseUrl(port: number = DEFAULT_PROXY_PORT): string {
    return `http://127.0.0.1:${port}`;
  }
}
