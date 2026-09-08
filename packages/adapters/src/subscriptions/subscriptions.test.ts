import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FileAccountRepository } from "./accountVault.js";
import { ClaudeActiveCredentialStore } from "./activeStore.js";
import { AnthropicOAuthClient, AnthropicUsageClient } from "./anthropic.js";
import { findAccountByCredential } from "./identity.js";
import { ensureFreshCredential, isCredentialExpired } from "@swisscode/core";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe("FileAccountRepository", () => {
  it("round-trips account + credential with 0600 permissions", async () => {
    const repo = new FileAccountRepository(join(await tempDir("vault-"), "subs"));
    assert.deepEqual(await repo.list(), []);
    await repo.save(
      { id: "personal", label: "Personal", createdAt: "", updatedAt: "" },
      { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3600_000 },
    );
    const listed = await repo.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, "personal");
    assert.ok((listed[0]?.createdAt ?? "").length > 0);
    const cred = await repo.loadCredential("personal");
    assert.equal(cred?.refreshToken, "rt");
    const mode = (await stat(join((repo as unknown as { dir: string }).dir, "personal.json"))).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.equal(await repo.remove("personal"), true);
    assert.equal(await repo.remove("personal"), false);
  });

  it("matches a credential lineage across access-token rotation", async () => {
    const repo = new FileAccountRepository(join(await tempDir("vault-"), "subs"));
    await repo.save(
      { id: "personal", label: "Personal", createdAt: "", updatedAt: "" },
      { accessToken: "old-at", refreshToken: "same-rt" },
    );
    await repo.save(
      { id: "work", label: "Work", createdAt: "", updatedAt: "" },
      { accessToken: "at", refreshToken: "other-rt" },
    );
    // Rotated access token, same refresh lineage → same account.
    const matched = await findAccountByCredential(repo, { accessToken: "new-at", refreshToken: "same-rt" });
    assert.equal(matched?.id, "personal");
    // Unknown lineage → null (safe to import as new).
    assert.equal(
      await findAccountByCredential(repo, { accessToken: "x", refreshToken: "fresh-rt" }),
      null,
    );
  });
});

describe("ClaudeActiveCredentialStore (file backend)", () => {
  it("reads, merges, and writes the credentials file without dropping keys", async () => {
    const home = await tempDir("claude-home-");
    const path = join(home, ".credentials.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path,
      JSON.stringify({ mcpOAuth: { x: 1 }, claudeAiOauth: { accessToken: "a", refreshToken: "r", expiresAt: 999 } }),
      "utf8",
    );
    const store = new ClaudeActiveCredentialStore({ configHome: home, keychain: false });
    const active = await store.readActive();
    assert.equal(active.backend, "file");
    assert.equal(active.credential?.accessToken, "a");
    await store.writeActive({ accessToken: "a2", refreshToken: "r2", expiresAt: 1000 });
    const next = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(next["mcpOAuth"], { x: 1 });
    assert.deepEqual(next["claudeAiOauth"], { accessToken: "a2", refreshToken: "r2", expiresAt: 1000 });
  });

  it("round-trips opaque /login fields verbatim", async () => {
    const home = await tempDir("claude-extra-");
    const path = join(home, ".credentials.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "a",
          refreshToken: "r",
          rateLimitTier: "default",
          subscriptionType: "max",
        },
      }),
      "utf8",
    );
    const store = new ClaudeActiveCredentialStore({ configHome: home, keychain: false });
    const active = await store.readActive();
    assert.deepEqual(active.credential?.extra, { rateLimitTier: "default", subscriptionType: "max" });
    await store.writeActive({ accessToken: "a2", refreshToken: "r2" });
    const next = JSON.parse(await readFile(path, "utf8")) as {
      claudeAiOauth: Record<string, unknown>;
    };
    assert.deepEqual(next.claudeAiOauth, {
      accessToken: "a2",
      refreshToken: "r2",
      rateLimitTier: "default",
      subscriptionType: "max",
    });
  });

  it("reports none when nothing is stored", async () => {
    const store = new ClaudeActiveCredentialStore({
      configHome: await tempDir("empty-home-"),
      keychain: false,
    });
    assert.equal((await store.readActive()).backend, "none");
  });
});

describe("expiry + refresh against stub endpoints", () => {
  it("refreshes expired credentials and persists the rotation", async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.url === "/v1/oauth/token") {
          const parsed = JSON.parse(body) as { refresh_token?: string };
          if (parsed.refresh_token === "dead") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_grant" }));
          } else {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }));
          }
        } else if (req.url === "/api/oauth/usage") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              five_hour: { utilization: 12.5, resets_at: "2026-09-08T04:40:00Z" },
              seven_day: { utilization: 55, resets_at: "2026-09-12T06:00:00Z" },
              seven_day_sonnet: { utilization: 41, resets_at: "2026-09-12T06:00:00Z" },
              limits: [
                { scope: { model: { display_name: "Fable" } }, percent: 41, resets_at: "2026-09-12T06:00:00Z" },
                { scope: {}, percent: 99 },
              ],
              extra_usage: { used_credits: 120, monthly_limit: 1000, utilization: 12 },
              tangelo: { utilization: 7 },
              member_dashboard_available: true,
            }),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const host = `http://127.0.0.1:${port}`;
      const oauth = new AnthropicOAuthClient({ tokenHost: host, apiHost: host });
      const usage = new AnthropicUsageClient({ apiHost: host });

      assert.equal(isCredentialExpired({ accessToken: "a", refreshToken: "r" }), true);
      assert.equal(
        isCredentialExpired({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000 }),
        false,
      );

      const repo = new FileAccountRepository(join(await tempDir("vault-"), "subs"));
      await repo.save(
        { id: "work", label: "Work", createdAt: "", updatedAt: "" },
        { accessToken: "old", refreshToken: "rt", expiresAt: 1 },
      );
      const fresh = await ensureFreshCredential(repo, oauth, "work");
      assert.equal(fresh.refreshed, true);
      assert.equal(fresh.credential.accessToken, "new-at");
      assert.equal((await repo.loadCredential("work"))?.refreshToken, "new-rt");

      const snapshot = await usage.fetchUsage("work", "new-at");
      assert.equal(snapshot.fiveHour?.utilization, 12.5);
      assert.equal(snapshot.sevenDay?.utilization, 55);
      assert.equal(snapshot.models?.["sonnet"]?.utilization, 41);
      assert.deepEqual(snapshot.scoped, [
        { name: "Fable", utilization: 41, resetsAt: "2026-09-12T06:00:00Z" },
      ]);
      assert.deepEqual(snapshot.spend, { used: 1.2, limit: 10 });
      assert.deepEqual(snapshot.windows, [{ key: "tangelo", utilization: 7 }]);

      await repo.save(
        { id: "dead", label: "Dead", createdAt: "", updatedAt: "" },
        { accessToken: "old", refreshToken: "dead", expiresAt: 1 },
      );
      await assert.rejects(() => ensureFreshCredential(repo, oauth, "dead"), /re-login/);
    } finally {
      server.close();
    }
  });
});
