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
});
