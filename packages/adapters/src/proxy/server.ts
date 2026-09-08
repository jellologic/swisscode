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
  OAuthClient,
  OAuthCredential,
  SubscriptionAccount,
} from "@swisscode/core";
import { ensureFreshCredential } from "@swisscode/core";

export const DEFAULT_PROXY_PORT = 8123;

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
}

export interface ProxyStatus {
  running: boolean;
  upstream: string;
  activeAccountId: string | null;
  accounts: { id: string; label: string; email?: string }[];
}

export class SubscriptionProxy {
  private server: Server | null = null;
  private activeAccountId: string | null = null;
  private readonly upstream: string;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly accounts: AccountRepository,
    private readonly oauth: OAuthClient,
    options: ProxyOptions = {},
  ) {
    this.upstream = (options.upstream ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
    void options.port;
  }

  async status(): Promise<ProxyStatus> {
    const all = await this.accounts.list();
    return {
      running: this.server !== null,
      upstream: this.upstream,
      activeAccountId: this.activeAccountId ?? all[0]?.id ?? null,
      accounts: all.map((a) => ({ id: a.id, label: a.label, email: a.email })),
    };
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

  private async freshToken(accountId: string): Promise<OAuthCredential> {
    return (await ensureFreshCredential(this.accounts, this.oauth, accountId)).credential;
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
    const inHeaders = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined || HOP_HEADERS.has(key.toLowerCase()) || key.toLowerCase() === "authorization") continue;
      inHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const path = req.url ?? "/";
    const ids = await this.candidates();
    if (ids.length === 0) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no subscription accounts stored" }));
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
        continue; // dead account (needs re-login): try the next one
      }
      let upstream: Response;
      try {
        upstream = await this.forward(req.method ?? "GET", path, new Headers(inHeaders), body, token);
      } catch (err) {
        lastBody = (err as Error).message;
        continue;
      }
      if (upstream.status === 401) {
        // Token rejected mid-flight: force one refresh, retry once on this account.
        try {
          const stored = await this.accounts.loadCredential(accountId);
          if (!stored) continue;
          const next = await this.oauth.refresh(stored);
          await this.accounts.saveCredential(accountId, next);
          upstream = await this.forward(req.method ?? "GET", path, new Headers(inHeaders), body, next.accessToken);
        } catch {
          continue;
        }
      }
      if ((upstream.status === 429 || upstream.status === 529) && accountId !== ids[ids.length - 1]) {
        await upstream.arrayBuffer().catch(() => undefined); // drain before failover
        lastStatus = upstream.status;
        lastBody = await upstream.text().catch(() => "rate limited");
        continue;
      }
      await this.pipe(upstream, res);
      return;
    }
    res.writeHead(lastStatus, { "Content-Type": "application/json" });
    res.end(typeof lastBody === "string" ? lastBody : JSON.stringify({ error: "all accounts exhausted" }));
  }

  private async pipe(upstream: Response, res: ServerResponse): Promise<void> {
    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      // fetch (undici) already decoded the body, so the original
      // content-encoding/content-length would corrupt the relay.
      if (lower === "content-encoding" || lower === "content-length") return;
      if (!HOP_HEADERS.has(lower)) outHeaders[key] = value;
    });
    res.writeHead(upstream.status, outHeaders);
    if (upstream.body) {
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    res.end();
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
