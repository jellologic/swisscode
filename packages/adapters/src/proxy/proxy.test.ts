import { mkdtemp } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { FileAccountRepository } from "../subscriptions/accountVault.js";
import { AnthropicOAuthClient } from "../subscriptions/anthropic.js";
import { FileProfileRepository } from "../store/fileProfiles.js";
import { FileProviderAccountRepository } from "../store/providerAccounts.js";
import { createProviderRegistry } from "../registry.js";
import type { GlobalSettings, Profile, ProviderPort, TrafficLog, UsageClient } from "@swisscode/core";
import type { FileUsageCache } from "../subscriptions/usageCache.js";
import type { FileSettingsStore } from "../store/fileSettings.js";
import type { ProxyTrafficEntry } from "./server.js";
import { PROXY_TOKEN_HEADER } from "./proxyToken.js";
import { SubscriptionProxy, cooldownMsFromRetryAfter, isLoopbackHost, parseProfilePath } from "./server.js";

// A refresh takes the vault's `<id>.lock`, whose directory is resolved from
// SWISSCODE_HOME when the call happens — so the whole file gets a throwaway
// home before any proxy runs. Nothing here may touch the user's real vault.
process.env["SWISSCODE_HOME"] = mkdtempSync(join(tmpdir(), "proxy-home-"));

// Bun's node:http server never surfaces a client abort (no req/res/socket
// close fires, even on poll) — upstream keeps generating where Node would cut
// it off. The abort test below is Node-only until that upstream gap closes.
const isBun = typeof process !== "undefined" && (process.versions as Record<string, string>).bun !== undefined;

/** A vault in a throwaway dir — never the real ~/.swisscode. */
async function tempVault(prefix: string): Promise<FileAccountRepository> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return new FileAccountRepository(join(dir, "subs"));
}

/**
 * Raw request: fetch refuses to set Host/Origin/Connection/Cookie, which are
 * exactly the headers the proxy's guards and header hygiene are about.
 */
function rawRequest(
  port: number,
  options: {
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    body?: Buffer;
  } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: options.path ?? "/v1/messages",
        method: options.method ?? "GET",
        headers: options.headers ?? {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => {
          settled = true;
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    // A refused upload is answered early and the socket then closes under our
    // remaining writes; that write error is not the result we are waiting for.
    req.on("error", (err) => {
      if (!settled) reject(err);
    });
    req.end(options.body);
  });
}

