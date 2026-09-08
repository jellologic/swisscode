// Adapter: localhost Anthropic proxy with transparent subscription switching.
// Claude Code points ANTHROPIC_BASE_URL here; the proxy forwards everything to
// the real API with the ACTIVE vault account's bearer token. Switches happen
// via the control endpoint — the client never knows.
//
// v1 semantics are deliberately simple:
// - one active account at a time (POST /__swisscode/use/:id to change it)
// - on 401: refresh once and retry
// - on 429/529 (rate limit / overload): fail over to the next vault account,
//   one pass, then return the last error
// - responses (incl. SSE streams) are piped byte-for-byte, never buffered

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
import { ensureFreshCredential } from "@swisscode/core";
import { defaultTrafficParsers } from "../registry.js";
import { readSessionContext } from "./sessionContext.js";
import { liveResyncHook, resyncSubscriptionCredential } from "../subscriptions/liveResync.js";

export const DEFAULT_PROXY_PORT = 8123;

/** Max entries the traffic ring buffer may hold. */
export const MAX_TRAFFIC_BUFFER_SIZE = 10000;

/** Bodies larger than this skip structured pre-truncation parsing (2MB). */
const MAX_STRUCTURED_PARSE_BYTES = 2 * 1024 * 1024;

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

/** Entry copy with no bodies (metadata only). */
function stripBodies(entry: ProxyTrafficEntry): ProxyTrafficEntry {
  const out: ProxyTrafficEntry = { ...entry };
  delete out.reqBody;
  delete out.reqBodyTruncated;
  delete out.resBody;
  delete out.resBodyTruncated;
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
]);

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
   * Max body bytes kept per side inside buffered entries. Default unlimited
   * (entire request/response); the ring size bounds total memory instead.
   * 0 also means unlimited.
   */
  trafficBodyBytes?: number;
  /**
   * Provider traffic parsers, tried in order. Defaults to every provider
   * adapter that defines one — the proxy never parses wire formats itself.
   */
  trafficParsers?: TrafficParser[];
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
  private trafficSeq = 0;
  private readonly traffic: ProxyTrafficEntry[] = [];

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
    const bodyBytes = options.trafficBodyBytes ?? Number.POSITIVE_INFINITY;
    this.trafficBodyBytes = bodyBytes > 0 ? bodyBytes : Number.POSITIVE_INFINITY;
    this.trafficParsers = options.trafficParsers ?? defaultTrafficParsers();
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

  /** Ordered candidate account ids: active first, then the rest. */
  private async candidates(): Promise<string[]> {
    const all = await this.accounts.list();
    const ids = all.map((a) => a.id);
    if (this.activeAccountId && ids.includes(this.activeAccountId)) {
      return [this.activeAccountId, ...ids.filter((id) => id !== this.activeAccountId)];
    }
    return ids;
  }

  /**
   * Recover from a mid-flight 401 with a usable access token (persisted).
   * When Claude's live lineage moved on, adopt it — refreshing our stale
   * copy would burn a rotation pointlessly and 401 again. Otherwise one
   * refresh-retry on the lineage we hold. Undefined = give up on this account.
   */
  private async recoverUnauthorized(accountId: string): Promise<string | undefined> {
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
      const next = await this.oauth.refresh(stored);
      await this.accounts.saveCredential(accountId, next);
      return next.accessToken;
    } catch {
      return undefined;
    }
  }

  private async freshToken(accountId: string): Promise<OAuthCredential> {
    return (
      await ensureFreshCredential(this.accounts, this.oauth, accountId, {
        onInvalidGrant: liveResyncHook({
          accounts: this.accounts,
          oauth: this.oauth,
          live: this.liveStore,
        }),
      })
    ).credential;
  }

  private async forward(
    method: string,
    path: string,
    headers: Headers,
    body: Buffer | undefined,
    token: string,
  ): Promise<Response> {
    headers.set("authorization", `Bearer ${token}`);
    headers.set("host", new URL(this.upstream).host);
    // Buffer is a valid undici body; the DOM lib types disagree (ArrayBufferLike
    // generics), so the single cast stays at this call site.
    return this.fetchFn(`${this.upstream}${path}`, {
      method,
      headers,
      body: body as unknown as BodyInit | undefined,
    });
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, body: Buffer | undefined): Promise<void> {
    const started = Date.now();
    // Profile tag rides in the client credential, which we strip below —
    // read it first so the entry can be attributed to the launching profile.
    const profile =
      parseProfileTag(req.headers["authorization"]) ?? parseProfileTag(req.headers["x-api-key"]);
    const inHeaders = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      const lower = key.toLowerCase();
      // The proxy signs every request with the vault credential: client
      // credentials are never forwarded. A stray client x-api-key would
      // otherwise take precedence upstream and 401 a request our own
      // Bearer would have served (burning a rotation on the retry).
      if (value === undefined || HOP_HEADERS.has(lower) || lower === "authorization" || lower === "x-api-key") continue;
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
        upstream = await this.forward(req.method ?? "GET", path, new Headers(inHeaders), body, token);
      } catch (err) {
        lastBody = (err as Error).message;
        attempts.push({ accountId, status: "network-error" });
        continue;
      }
      if (upstream.status === 401) {
        // Access rejected mid-flight. Recover once: adopt Claude's live
        // lineage when it moved (never rotate a stale copy), else one
        // refresh-retry when the vault still holds the current lineage.
        attempts.push({ accountId, status: 401 });
        const recovered = await this.recoverUnauthorized(accountId);
        if (!recovered) {
          attempts.push({ accountId, status: "refresh-failed" });
          continue;
        }
        upstream = await this.forward(req.method ?? "GET", path, new Headers(inHeaders), body, recovered);
      }
      if ((upstream.status === 429 || upstream.status === 529) && accountId !== ids[ids.length - 1]) {
        await upstream.arrayBuffer().catch(() => undefined); // drain before failover
        attempts.push({ accountId, status: upstream.status });
        lastStatus = upstream.status;
        lastBody = await upstream.text().catch(() => "rate limited");
        continue;
      }
      attempts.push({ accountId, status: upstream.status });
      const resBytes = await this.pipe(upstream, res, captureCap > 0 ? this.capture(captureCap) : undefined);
      trace({
        status: upstream.status,
        accountId,
        resBytes: resBytes.bytes,
        attempts,
        ...(resBytes.text !== undefined ? { resBody: resBytes.text, resBodyTruncated: resBytes.truncated } : {}),
        ...(body && captureCap > 0 ? this.loggedBody(body, captureCap) : {}),
      });
      return;
    }
    res.writeHead(lastStatus, { "Content-Type": "application/json" });
    res.end(typeof lastBody === "string" ? lastBody : JSON.stringify({ error: "all accounts exhausted" }));
    trace({
      status: lastStatus,
      accountId: null,
      resBytes: 0,
      attempts,
      error: typeof lastBody === "string" ? lastBody.slice(0, 500) : "all accounts exhausted",
      ...(body && captureCap > 0 ? this.loggedBody(body, captureCap) : {}),
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
    capture?: BodyCapture,
  ): Promise<{ bytes: number; text?: string; truncated?: boolean }> {
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
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    res.end();
    if (!capture) return { bytes };
    return {
      bytes,
      text: Buffer.concat(capture.chunks).toString("utf8"),
      truncated: bytes > capture.kept,
    };
  }

  async listen(port: number = DEFAULT_PROXY_PORT): Promise<number> {
    if (this.server) return port;
    const st = await this.status();
    if (st.activeAccountId) this.activeAccountId = st.activeAccountId;
    this.server = createServer((req, res) => {
      void (async () => {
        try {
          const url = req.url ?? "/";
          if (url === "/__swisscode/status" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(await this.status()));
            return;
          }
          const useMatch = /^\/__swisscode\/use\/([A-Za-z0-9][A-Za-z0-9-_]*)$/.exec(url);
          if (useMatch && req.method === "POST") {
            try {
              const account = await this.setActive(useMatch[1] as string);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: true, activeAccountId: account.id }));
            } catch (err) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: (err as Error).message }));
            }
            return;
          }
          const trafficUrl = new URL(url, "http://127.0.0.1");
          if (trafficUrl.pathname === "/__swisscode/traffic" && req.method === "GET") {
            const onlyProfile = trafficUrl.searchParams.get("profile") ?? undefined;
            const entries = this.getTraffic(onlyProfile);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                entries,
                kept: this.traffic.length,
                size: this.trafficBufferSize,
                profiles: this.trafficProfiles(),
              }),
            );
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
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ context }));
            return;
          }
          if (url === "/__swisscode/traffic" && req.method === "DELETE") {
            const cleared = this.clearTraffic();
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, cleared }));
            return;
          }
          const sizeMatch = /^\/__swisscode\/traffic\/size\/(\d+)$/.exec(url);
          if (sizeMatch && req.method === "POST") {
            const size = this.setTrafficBufferSize(parseInt(sizeMatch[1] as string, 10));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true, size, kept: this.traffic.length }));
            return;
          }
          const chunks: Buffer[] = [];
          req.on("data", (c: Buffer) => chunks.push(c));
          req.on("end", () => {
            void this.handleApi(
              req,
              res,
              chunks.length > 0 ? Buffer.concat(chunks) : undefined,
            ).catch((err: Error) => {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: err.message }));
            });
          });
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
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
