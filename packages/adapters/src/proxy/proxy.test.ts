import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { FileAccountRepository } from "../subscriptions/accountVault.js";
import { AnthropicOAuthClient } from "../subscriptions/anthropic.js";
import { SubscriptionProxy } from "./server.js";

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
    const live = {
      readActive: async () => ({
        backend: "file" as const,
        credential: { accessToken: "stale-a", refreshToken: "r-same", expiresAt: future },
      }),
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
    assert.deepEqual(seenAuth, ["Bearer stale-a", "Bearer rotated-a"]);
    assert.equal(refreshCalls, 1);
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

  it("keeps entire request/response bodies by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proxy-full-"));
    const repo = new FileAccountRepository(join(dir, "subs"));
    await repo.save(
      { id: "solo", label: "Solo", createdAt: "", updatedAt: "" },
      { accessToken: "t", refreshToken: "r", expiresAt: Date.now() + 3600_000 },
    );
    const bigText = "x".repeat(100_000);
    const fetchFn = (async () =>
      new Response(`data: {"type":"message_start"}\n\ndata: {"type":"tail","text":${JSON.stringify(bigText)}}\n\n`, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as typeof fetch;
    const proxy = new SubscriptionProxy(repo, new AnthropicOAuthClient(), { fetchFn });
    const port = await proxy.listen(0);
    try {
      const payload = JSON.stringify({ model: "m", content: bigText });
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: "POST", body: payload });
      assert.equal(res.status, 200);
      await res.text();
    } finally {
      await proxy.close();
    }
    const kept = proxy.getTraffic();
    assert.equal(kept.length, 1);
    // Whole bodies retained: the request still parses, nothing truncated.
    assert.equal(kept[0]?.reqBodyTruncated, false);
    assert.equal(kept[0]?.resBodyTruncated, false);
    const parsed = JSON.parse(kept[0]?.reqBody ?? "") as { content?: string };
    assert.equal(parsed.content?.length, 100_000);
    assert.ok((kept[0]?.resBody ?? "").includes(bigText));
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