async function waitUntil(predicate: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("SubscriptionProxy", () => {
  it("swaps auth, fails over on 429, and streams bytes intact", async () => {
    const seenAuth: string[] = [];
    const upstream = createServer((req, res) => {
      const auth = req.headers["authorization"] ?? "";
      seenAuth.push(auth);
      if (req.url === "/v1/messages" && req.method === "POST") {
        if (auth === "Bearer tired-token") {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "rate_limited" }));
          return;
        }
        // SSE stream, two chunks with a pause to prove streaming (not buffered).
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write('data: {"a":1}\n\n');
        setTimeout(() => res.end('data: {"b":2}\n\n'), 20);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const dir = await mkdtemp(join(tmpdir(), "proxy-vault-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    const future = Date.now() + 3600_000;
    await repo.save(
      { id: "tired", label: "Tired", createdAt: "", updatedAt: "" },
      { accessToken: "tired-token", refreshToken: "rt1", expiresAt: future },
    );
    await repo.save(
      { id: "fresh", label: "Fresh", createdAt: "", updatedAt: "" },
      { accessToken: "fresh-token", refreshToken: "rt2", expiresAt: future },
    );

    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      upstream: `http://127.0.0.1:${upstreamPort}`,
    });
    const port = await proxy.listen(0);

    try {
      // Default active = first account (list is sorted: fresh, tired).
      const status = await (await fetch(`http://127.0.0.1:${port}/__swisscode/status`)).json();
      assert.equal(status.accounts.length, 2);

      // Point active at the tired account to exercise 429 failover.
      const useRes = await fetch(`http://127.0.0.1:${port}/__swisscode/use/tired`, { method: "POST" });
      assert.equal(useRes.status, 200);

      // Client sends no/wrong auth — proxy must replace it.
      const apiRes = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { Authorization: "Bearer client-token", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "x" }),
      });
      assert.equal(apiRes.status, 200);
      assert.equal(apiRes.headers.get("content-type"), "text/event-stream");
      const text = await apiRes.text();
      assert.ok(text.includes('"a":1') && text.includes('"b":2'));
      assert.deepEqual(seenAuth, ["Bearer tired-token", "Bearer fresh-token"]);
    } finally {
      await proxy.close();
      upstream.close();
    }
  });

  it("rejects (rather than crashing) when the port is taken", async () => {
    const squatter = createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((r) => squatter.listen(0, "127.0.0.1", r));
    const taken = (squatter.address() as { port: number }).port;
    try {
      const dir = await mkdtemp(join(tmpdir(), "proxy-taken-"));
      const proxy = new SubscriptionProxy(
        new FileAccountRepository(join(dir, "subs")),
        new AnthropicOAuthClient(),
        {},
      );
      // Before the listen error listener, this surfaced as an unhandled
      // 'error' event that killed the process — `proxy run`/`web` could never
      // print their "port in use" guidance. Bun's message says "in use"
      // without the EADDRINUSE code, so match either phrasing.
      await assert.rejects(() => proxy.listen(taken), /EADDRINUSE|in use/);
      await proxy.close().catch(() => undefined);
    } finally {
      squatter.close();
    }
  });

  it("strips upstream content-encoding/length (fetch pre-decodes bodies)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proxy-enc-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    // fetchFn stub: upstream claims brotli, but the Response body is already plain.
    const fetchFn = (async () =>
      new Response("plain-error-body", {
        status: 429,
        headers: { "content-encoding": "br", "content-length": "999" },
      })) as typeof fetch;
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), { fetchFn });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST" });
      assert.equal(res.status, 429);
      assert.equal(res.headers.get("content-encoding"), null);
      assert.equal(await res.text(), "plain-error-body");
    } finally {
      await proxy.close();
    }
  });

  it("still serves the request when the traffic store insert fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proxy-store-fail-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const fetchFn = (async () => new Response("ok-body", { status: 200 })) as typeof fetch;
    const failingStore: TrafficLog = {
      append: async () => {
        throw new Error("disk full");
      },
      query: async () => [],
      rollup: async () => [],
    };
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn,
      trafficStore: failingStore,
    });
    const port = await proxy.listen(0);
    try {
      // Reporting is fire-and-forget: the client gets its 200 while the
      // insert failure lands on stderr, never on the response.
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST" });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "ok-body");
    } finally {
      await proxy.close();
    }
  });

  it("emits redacted traffic entries with attempts, bytes, and opt-in bodies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proxy-traffic-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    const future = Date.now() + 3600_000;
    await repo.save(
      { id: "aaa", label: "A", createdAt: "", updatedAt: "" },
      { accessToken: "secret-token-aaa", refreshToken: "r1", expiresAt: future },
    );
    await repo.save(
      { id: "bbb", label: "B", createdAt: "", updatedAt: "" },
      { accessToken: "secret-token-bbb", refreshToken: "r2", expiresAt: future },
    );
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return new Response("limited", { status: 429 });
      return new Response("hello-stream", { status: 200 });
    }) as typeof fetch;
    const entries: unknown[] = [];
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn,
      logBodies: true,
      onTraffic: (e) => entries.push(e),
    });
    await proxy.setActive("aaa");
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
        method: "POST",
        headers: { Authorization: "Bearer [REDACTED]", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "probe" }),
      });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "hello-stream");
    } finally {
      await proxy.close();
    }
    assert.equal(entries.length, 1);
    const entry = entries[0] as Record<string, unknown>;
    assert.equal(entry["method"], "POST");
    assert.equal(entry["path"], "/v1/messages"); // query stripped
    assert.equal(entry["status"], 200);
    assert.equal(entry["accountId"], "bbb"); // failed over from aaa
    assert.deepEqual(entry["attempts"], [
      { accountId: "aaa", status: 429 },
      { accountId: "bbb", status: 200 },
    ]);
    assert.ok((entry["reqBytes"] as number) > 0);
    assert.equal(entry["resBytes"], "hello-stream".length);
    assert.ok(String(entry["reqBody"]).includes('"probe"'));
    assert.equal(entry["resBody"], "hello-stream");
    // Redaction: no token or client secret anywhere in the serialized entry.
    const serialized = JSON.stringify(entry);
    assert.ok(!serialized.includes("secret-token-aaa"));
    assert.ok(!serialized.includes("secret-token-bbb"));
    assert.ok(!serialized.includes("client-secret"));
  });

  it("buffers recent traffic and serves it over control endpoints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proxy-buffer-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      return new Response(JSON.stringify({ n }), { status: 200 });
    }) as typeof fetch;
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn,
      trafficBufferSize: 3,
      trafficBodyBytes: 64,
    });
    const port = await proxy.listen(0);
    const base = `http://127.0.0.1:${port}`;
    try {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${base}/v1/ping`, {
          method: "POST",
          body: JSON.stringify({ i }),
        });
        assert.equal(res.status, 200);
      }
      // Ring keeps the newest 3, newest-first, with bodies capped at 64 chars.
      let traffic = (await (await fetch(`${base}/__swisscode/traffic`)).json()) as {
        entries: { resBody?: string }[];
        kept: number;
        size: number;
      };
      assert.equal(traffic.kept, 3);
      assert.equal(traffic.size, 3);
      assert.equal(traffic.entries.length, 3);
      assert.ok((traffic.entries[0]?.resBody ?? "").includes('"n":5'));
      assert.ok((traffic.entries[0]?.resBody ?? "").length <= 64);

      const status = (await (await fetch(`${base}/__swisscode/status`)).json()) as {
        traffic: { kept: number; size: number };
      };
      assert.deepEqual(status.traffic, { kept: 3, size: 3 });

      // Resize trims oldest; delete clears.
      const sized = (await (
        await fetch(`${base}/__swisscode/traffic/size/1`, { method: "POST" })
      ).json()) as { size: number; kept: number };
      assert.deepEqual([sized.size, sized.kept], [1, 1]);
      const cleared = (await (
        await fetch(`${base}/__swisscode/traffic`, { method: "DELETE" })
      ).json()) as { cleared: number };
      assert.equal(cleared.cleared, 1);
      const after = (await (await fetch(`${base}/__swisscode/traffic`)).json()) as {
        entries: unknown[];
      };
      assert.equal(after.entries.length, 0);
    } finally {
      await proxy.close();
    }
  });

  it("serves null session context for sessions not on this machine", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proxy-vault-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
    });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/__swisscode/session/00000000-0000-0000-0000-000000000000`,
      );
      assert.equal(res.status, 200);
      const body = (await res.json()) as { context: unknown };
      assert.equal(body.context, null);
    } finally {
      await proxy.close();
    }
  });

  it("relays unknown present and future headers untouched", async () => {
    const seen: Record<string, string | string[]> = {};
    let seenMethod = "";
    let seenUrl = "";
    const upstream = createServer((req, res) => {
      seenMethod = req.method ?? "";
      seenUrl = req.url ?? "";
      for (const [k, v] of Object.entries(req.headers)) seen[k] = v ?? "";
      let bytes = 0;
      req.on("data", (c) => { bytes += c.length; });
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json", "x-upstream-echo": "yes" });
        res.end(JSON.stringify({ bytes }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const dir = await mkdtemp(join(tmpdir(), "proxy-relay-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "vault-token", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      upstream: `http://127.0.0.1:${upstreamPort}`,
    });
    const port = await proxy.listen(0);
    const payload = JSON.stringify({ hello: "world" });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "alpha,beta",
          "x-future-thing": "tomorrow",
        },
        body: payload,
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-upstream-echo"), "yes");
      assert.deepEqual(await res.json(), { bytes: payload.length });
    } finally {
      await proxy.close();
      upstream.close();
    }
    assert.equal(seenMethod, "POST");
    assert.equal(seenUrl, "/v1/messages?beta=true");
    assert.equal(seen["anthropic-version"], "2023-06-01");
    assert.equal(seen["anthropic-beta"], "alpha,beta");
    assert.equal(seen["x-future-thing"], "tomorrow");
    assert.equal(seen["authorization"], "Bearer vault-token");
    assert.equal(seen["host"], `127.0.0.1:${upstreamPort}`);
  });

  it("strips client credentials and signs with the vault Bearer", async () => {
    const seen: Record<string, string> = {};
    const first = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? "") : v ?? "");
    const upstream = createServer((req, res) => {
      seen["authorization"] = first(req.headers["authorization"]);
      seen["x-api-key"] = first(req.headers["x-api-key"]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const dir = await mkdtemp(join(tmpdir(), "proxy-creds-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "vault-token", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      upstream: `http://127.0.0.1:${upstreamPort}`,
    });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Authorization: "Bearer client-secret", "x-api-key": "sk-ant-stray" },
      });
      assert.equal(res.status, 200);
    } finally {
      await proxy.close();
      upstream.close();
    }
    // Vault Bearer replaces client auth; a stray client key never goes up.
    assert.equal(seen["authorization"], "Bearer vault-token");
    assert.equal(seen["x-api-key"], "");
  });

  it("on 401 adopts moved live lineage without burning a refresh", async () => {
    const seenAuth: string[] = [];
    const upstream = createServer((req, res) => {
      const auth = req.headers["authorization"] ?? "";
      seenAuth.push(auth);
      if (auth === "Bearer rejected-a") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const dir = await mkdtemp(join(tmpdir(), "proxy-401-adopt-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    const future = Date.now() + 3600_000;
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "rejected-a", refreshToken: "r-old", expiresAt: future },
    );
    let refreshCalls = 0;
    const oauth = { refresh: async () => { refreshCalls += 1; throw new Error("must not refresh a stale copy"); } };
    const liveCred = { accessToken: "live-a", refreshToken: "r-new", expiresAt: future };
    const live = {
      readActive: async () => ({ backend: "file" as const, credential: liveCred }),
      writeActive: async () => {},
    };
    const proxy = new SubscriptionProxy(repo, oauth as unknown as AnthropicOAuthClient, {
      upstream: `http://127.0.0.1:${upstreamPort}`,
      liveStore: live as unknown as import("@swisscode/core").ActiveCredentialStore,
    });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      assert.equal(res.status, 200);
    } finally {
      await proxy.close();
      upstream.close();
    }
    assert.deepEqual(seenAuth, ["Bearer rejected-a", "Bearer live-a"]);
    assert.equal(refreshCalls, 0); // adoption, not rotation
    assert.equal((await repo.loadCredential("solo"))?.refreshToken, "r-new");
    const [entry] = proxy.getTraffic();
    assert.deepEqual(
      entry?.attempts.map((a) => a.status),
      [401, 200],
    );
  });

  it("on 401 refresh-retries when the vault holds the live lineage", async () => {
    const seenAuth: string[] = [];
    const upstream = createServer((req, res) => {
      const auth = req.headers["authorization"] ?? "";
      seenAuth.push(auth);
      if (auth === "Bearer stale-a") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const dir = await mkdtemp(join(tmpdir(), "proxy-401-retry-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    const future = Date.now() + 3600_000;
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "stale-a", refreshToken: "r-same", expiresAt: future },
    );
    let refreshCalls = 0;
    const oauth = {
      refresh: async () => {
        refreshCalls += 1;
        return { accessToken: "rotated-a", refreshToken: "r-next", expiresAt: future };
      },
    };
    const mirrored: string[] = [];
    const live = {
      readActive: async () => ({
        backend: "file" as const,
        credential: { accessToken: "stale-a", refreshToken: "r-same", expiresAt: future },
      }),
      writeActive: async (credential: { accessToken: string }) => {
        mirrored.push(credential.accessToken);
      },
    };
    const proxy = new SubscriptionProxy(repo, oauth as unknown as AnthropicOAuthClient, {
      upstream: `http://127.0.0.1:${upstreamPort}`,
      liveStore: live as unknown as import("@swisscode/core").ActiveCredentialStore,
      lockDir: join(dir, "subs"),
    });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      assert.equal(res.status, 200);
    } finally {
      await proxy.close();
      upstream.close();
    }
    assert.deepEqual(seenAuth, ["Bearer stale-a", "Bearer rotated-a"]);
    assert.equal(refreshCalls, 1);
    // The vault copy and Claude Code share this refresh token, so our rotation
    // killed the one Claude holds. Recovering by calling oauth.refresh directly
    // skipped this write-back and logged the user's own `claude` out.
    assert.deepEqual(mirrored, ["rotated-a"]);
  });

  it("tags entries by profile and filters the traffic endpoint", async () => {
    const { parseProfileTag } = await import("./server.js");
    assert.equal(parseProfileTag("Bearer swisscode-profile/work"), "work");
    assert.equal(parseProfileTag("swisscode-profile/my-pro_file2"), "my-pro_file2");
    assert.equal(parseProfileTag("Bearer sk-ant-real-token"), undefined);
    assert.equal(parseProfileTag("Bearer swisscode-profile/"), undefined);
    assert.equal(parseProfileTag("Bearer swisscode-profile/bad name!"), undefined);
    assert.equal(parseProfileTag(undefined), undefined);

    const dir = await mkdtemp(join(tmpdir(), "proxy-profile-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const fetchFn = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn,
      trafficBufferSize: 10,
    });
    const port = await proxy.listen(0);
    const base = `http://127.0.0.1:${port}`;
    try {
      // Tagged like the CLI launcher does; untagged like a manual launch.
      await fetch(`${base}/v1/a`, { headers: { Authorization: "Bearer swisscode-profile/alpha" } });
      await fetch(`${base}/v1/b`, { headers: { Authorization: "Bearer swisscode-profile/beta" } });
      await fetch(`${base}/v1/c`, { headers: { Authorization: "Bearer personal-oauth-token" } });
      const all = (await (await fetch(`${base}/__swisscode/traffic`)).json()) as {
        entries: { path: string; profile?: string }[];
        profiles: string[];
      };
      assert.equal(all.entries.length, 3);
      assert.deepEqual(all.profiles, ["alpha", "beta"]);
      assert.equal(all.entries.find((e) => e.path === "/v1/a")?.profile, "alpha");
      assert.equal(all.entries.find((e) => e.path === "/v1/c")?.profile, undefined);
      // A real credential is never mistaken for a tag — and stays out of entries.
      assert.ok(!JSON.stringify(all).includes("personal-oauth-token"));

      const filtered = (await (
        await fetch(`${base}/__swisscode/traffic?profile=alpha`)
      ).json()) as { entries: { path: string }[] };
      assert.deepEqual(
        filtered.entries.map((e) => e.path),
        ["/v1/a"],
      );
    } finally {
      await proxy.close();
    }
  });

  it("parses request facts from the full body before truncation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proxy-bigreq-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const fetchFn = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn,
      trafficBufferSize: 10,
      trafficBodyBytes: 64, // tiny: raw head alone would be unparseable
    });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "big-model",
          system: "be brief",
          messages: [
            { role: "user", content: "one" },
            { role: "assistant", content: "two" },
            { role: "user", content: "three" },
          ],
          max_tokens: 512,
        }),
      });
      assert.equal(res.status, 200);
    } finally {
      await proxy.close();
    }
    const kept = proxy.getTraffic();
    assert.equal(kept.length, 1);
    assert.ok((kept[0]?.reqBody ?? "").length <= 64);
    assert.equal(kept[0]?.request?.model, "big-model");
    assert.equal(kept[0]?.request?.messageCount, 3);
    assert.equal(kept[0]?.request?.maxTokens, 512);
    assert.deepEqual(
      kept[0]?.request?.messages?.map((m) => [m.role, m.preview]),
      [["user", "one"], ["assistant", "two"], ["user", "three"]],
    );
  });

  it("caps buffered bodies at 64KB by default, whole only when asked", async () => {
    const bigText = "x".repeat(100_000);
    const fetchFn = (async () =>
      new Response(`data: {"type":"message_start"}\n\ndata: {"type":"tail","text":${JSON.stringify(bigText)}}\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as typeof fetch;
    const payload = JSON.stringify({ model: "m", content: bigText });

    const run = async (options: { trafficBodyBytes?: number }) => {
      const repo = await tempVault("proxy-full-");
      await repo.save(
        { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
        { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
      );
      const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), { fetchFn, ...options });
      const port = await proxy.listen(0);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: payload });
        assert.equal(res.status, 200);
        await res.text();
      } finally {
        await proxy.close();
      }
      return proxy.getTraffic();
    };

    // Default: 200 unbounded entries cost ~90MB of heap and ship the same on
    // every poll, so both sides are cut to 64KB and marked truncated.
    const capped = await run({});
    assert.equal(capped.length, 1);
    assert.equal(capped[0]?.reqBody?.length, 65536);
    assert.equal(capped[0]?.reqBodyTruncated, true);
    assert.equal(capped[0]?.resBody?.length, 65536);
    assert.equal(capped[0]?.resBodyTruncated, true);
    // Request facts still come from the FULL body, not the kept head.
    assert.equal(capped[0]?.request?.model, "m");

    // 0 still means unlimited for anyone who wants whole payloads.
    const whole = await run({ trafficBodyBytes: 0 });
    assert.equal(whole[0]?.reqBodyTruncated, false);
    assert.equal(whole[0]?.resBodyTruncated, false);
    const parsed = JSON.parse(whole[0]?.reqBody ?? "") as { content?: string };
    assert.equal(parsed.content?.length, 100_000);
    assert.ok((whole[0]?.resBody ?? "").includes(bigText));
  });

  it("keeps the request body on entries that never go upstream", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proxy-dead-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    await repo.save(
      { id: "dead", label: "Dead", createdAt: "", updatedAt: "" },
      { accessToken: "expired", refreshToken: "gone", expiresAt: Date.now() - 1000 },
    );
    const oauth = {
      refresh: async () => {
        throw new Error("Refresh token rejected");
      },
    };
    const proxy = new SubscriptionProxy(repo, oauth as unknown as AnthropicOAuthClient, {
      trafficBufferSize: 10,
    });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ model: "probe" }),
      });
      assert.equal(res.status, 502);
    } finally {
      await proxy.close();
    }
    const kept = proxy.getTraffic();
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.accountId, null);
    assert.deepEqual(kept[0]?.attempts, [{ accountId: "dead", status: "stale-credential" }]);
    assert.ok((kept[0]?.reqBody ?? "").includes('"probe"'));
  });

  it("survives an upstream stream that dies mid-response", async () => {
    // The upstream sends SSE headers, one chunk, then kills the socket. The
    // old pipe() answered that by calling writeHead(500) on an already-sent
    // response: ERR_HTTP_HEADERS_SENT inside the catch, unhandled rejection,
    // dead proxy. It must instead cut the client off and keep serving.
    const upstream = createServer((req, res) => {
      if (req.url === "/v1/break") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("data: one\n\n");
        setTimeout(() => res.socket?.destroy(), 10);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"after":"break"}');
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const repo = await tempVault("proxy-stream-break-");
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      upstream: `http://127.0.0.1:${upstreamPort}`,
      trafficBufferSize: 10,
    });
    const port = await proxy.listen(0);
    try {
      await assert.rejects(async () => {
        const res = await fetch(`http://127.0.0.1:${port}/v1/break`);
        await res.text();
      });
      // The proxy is still alive and answers the next request normally.
      const next = await fetch(`http://127.0.0.1:${port}/v1/fine`);
      assert.equal(next.status, 200);
      assert.equal(await next.text(), '{"after":"break"}');
    } finally {
      await proxy.close();
      upstream.close();
    }
    const broken = proxy.getTraffic().find((e) => e.path === "/v1/break");
    assert.equal(broken?.error, "upstream stream error");
    assert.equal(broken?.status, 502); // not a completed 200
    assert.deepEqual(
      broken?.attempts.map((a) => a.status),
      [200],
    );
  });

  it("aborts the upstream request when the client hangs up", { skip: isBun }, async () => {
    // Esc in Claude Code closes the socket; without propagating the abort the
    // model keeps generating (and billing) into a response nobody reads.
    let upstreamAborted = false;
    const upstream = createServer((req, res) => {
      req.on("close", () => {
        upstreamAborted = true;
      });
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: first\n\n"); // then never ends
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const repo = await tempVault("proxy-abort-");
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      upstream: `http://127.0.0.1:${upstreamPort}`,
      trafficBufferSize: 10,
    });
    const port = await proxy.listen(0);
    try {
      const controller = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        body: JSON.stringify({ model: "m" }),
        signal: controller.signal,
      });
      assert.equal(res.status, 200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read();
      assert.ok((first.value?.byteLength ?? 0) > 0);
      controller.abort();
      await waitUntil(() => upstreamAborted, "upstream to see the abort");
      await waitUntil(() => proxy.getTraffic().length > 0, "the aborted entry");
    } finally {
      await proxy.close();
      upstream.closeAllConnections();
      upstream.close();
    }
    const [entry] = proxy.getTraffic();
    assert.equal(entry?.error, "client aborted");
    assert.equal(entry?.status, 499); // not a 200 "complete"
    assert.ok((entry?.resBytes ?? 0) > 0); // the bytes that did arrive
  });

  it("refreshes one expired credential once for concurrent requests", async () => {
    const repo = await tempVault("proxy-flight-");
    await repo.save(
      { id: "flighted", label: "Flighted", createdAt: "", updatedAt: "" },
      { accessToken: "expired-a", refreshToken: "r-old", expiresAt: Date.now() - 1000 },
    );
    let refreshCalls = 0;
    const oauth = {
      refresh: async () => {
        refreshCalls += 1;
        // Refresh tokens are single-use: a second concurrent spend would come
        // back invalid_grant and strand the account.
        await new Promise((r) => setTimeout(r, 40));
        return { accessToken: "rotated-a", refreshToken: "r-new", expiresAt: Date.now() + 3600_000 };
      },
    };
    const seenAuth: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const proxy = new SubscriptionProxy(repo, oauth as unknown as AnthropicOAuthClient, { fetchFn });
    const port = await proxy.listen(0);
    try {
      const all = await Promise.all(
        [0, 1, 2].map((i) => fetch(`http://127.0.0.1:${port}/v1/m${i}`, { method: "POST", body: "{}" })),
      );
      for (const res of all) assert.equal(res.status, 200);
    } finally {
      await proxy.close();
    }
    assert.equal(refreshCalls, 1);
    assert.deepEqual(seenAuth, ["Bearer rotated-a", "Bearer rotated-a", "Bearer rotated-a"]);
  });

  it("refuses non-loopback Host headers (DNS rebinding)", async () => {
    assert.equal(isLoopbackHost("127.0.0.1:8123"), true);
    assert.equal(isLoopbackHost("localhost"), true);
    assert.equal(isLoopbackHost("[::1]:8123"), true);
    assert.equal(isLoopbackHost("attacker.example:8123"), false);
    assert.equal(isLoopbackHost("127.0.0.1.attacker.example"), false);
    assert.equal(isLoopbackHost(undefined), false);

    const repo = await tempVault("proxy-host-");
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    let upstreamCalls = 0;
    const fetchFn = (async () => {
      upstreamCalls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), { fetchFn });
    const port = await proxy.listen(0);
    try {
      // A rebound name resolving to 127.0.0.1 still carries its own Host.
      const rebound = await rawRequest(port, {
        path: "/__swisscode/status",
        headers: { host: "attacker.example" },
      });
      assert.equal(rebound.status, 403);
      const api = await rawRequest(port, { headers: { host: "attacker.example" }, method: "POST" });
      assert.equal(api.status, 403);
      assert.equal(upstreamCalls, 0);
      const ok = await rawRequest(port, { path: "/__swisscode/status", headers: { host: `localhost:${port}` } });
      assert.equal(ok.status, 200);
    } finally {
      await proxy.close();
    }
  });

  it("refuses browser-originated requests (Origin / Sec-Fetch-Site)", async () => {
    const repo = await tempVault("proxy-origin-");
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      trafficBufferSize: 10,
    });
    const port = await proxy.listen(0);
    try {
      // A page on any origin can reach 127.0.0.1; only these headers say so.
      const crossOrigin = await rawRequest(port, {
        path: "/__swisscode/use/solo",
        method: "POST",
        headers: { origin: "https://attacker.example" },
      });
      assert.equal(crossOrigin.status, 403);
      const sameSite = await rawRequest(port, {
        path: "/__swisscode/traffic",
        headers: { "sec-fetch-site": "same-site" },
      });
      assert.equal(sameSite.status, 403);
      // Claude Code sends neither header, so it is unaffected.
      assert.equal((await rawRequest(port, { path: "/__swisscode/traffic" })).status, 200);
    } finally {
      await proxy.close();
    }
  });

  it("gates control routes behind the control token, leaving the API open", async () => {
    const repo = await tempVault("proxy-token-");
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      controlToken: "s3cret-run-token",
    });
    const port = await proxy.listen(0);
    const base = `http://127.0.0.1:${port}`;
    try {
      assert.equal((await fetch(`${base}/__swisscode/status`)).status, 401);
      assert.equal(
        (await fetch(`${base}/__swisscode/use/solo`, { method: "POST" })).status,
        401,
      );
      const wrong = await fetch(`${base}/__swisscode/status`, {
        headers: { [PROXY_TOKEN_HEADER]: "guessed" },
      });
      assert.equal(wrong.status, 401);
      const right = await fetch(`${base}/__swisscode/status`, {
        headers: { [PROXY_TOKEN_HEADER]: "s3cret-run-token" },
      });
      assert.equal(right.status, 200);
      // The proxied API path is not a control route: Claude Code has no token.
      assert.equal((await fetch(`${base}/v1/messages`, { method: "POST", body: "{}" })).status, 200);
    } finally {
      await proxy.close();
    }
  });

  it("cannot be walked around the token gate with a dot-segment or absolute target", async () => {
    const repo = await tempVault("proxy-token-bypass-");
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn: (async () => new Response("{}", { status: 200 })) as typeof fetch,
      controlToken: "s3cret-run-token",
      trafficBufferSize: 10,
    });
    const port = await proxy.listen(0);
    try {
      // The gate used to test the RAW request-target with startsWith while the
      // routes matched the WHATWG-normalized pathname, so every one of these
      // reached the traffic/session data with no token at all.
      for (const path of [
        "/x/../__swisscode/traffic",
        "/__swisscode/../__swisscode/traffic",
        "/./__swisscode/traffic",
        "/x/../__swisscode/session/abc",
        "/x/../__swisscode/traffic/entry/t1-1",
        `http://127.0.0.1:${port}/__swisscode/traffic`,
      ]) {
        const res = await rawRequest(port, { path });
        assert.equal(res.status, 400, path);
        assert.ok(!res.body.includes("entries"), `${path} must not answer with traffic`);
        assert.ok(!res.body.includes("context"), `${path} must not answer with session context`);
      }
      // The token still opens the front door, and normal paths still route.
      const right = await fetch(`http://127.0.0.1:${port}/__swisscode/traffic`, {
        headers: { [PROXY_TOKEN_HEADER]: "s3cret-run-token" },
      });
      assert.equal(right.status, 200);
      const api = await rawRequest(port, { path: "/v1/messages?beta=true", method: "POST" });
      assert.equal(api.status, 200);
    } finally {
      await proxy.close();
    }
  });

  it("serves body-less listings and one entry by id", async () => {
    const repo = await tempVault("proxy-views-");
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn: (async () => new Response('{"reply":"pong"}', { status: 200 })) as typeof fetch,
      trafficBufferSize: 10,
    });
    const port = await proxy.listen(0);
    const base = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "listed", messages: [{ role: "user", content: "ping" }] }),
      });
      assert.equal(res.status, 200);

      // bodies=0 is the list view: every fact except the raw payloads.
      const listed = (await (await fetch(`${base}/__swisscode/traffic?bodies=0`)).json()) as {
        entries: Record<string, unknown>[];
        kept: number;
        size: number;
        profiles: string[];
      };
      assert.equal(listed.entries.length, 1);
      const [slim] = listed.entries;
      assert.equal(slim?.["reqBody"], undefined);
      assert.equal(slim?.["resBody"], undefined);
      assert.equal(slim?.["reqBodyTruncated"], undefined);
      assert.equal(slim?.["resBodyTruncated"], undefined);
      assert.equal(slim?.["status"], 200);
      assert.equal(slim?.["path"], "/v1/messages");
      assert.ok((slim?.["reqBytes"] as number) > 0);
      assert.equal((slim?.["request"] as { model?: string })?.model, "listed"); // facts kept
      assert.deepEqual(listed.kept, 1);
      assert.deepEqual(listed.size, 10);

      const id = slim?.["id"] as string;
      assert.match(id, /^t[a-z0-9]+-[a-z0-9]+$/);
      const detail = (await (await fetch(`${base}/__swisscode/traffic/entry/${id}`)).json()) as {
        entry: { reqBody?: string; resBody?: string };
      };
      assert.ok(detail.entry.reqBody?.includes("listed"));
      assert.equal(detail.entry.resBody, '{"reply":"pong"}');

      // Aged-out and malformed ids are the same answer: JSON 404, no crash.
      const missing = await fetch(`${base}/__swisscode/traffic/entry/t0-0`);
      assert.equal(missing.status, 404);
      assert.ok(typeof ((await missing.json()) as { error?: string }).error === "string");
      const bogus = await fetch(`${base}/__swisscode/traffic/entry/not-an-id`);
      assert.equal(bogus.status, 404);

      // Default (no bodies param) is unchanged.
      const full = (await (await fetch(`${base}/__swisscode/traffic`)).json()) as {
        entries: { reqBody?: string }[];
      };
      assert.ok(full.entries[0]?.reqBody?.includes("listed"));
    } finally {
      await proxy.close();
    }
  });

  it("refuses a request body over 32MB with 413", async () => {
    const repo = await tempVault("proxy-413-");
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    let upstreamCalls = 0;
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn: (async () => {
        upstreamCalls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    const port = await proxy.listen(0);
    try {
      // The whole body is buffered so failover can replay it, so one request
      // is a hard memory bound.
      const oversized = await rawRequest(port, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.alloc(33 * 1024 * 1024, 0x20),
      });
      assert.equal(oversized.status, 413);
      assert.ok(String((JSON.parse(oversized.body) as { error?: string }).error).includes("33554432"));
      assert.equal(upstreamCalls, 0);
      // A normal request on the same proxy is unaffected.
      const ok = await rawRequest(port, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify({ model: "small" })),
      });
      assert.equal(ok.status, 200);
      assert.equal(upstreamCalls, 1);
    } finally {
      await proxy.close();
    }
  });

  it("cools a rate-limited account down instead of re-hitting it", async () => {
    assert.equal(cooldownMsFromRetryAfter(null), 60_000);
    assert.equal(cooldownMsFromRetryAfter("30"), 30_000);
    assert.equal(cooldownMsFromRetryAfter("nonsense"), 60_000);
    // Shared with the usage client: a header that is not delta-seconds is not
    // a cooldown either — parseInt used to read this as twelve seconds.
    assert.equal(cooldownMsFromRetryAfter("12abc"), 60_000);
    assert.equal(cooldownMsFromRetryAfter("99999"), 15 * 60_000); // clamped

    const repo = await tempVault("proxy-cooldown-");
    const future = Date.now() + 3600_000;
    await repo.save(
      { id: "aaa", label: "A", createdAt: "", updatedAt: "" },
      { accessToken: "tired", refreshToken: "r1", expiresAt: future },
    );
    await repo.save(
      { id: "bbb", label: "B", createdAt: "", updatedAt: "" },
      { accessToken: "fresh", refreshToken: "r2", expiresAt: future },
    );
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth === "Bearer tired") {
        return new Response("over quota", { status: 429, headers: { "retry-after": "120" } });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn,
      trafficBufferSize: 10,
    });
    await proxy.setActive("aaa");
    const port = await proxy.listen(0);
    try {
      for (const path of ["/v1/one", "/v1/two"]) {
        assert.equal((await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", body: "{}" })).status, 200);
      }
    } finally {
      await proxy.close();
    }
    const first = proxy.getTraffic().find((e) => e.path === "/v1/one");
    const second = proxy.getTraffic().find((e) => e.path === "/v1/two");
    assert.deepEqual(first?.attempts, [
      { accountId: "aaa", status: 429 },
      { accountId: "bbb", status: 200 },
    ]);
    // The second request skips the cooled account entirely — no wasted round
    // trip to a quota we already know is gone.
    assert.deepEqual(second?.attempts, [{ accountId: "bbb", status: 200 }]);
  });

  it("traces a network error when the 401 retry throws", async () => {
    const repo = await tempVault("proxy-retry-throw-");
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "rejected", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const oauth = {
      refresh: async () => ({
        accessToken: "rotated",
        refreshToken: "r2",
        expiresAt: Date.now() + 3600_000,
      }),
    };
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return new Response("nope", { status: 401 });
      throw new Error("socket hang up");
    }) as typeof fetch;
    const proxy = new SubscriptionProxy(repo, oauth as unknown as AnthropicOAuthClient, {
      fetchFn,
      trafficBufferSize: 10,
    });
    const port = await proxy.listen(0);
    let body: string;
    let status: number;
    try {
      // Unguarded, the retry's rejection escaped as a raw 500 with no entry.
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: "{}" });
      status = res.status;
      body = await res.text();
    } finally {
      await proxy.close();
    }
    assert.equal(status, 502);
    const parsed = JSON.parse(body) as { error: string; attempts: { status: unknown }[] };
    assert.equal(parsed.error, "socket hang up");
    const [entry] = proxy.getTraffic();
    assert.deepEqual(
      entry?.attempts.map((a) => a.status),
      [401, "network-error"],
    );
    assert.equal(entry?.status, 502);
  });

  it("drops accept-encoding, cookies, and connection-scoped headers", async () => {
    const seen: Record<string, string | string[] | undefined> = {};
    const upstream = createServer((req, res) => {
      for (const [k, v] of Object.entries(req.headers)) seen[k] = v;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const repo = await tempVault("proxy-hygiene-");
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "vault-token", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      upstream: `http://127.0.0.1:${upstreamPort}`,
    });
    const port = await proxy.listen(0);
    try {
      const res = await rawRequest(port, {
        path: "/v1/messages",
        headers: {
          "accept-encoding": "x-swisscode-unknown-codec",
          cookie: "session=browser-secret",
          connection: "keep-alive, x-hop-only",
          "x-hop-only": "must-not-leak",
          "x-keep-me": "yes",
        },
      });
      assert.equal(res.status, 200);
    } finally {
      await proxy.close();
      upstream.close();
    }
    // undici sets its own accept-encoding and decodes the answer; relaying the
    // client's would let an encoding we cannot decode reach it as raw bytes.
    assert.ok(!String(seen["accept-encoding"] ?? "").includes("x-swisscode-unknown-codec"));
    assert.equal(seen["cookie"], undefined);
    assert.equal(seen["x-hop-only"], undefined); // named by the client's Connection
    assert.equal(seen["x-keep-me"], "yes");
    assert.equal(seen["authorization"], "Bearer vault-token");
  });

  it("answers the exhausted path with valid JSON", async () => {
    const repo = await tempVault("proxy-exhausted-");
    const future = Date.now() + 3600_000;
    await repo.save(
      { id: "aaa", label: "A", createdAt: "", updatedAt: "" },
      { accessToken: "a-token", refreshToken: "r1", expiresAt: future },
    );
    await repo.save(
      { id: "bbb", label: "B", createdAt: "", updatedAt: "" },
      { accessToken: "b-token", refreshToken: "r2", expiresAt: future },
    );
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      // Reading this 429 body twice used to throw, so the client got the
      // literal string "rate limited" under an application/json header.
      if (new Headers(init?.headers).get("authorization") === "Bearer a-token") {
        return new Response("account a is over quota", { status: 429 });
      }
      throw new Error("upstream unreachable");
    }) as unknown as typeof fetch;
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      fetchFn,
      trafficBufferSize: 10,
    });
    await proxy.setActive("aaa");
    const port = await proxy.listen(0);
    let raw: string;
    let contentType: string | null;
    let status: number;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: "{}" });
      status = res.status;
      contentType = res.headers.get("content-type");
      raw = await res.text();
    } finally {
      await proxy.close();
    }
    assert.equal(contentType, "application/json");
    const parsed = JSON.parse(raw) as { error: string; attempts: { accountId: string; status: unknown }[] };
    assert.equal(status, 429);
    assert.notEqual(parsed.error, "rate limited");
    assert.deepEqual(parsed.attempts, [
      { accountId: "aaa", status: 429 },
      { accountId: "bbb", status: "network-error" },
    ]);
  });

  it("gives up on an upstream that never sends response headers", async () => {
    const upstream = createServer(() => {
      // Accept the request and answer nothing, ever.
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const repo = await tempVault("proxy-timeout-");
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      upstream: `http://127.0.0.1:${upstreamPort}`,
      upstreamHeadersTimeoutMs: 80,
      trafficBufferSize: 10,
    });
    const port = await proxy.listen(0);
    let status: number;
    let body: string;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: "{}" });
      status = res.status;
      body = await res.text();
    } finally {
      await proxy.close();
      upstream.closeAllConnections();
      upstream.close();
    }
    assert.equal(status, 502);
    const parsed = JSON.parse(body) as { error: string };
    assert.match(parsed.error, /did not answer within 80ms/);
    const [entry] = proxy.getTraffic();
    assert.deepEqual(
      entry?.attempts.map((a) => a.status),
      ["network-error"],
    );
  });

  it("streams a slow reader without buffering the whole response", async () => {
    // Backpressure: res.write() returning false must park the pump, not queue
    // the rest of a long stream in memory.
    const chunk = "x".repeat(64 * 1024);
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let sent = 0;
      const push = () => {
        if (sent === 40) {
          res.end();
          return;
        }
        sent += 1;
        res.write(`data: ${chunk}\n\n`, () => setImmediate(push));
      };
      push();
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;
    const repo = await tempVault("proxy-drain-");
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      upstream: `http://127.0.0.1:${upstreamPort}`,
      trafficBufferSize: 10,
      trafficBodyBytes: 1024,
    });
    const port = await proxy.listen(0);
    let received = 0;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: "{}" });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        await new Promise((r) => setTimeout(r, 1)); // slow consumer
      }
    } finally {
      await proxy.close();
      upstream.close();
    }
    assert.equal(received, 40 * (chunk.length + 8));
    const [entry] = proxy.getTraffic();
    assert.equal(entry?.resBytes, received);
    assert.equal(entry?.error, undefined);
    assert.equal(entry?.resBodyTruncated, true); // capture stayed bounded
  });

  it("logs a 503 entry when no accounts are stored", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proxy-traffic-empty-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    const entries: unknown[] = [];
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), {
      onTraffic: (e) => entries.push(e),
    });
    const port = await proxy.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      assert.equal(res.status, 503);
    } finally {
      await proxy.close();
    }
    assert.equal(entries.length, 1);
    const entry = entries[0] as Record<string, unknown>;
    assert.equal(entry["status"], 503);
    assert.equal(entry["accountId"], null);
    assert.equal(entry["reqBody"], undefined); // bodies off by default
  });
});

