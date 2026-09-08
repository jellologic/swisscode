// Client for the proxy's control routes (/__swisscode/*).
//
// One implementation for both shells. The CLI and the web UI each used to
// carry their own: they disagreed on which statuses mean "token rejected"
// (401 vs 401|403) and on what to tell the user, so the same dead proxy
// produced two different diagnoses depending on where you asked.
//
// Three invariants live here so no caller has to remember them:
//  1. Every control request carries the per-run token (PROXY_TOKEN_HEADER).
//     "localhost" is not an authorization boundary — a page in any browser can
//     reach 127.0.0.1 — so the proxy now demands the shared secret from
//     ~/.swisscode/proxy-token. The token is read per call because the file is
//     re-minted on every `swisscode proxy run`; a cached one would go stale.
//  2. Ids are encodeURIComponent'd. They are validated upstream, but a control
//     URL is the last place to learn that a "/" arrived in an id.
//  3. A proxy that cannot be reached (down, or a token we cannot present) is a
//     STATE, not a crash: it surfaces as ProxyUnavailableError, which the store
//     turns into the existing "proxy not running" view.
//
// It reads a 0600 file, so it belongs in adapters and web imports it from a
// `.server.` module — node:fs must never reach the client bundle.

import { PROXY_TOKEN_HEADER, readProxyToken } from "./proxyToken.js";
import { proxyBaseUrl } from "../paths.js";
import type { ProxyStatus, ProxyTrafficEntry } from "./server.js";
import type { SessionContext } from "./sessionContext.js";

/** Said when nothing answered on the control port. */
export const PROXY_NOT_RUNNING = "Proxy is not running. Start it with `swisscode proxy run`.";

/**
 * Said when the proxy answered but refused us. 403 counts too: a proxy that
 * rejects the request for any authorization reason is one this caller cannot
 * drive, and reporting it as a state beats a raw HTTP code in the UI.
 */
export const PROXY_TOKEN_REJECTED =
  "The proxy refused this request — its control token is missing or stale. Restart it with `swisscode proxy run`.";

/** The proxy is not reachable, or refused our control token. */
export class ProxyUnavailableError extends Error {
  constructor(message = PROXY_NOT_RUNNING) {
    super(message);
    this.name = "ProxyUnavailableError";
  }
}

export interface ProxyControlOptions {
  /** Override for tests; defaults to the configured port on 127.0.0.1. */
  baseUrl?: string;
  fetchFn?: typeof fetch;
  /** Reads the per-run control token. Undefined = send no token header. */
  readToken?: () => Promise<string | undefined>;
}

export interface TrafficListResponse {
  entries: ProxyTrafficEntry[];
  kept: number;
  size: number;
  profiles: string[];
}

export interface TrafficQuery {
  profile?: string;
  /** False asks the proxy to drop reqBody/resBody (request facts are kept). */
  bodies?: boolean;
}

export class ProxyControlClient {
  private readonly baseUrl: string | undefined;
  private readonly fetchFn: typeof fetch;
  private readonly readToken: () => Promise<string | undefined>;

  constructor(options: ProxyControlOptions = {}) {
    this.baseUrl = options.baseUrl;
    this.fetchFn = options.fetchFn ?? fetch;
    this.readToken = options.readToken ?? (() => readProxyToken());
  }

  /** Resolved per call: SWISSCODE_PROXY_PORT can change between requests. */
  private base(): string {
    return (this.baseUrl ?? proxyBaseUrl()).replace(/\/$/, "");
  }

  private async call(path: string, method: "GET" | "POST" | "DELETE" = "GET"): Promise<unknown> {
    const token = await this.readToken();
    const headers: Record<string, string> = token ? { [PROXY_TOKEN_HEADER]: token } : {};
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base()}${path}`, { method, headers });
    } catch {
      throw new ProxyUnavailableError();
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProxyUnavailableError(PROXY_TOKEN_REJECTED);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Proxy returned HTTP ${res.status}`);
    }
    return res.json().catch(() => ({}));
  }

  async status(): Promise<ProxyStatus> {
    return (await this.call("/__swisscode/status")) as ProxyStatus;
  }

  async use(accountId: string): Promise<void> {
    await this.call(`/__swisscode/use/${encodeURIComponent(accountId)}`, "POST");
  }

  /**
   * Buffered traffic. `bodies: false` is the polling shape: every entry keeps
   * its request facts and byte counts, but the megabytes of prompt and
   * response text stay on the proxy until a page asks for one entry.
   */
  async traffic(query: TrafficQuery = {}): Promise<TrafficListResponse> {
    const params = new URLSearchParams();
    if (query.profile !== undefined && query.profile !== "") params.set("profile", query.profile);
    if (query.bodies === false) params.set("bodies", "0");
    const search = params.toString();
    const suffix = search === "" ? "" : `?${search}`;
    const body = (await this.call(`/__swisscode/traffic${suffix}`)) as Partial<TrafficListResponse>;
    return {
      entries: body.entries ?? [],
      kept: body.kept ?? 0,
      size: body.size ?? 0,
      profiles: body.profiles ?? [],
    };
  }

  /** One entry with its bodies. Null when it has left the ring buffer. */
  async entry(id: string): Promise<ProxyTrafficEntry | null> {
    const body = (await this.call(`/__swisscode/traffic/entry/${encodeURIComponent(id)}`)) as {
      entry?: ProxyTrafficEntry | null;
    };
    return body.entry ?? null;
  }

  async clearTraffic(): Promise<number> {
    const body = (await this.call("/__swisscode/traffic", "DELETE")) as { cleared?: number };
    return body.cleared ?? 0;
  }

  async setTrafficSize(size: number): Promise<{ size: number; kept: number }> {
    const body = (await this.call(
      `/__swisscode/traffic/size/${encodeURIComponent(String(size))}`,
      "POST",
    )) as { size?: number; kept?: number };
    return { size: body.size ?? size, kept: body.kept ?? 0 };
  }

  async sessionContext(sessionId: string): Promise<SessionContext | null> {
    const body = (await this.call(
      `/__swisscode/session/${encodeURIComponent(sessionId)}`,
    )) as { context?: SessionContext | null };
    return body.context ?? null;
  }
}