describe("profile identity + model routing", () => {
  // Test-only key provider: speaks the same ANTHROPIC_* vars every real key
  // provider speaks, so the proxy's env translation is what gets exercised.
  const stubKeyProvider: ProviderPort = {
    id: "stub-key",
    displayName: "Stub Key",
    description: "test-only key provider",
    fields: [],
    accountCapabilities: { importActive: false, usageMetrics: false, switchVia: [] },
    buildEnv: (config) => ({
      ...(config?.["baseUrl"] ? { ANTHROPIC_BASE_URL: config["baseUrl"] } : {}),
      ...(config?.["apiKey"] ? { ANTHROPIC_AUTH_TOKEN: config["apiKey"] } : {}),
    }),
  };

  interface Seen {
    url: string;
    auth: string;
    apiKey: string;
    model: unknown;
  }

  /** Stub upstream: records what the proxy actually sent, answers 200. */
  async function startRecordingStub(seen: Seen[]): Promise<{
    server: ReturnType<typeof createServer>;
    port: number;
  }> {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        let model: unknown;
        try {
          model = (JSON.parse(raw) as { model?: unknown }).model;
        } catch {
          model = undefined;
        }
        const header = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(",") : (v ?? ""));
        seen.push({
          url: req.url ?? "",
          auth: header(req.headers["authorization"]),
          apiKey: header(req.headers["x-api-key"]),
          model,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, port: (server.address() as { port: number }).port };
  }

  interface World {
    vault: FileAccountRepository;
    profiles: FileProfileRepository;
    providerAccounts: FileProviderAccountRepository;
  }

  /** Throwaway stores — never the real ~/.swisscode. */
  async function routingWorld(options: {
    profiles: Profile[];
    keyAccounts?: { providerId: string; id: string; label: string; config: Record<string, string> }[];
    vaultAccounts?: { id: string; token: string }[];
  }): Promise<World> {
    const dir = await mkdtemp(join(tmpdir(), "proxy-route-"));
    const vault = new FileAccountRepository(join(dir, "subs"));
    const future = Date.now() + 3600_000;
    for (const a of options.vaultAccounts ?? []) {
      await vault.save(
        { id: a.id, label: a.id, createdAt: "", updatedAt: "" },
        { accessToken: a.token, refreshToken: `rt-${a.id}`, expiresAt: future },
      );
    }
    const profiles = new FileProfileRepository(join(dir, "profiles.json"));
    for (const p of options.profiles) await profiles.save(p);
    const providerAccounts = new FileProviderAccountRepository(join(dir, "accounts"));
    for (const a of options.keyAccounts ?? []) {
      await providerAccounts.save({ ...a, createdAt: "", updatedAt: "" });
    }
    return { vault, profiles, providerAccounts };
  }

  const subProfile = (over: Partial<Profile> & { name: string }): Profile => ({
    agentId: "claude-code",
    providerId: "claude-subscription",
    useProxy: true,
    ...over,
  });

  function proxied(
    world: World,
    extra: { entries?: ProxyTrafficEntry[]; keyUpstream?: string } = {},
  ): SubscriptionProxy {
    return new SubscriptionProxy(world.vault, new AnthropicOAuthClient(), {
      profiles: world.profiles,
      providerAccounts: world.providerAccounts,
      providers: createProviderRegistry([stubKeyProvider]),
      ...(extra.entries ? { onTraffic: (e: ProxyTrafficEntry) => extra.entries?.push(e) } : {}),
      ...(extra.keyUpstream ? { upstream: extra.keyUpstream } : {}),
    });
  }

  const postModel = (port: number, path: string, model: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ model, max_tokens: 8 }),
    });

  it("parses /p/<name> identity prefixes", () => {
    assert.deepEqual(parseProfilePath("/p/alpha/v1/messages"), { name: "alpha", rest: "/v1/messages" });
    assert.deepEqual(parseProfilePath("/p/alpha"), { name: "alpha", rest: "/" });
    assert.deepEqual(parseProfilePath("/p/a-9_Z/x"), { name: "a-9_Z", rest: "/x" });
    assert.equal(parseProfilePath("/v1/messages"), undefined);
    assert.equal(parseProfilePath("/p/"), undefined);
    assert.equal(parseProfilePath("/p/a b/x"), undefined);
    assert.equal(parseProfilePath("/P/alpha/x"), undefined);
  });

  it("attributes path identity and strips the prefix before forwarding", async () => {
    // The key stub's base URL doubles as the vault upstream here: any ANTHROPIC
    // endpoint answers the same shape, and the vault loop only needs a 200.
    const keySeen: Seen[] = [];
    const keyStub = await startRecordingStub(keySeen);
    const world = await routingWorld({
      profiles: [subProfile({ name: "alpha", subscriptionAccountId: "a1" })],
      vaultAccounts: [{ id: "a1", token: "tok-a1" }],
    });
    const entries: ProxyTrafficEntry[] = [];
    const proxy = proxied(world, { entries, keyUpstream: `http://127.0.0.1:${keyStub.port}` });
    const port = await proxy.listen(0);
    try {
      const res = await postModel(port, "/p/alpha/v1/messages?x=1", "claude-opus-5");
      assert.equal(res.status, 200);
      // Prefix stripped, query preserved; vault credential signs the request.
      assert.deepEqual(keySeen.map((s) => s.url), ["/v1/messages?x=1"]);
      assert.deepEqual(keySeen.map((s) => s.auth), ["Bearer tok-a1"]);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.profile, "alpha");
      assert.equal(entries[0]?.route, undefined);
    } finally {
      await proxy.close();
      keyStub.server.close();
    }
  });

  it("prefers path over header tag and notes the mismatch", async () => {
    const keySeen: Seen[] = [];
    const keyStub = await startRecordingStub(keySeen);
    const world = await routingWorld({
      profiles: [
        subProfile({ name: "alpha", subscriptionAccountId: "a1" }),
        subProfile({ name: "beta", subscriptionAccountId: "a1" }),
      ],
      vaultAccounts: [{ id: "a1", token: "tok-a1" }],
    });
    const entries: ProxyTrafficEntry[] = [];
    const proxy = proxied(world, { entries, keyUpstream: `http://127.0.0.1:${keyStub.port}` });
    const port = await proxy.listen(0);
    try {
      const res = await postModel(port, "/p/alpha/v1/messages", "m", {
        Authorization: "Bearer swisscode-profile/beta",
      });
      assert.equal(res.status, 200);
      // The client tag never reaches upstream — the vault token signs it.
      assert.deepEqual(keySeen.map((s) => s.auth), ["Bearer tok-a1"]);
      assert.ok(!keySeen.some((s) => s.auth.includes("swisscode-profile")));
      assert.equal(entries[0]?.profile, "alpha");
      assert.ok((entries[0]?.note ?? "").includes("beta"));
    } finally {
      await proxy.close();
      keyStub.server.close();
    }
  });

  it("reads header-tag identity when no path prefix is present", async () => {
    const keySeen: Seen[] = [];
    const keyStub = await startRecordingStub(keySeen);
    const world = await routingWorld({
      profiles: [subProfile({ name: "alpha", subscriptionAccountId: "a1" })],
      vaultAccounts: [{ id: "a1", token: "tok-a1" }],
    });
    const entries: ProxyTrafficEntry[] = [];
    const proxy = proxied(world, { entries, keyUpstream: `http://127.0.0.1:${keyStub.port}` });
    const port = await proxy.listen(0);
    try {
      const res = await postModel(port, "/v1/messages", "m", {
        Authorization: "Bearer swisscode-profile/alpha",
      });
      assert.equal(res.status, 200);
      assert.deepEqual(keySeen.map((s) => s.url), ["/v1/messages"]);
      assert.equal(entries[0]?.profile, "alpha");
      assert.equal(entries[0]?.note, undefined);
    } finally {
      await proxy.close();
      keyStub.server.close();
    }
  });

  it("routes a matching model to its account and rewrites upstreamModel", async () => {
    const keySeen: Seen[] = [];
    const keyStub = await startRecordingStub(keySeen);
    const world = await routingWorld({
      profiles: [
        subProfile({
          name: "alpha",
          subscriptionAccountId: "a-base",
          modelRoutes: [
            {
              match: "claude-opus-5",
              kind: "subscription",
              subscriptionAccountId: "a-fast",
              upstreamModel: "claude-sonnet-9",
            },
          ],
        }),
      ],
      vaultAccounts: [
        { id: "a-base", token: "tok-base" },
        { id: "a-fast", token: "tok-fast" },
      ],
    });
    const entries: ProxyTrafficEntry[] = [];
    const proxy = proxied(world, { entries, keyUpstream: `http://127.0.0.1:${keyStub.port}` });
    const port = await proxy.listen(0);
    try {
      const res = await postModel(port, "/p/alpha/v1/messages", "claude-opus-5");
      assert.equal(res.status, 200);
      assert.deepEqual(keySeen.map((s) => s.auth), ["Bearer tok-fast"]);
      assert.deepEqual(keySeen.map((s) => s.model), ["claude-sonnet-9"]);
      assert.equal(entries[0]?.route, "claude-opus-5");
      assert.equal(entries[0]?.upstreamModel, "claude-sonnet-9");
      // A non-matching model stays on the base binding, un-rewritten.
      const res2 = await postModel(port, "/p/alpha/v1/messages", "claude-haiku-9");
      assert.equal(res2.status, 200);
      assert.deepEqual(keySeen.map((s) => s.auth), ["Bearer tok-fast", "Bearer tok-base"]);
      assert.deepEqual(keySeen.map((s) => s.model), ["claude-sonnet-9", "claude-haiku-9"]);
      assert.equal(entries[1]?.route, undefined);
    } finally {
      await proxy.close();
      keyStub.server.close();
    }
  });

  it("fails a pinned subscription route over to the rest of the vault on 429", async () => {
    // First upstream hit answers 429; everything after answers 200. The pin is
    // a preference, not a cage: the route keeps whole-vault failover.
    const seenAuth: string[] = [];
    const seenModel: unknown[] = [];
    let hits = 0;
    const failoverStub = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString("utf8")));
      req.on("end", () => {
        const header = req.headers["authorization"];
        seenAuth.push(Array.isArray(header) ? header.join(",") : (header ?? ""));
        try {
          seenModel.push((JSON.parse(raw) as { model?: unknown }).model);
        } catch {
          seenModel.push(undefined);
        }
        hits += 1;
        if (hits === 1) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "rate_limited" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => failoverStub.listen(0, "127.0.0.1", r));
    const world = await routingWorld({
      profiles: [
        subProfile({
          name: "alpha",
          subscriptionAccountId: "a-fresh",
          modelRoutes: [
            {
              match: "claude-opus-5",
              kind: "subscription",
              subscriptionAccountId: "a-tired",
              upstreamModel: "claude-sonnet-9",
            },
          ],
        }),
      ],
      vaultAccounts: [
        { id: "a-tired", token: "tired-token-xyz" },
        { id: "a-fresh", token: "fresh-token-xyz" },
      ],
    });
    const entries: ProxyTrafficEntry[] = [];
    const proxy = proxied(world, {
      entries,
      keyUpstream: `http://127.0.0.1:${(failoverStub.address() as { port: number }).port}`,
    });
    const port = await proxy.listen(0);
    try {
      const res = await postModel(port, "/p/alpha/v1/messages", "claude-opus-5");
      assert.equal(res.status, 200);
      // Pinned account first, then the rest of the vault — and the rewrite
      // applies to the retried request too (the body is rewritten pre-loop).
      assert.deepEqual(seenAuth, ["Bearer tired-token-xyz", "Bearer fresh-token-xyz"]);
      assert.deepEqual(seenModel, ["claude-sonnet-9", "claude-sonnet-9"]);
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.route, "claude-opus-5");
      assert.equal(entries[0]?.upstreamModel, "claude-sonnet-9");
      assert.deepEqual(entries[0]?.attempts, [
        { accountId: "a-tired", status: 429 },
        { accountId: "a-fresh", status: 200 },
      ]);
      // Explicit no-tokens assertion: route + rewrite facts are recorded, but
      // neither vault token nor the client tag may appear in the entry.
      const serialized = JSON.stringify(entries[0]);
      assert.ok(!serialized.includes("tired-token-xyz"));
      assert.ok(!serialized.includes("fresh-token-xyz"));
      assert.ok(!serialized.includes("swisscode-profile"));
    } finally {
      await proxy.close();
      failoverStub.close();
    }
  });

  it("applies profile edits to the next request without a restart", async () => {
    const keySeen: Seen[] = [];
    const keyStub = await startRecordingStub(keySeen);
    const world = await routingWorld({
      profiles: [
        subProfile({
          name: "alpha",
          subscriptionAccountId: "a-base",
          modelRoutes: [{ match: "claude-opus-5", kind: "subscription", subscriptionAccountId: "a1" }],
        }),
      ],
      vaultAccounts: [
        { id: "a-base", token: "tok-base" },
        { id: "a1", token: "tok-1" },
        { id: "a2", token: "tok-2" },
      ],
    });
    const proxy = proxied(world, { keyUpstream: `http://127.0.0.1:${keyStub.port}` });
    const port = await proxy.listen(0);
    try {
      assert.equal((await postModel(port, "/p/alpha/v1/messages", "claude-opus-5")).status, 200);
      // Live edit: same proxy, same running session, new route target.
      await world.profiles.save(
        subProfile({
          name: "alpha",
          subscriptionAccountId: "a-base",
          modelRoutes: [{ match: "claude-opus-5", kind: "subscription", subscriptionAccountId: "a2" }],
        }),
      );
      assert.equal((await postModel(port, "/p/alpha/v1/messages", "claude-opus-5")).status, 200);
      assert.deepEqual(keySeen.map((s) => s.auth), ["Bearer tok-1", "Bearer tok-2"]);
    } finally {
      await proxy.close();
      keyStub.server.close();
    }
  });

  it("answers 404 for a deleted profile and keeps serving others", async () => {
    const keySeen: Seen[] = [];
    const keyStub = await startRecordingStub(keySeen);
    const world = await routingWorld({
      profiles: [subProfile({ name: "alpha", subscriptionAccountId: "a1" })],
      vaultAccounts: [{ id: "a1", token: "tok-a1" }],
    });
    const entries: ProxyTrafficEntry[] = [];
    const proxy = proxied(world, { entries, keyUpstream: `http://127.0.0.1:${keyStub.port}` });
    const port = await proxy.listen(0);
    try {
      const ghost = await postModel(port, "/p/ghost/v1/messages", "m");
      assert.equal(ghost.status, 404);
      assert.ok((await ghost.text()).includes("ghost"));
      // The proxy itself is fine — the next request resolves from scratch.
      const ok = await postModel(port, "/p/alpha/v1/messages", "m");
      assert.equal(ok.status, 200);
      assert.equal(entries[0]?.status, 404);
      assert.equal(entries[0]?.profile, "ghost");
      assert.equal(entries[1]?.status, 200);
    } finally {
      await proxy.close();
      keyStub.server.close();
    }
  });

  it("falls back to the base provider when the model is unparseable", async () => {
    const keySeen: Seen[] = [];
    const keyStub = await startRecordingStub(keySeen);
    const world = await routingWorld({
      profiles: [subProfile({ name: "alpha", subscriptionAccountId: "a1" })],
      vaultAccounts: [{ id: "a1", token: "tok-a1" }],
    });
    const entries: ProxyTrafficEntry[] = [];
    const proxy = proxied(world, { entries, keyUpstream: `http://127.0.0.1:${keyStub.port}` });
    const port = await proxy.listen(0);
    try {
      const res = await rawRequest(port, {
        path: "/p/alpha/v1/messages",
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: Buffer.from("not json{{{"),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(keySeen.map((s) => s.auth), ["Bearer tok-a1"]);
      assert.equal(entries[0]?.profile, "alpha");
      assert.equal(entries[0]?.route, undefined);
    } finally {
      await proxy.close();
      keyStub.server.close();
    }
  });

  it("forwards key profiles with the stored credential, vault empty", async () => {
    const keySeen: Seen[] = [];
    const keyStub = await startRecordingStub(keySeen);
    const world = await routingWorld({
      profiles: [{ agentId: "claude-code", name: "key", providerId: "stub-key", providerAccountId: "k1" }],
      keyAccounts: [
        {
          providerId: "stub-key",
          id: "k1",
          label: "K One",
          config: { apiKey: "k-secret", baseUrl: `http://127.0.0.1:${keyStub.port}` },
        },
      ],
    });
    const entries: ProxyTrafficEntry[] = [];
    // No vault accounts at all: the key path must not need the vault.
    const proxy = proxied(world, { entries });
    const port = await proxy.listen(0);
    try {
      const res = await postModel(port, "/p/key/v1/messages", "some-model", {
        Authorization: "Bearer swisscode-profile/key",
      });
      assert.equal(res.status, 200);
      assert.deepEqual(keySeen.map((s) => s.auth), ["Bearer k-secret"]);
      assert.deepEqual(keySeen.map((s) => s.model), ["some-model"]);
      assert.ok(!keySeen.some((s) => `${s.auth} ${s.apiKey}`.includes("swisscode-profile")));
      assert.equal(entries[0]?.accountId, "key:stub-key:K One");
      assert.equal(entries[0]?.profile, "key");
    } finally {
      await proxy.close();
      keyStub.server.close();
    }
  });

  it("fails closed naming a deleted route account", async () => {
    const keySeen: Seen[] = [];
    const keyStub = await startRecordingStub(keySeen);
    const world = await routingWorld({
      profiles: [
        subProfile({
          name: "alpha",
          subscriptionAccountId: "a1",
          modelRoutes: [{ match: "claude-opus-5", kind: "subscription", subscriptionAccountId: "gone" }],
        }),
      ],
      vaultAccounts: [{ id: "a1", token: "tok-a1" }],
    });
    const entries: ProxyTrafficEntry[] = [];
    const proxy = proxied(world, { entries, keyUpstream: `http://127.0.0.1:${keyStub.port}` });
    const port = await proxy.listen(0);
    try {
      const res = await postModel(port, "/p/alpha/v1/messages", "claude-opus-5");
      assert.equal(res.status, 500);
      assert.ok((await res.text()).includes("gone"));
      assert.deepEqual(keySeen.length, 0);
      assert.equal(entries[0]?.status, 500);
    } finally {
      await proxy.close();
      keyStub.server.close();
    }
  });

  it("keeps unattributed requests on the legacy whole-vault flow", async () => {
    const keySeen: Seen[] = [];
    const keyStub = await startRecordingStub(keySeen);
    const world = await routingWorld({
      profiles: [subProfile({ name: "alpha", subscriptionAccountId: "a1" })],
      vaultAccounts: [{ id: "a1", token: "tok-a1" }],
    });
    const entries: ProxyTrafficEntry[] = [];
    const proxy = proxied(world, { entries, keyUpstream: `http://127.0.0.1:${keyStub.port}` });
    const port = await proxy.listen(0);
    try {
      const res = await postModel(port, "/v1/messages", "m");
      assert.equal(res.status, 200);
      assert.equal(entries[0]?.status, 200);
      assert.ok(!("profile" in (entries[0] as object)));
    } finally {
      await proxy.close();
      keyStub.server.close();
    }
  });

  describe("rotation lifecycle", () => {
    const now = Date.now();
    const MIN = 60_000;

    // a2 is decisively better under either strategy: cooler and sooner reset.
    function usageFor(accountId: string) {
      const hot = accountId === "a1";
      return {
        accountId,
        fetchedAt: new Date(now).toISOString(),
        fiveHour: {
          utilization: hot ? 80 : 5,
          resetsAt: new Date(now + (hot ? 120 : 60) * MIN).toISOString(),
        },
      };
    }

    function rotationProxy(world: World, logs: string[]): SubscriptionProxy {
      const settings = {
        get: async (): Promise<GlobalSettings> => ({
          rotationEnabled: true,
          rotationStrategy: "reset-soonest",
          updateMode: "auto",
        }),
      };
      return new SubscriptionProxy(world.vault, new AnthropicOAuthClient(), {
        profiles: world.profiles,
        providerAccounts: world.providerAccounts,
        providers: createProviderRegistry([stubKeyProvider]),
        rotation: {
          usageClient: { fetchUsage: async (id: string) => usageFor(id) } as UsageClient,
          usageCache: { get: async () => undefined } as unknown as FileUsageCache,
          settings: settings as unknown as FileSettingsStore,
          enabled: true,
          pollMs: 3600_000,
          log: (m: string) => logs.push(m),
        },
      });
    }

    function pollerRunning(proxy: SubscriptionProxy): boolean | undefined {
      return (proxy as unknown as { rotationPoller?: { running: boolean } }).rotationPoller?.running;
    }

    it("leaves status without rotation when unconfigured", async () => {
      const world = await routingWorld({
        profiles: [subProfile({ name: "alpha", subscriptionAccountId: "a1" })],
        vaultAccounts: [{ id: "a1", token: "tok-a1" }],
      });
      const proxy = proxied(world);
      assert.equal(proxy.rotationState(), undefined);
      assert.equal((await proxy.status()).rotation, undefined);
      await proxy.close();
    });

    it("ticks on listen, reports the switch in status, stops on close", async () => {
      const world = await routingWorld({
        profiles: [subProfile({ name: "alpha", subscriptionAccountId: "a1" })],
        vaultAccounts: [
          { id: "a1", token: "tok-a1" },
          { id: "a2", token: "tok-a2" },
        ],
      });
      const logs: string[] = [];
      const proxy = rotationProxy(world, logs);
      await proxy.listen(0);
      try {
        assert.equal(pollerRunning(proxy), true);
        await waitUntil(() => (proxy.rotationState()?.lastRunAt ?? null) !== null, "rotation tick");
        const status = await proxy.status();
        assert.equal(status.rotation?.enabled, true);
        assert.equal(status.rotation?.strategy, "reset-soonest");
        assert.equal(status.rotation?.checked, 2);
        assert.equal(status.rotation?.usable, 2);
        // listen() seeds active from the first vault id (a1); the tick then
        // rolls over to the decisively better a2.
        assert.equal(status.rotation?.switched, "a1→a2");
        assert.equal(status.activeAccountId, "a2");
        assert.match(logs.join("\n"), /active a1→a2/);
      } finally {
        await proxy.close();
      }
      assert.equal(pollerRunning(proxy), false);
    });
  });
});
