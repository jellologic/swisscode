import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FileProviderAccountRepository, maskSecret } from "./providerAccounts.js";
import { OpenRouterUsageReader } from "../providers/openRouterUsage.js";
import { credentialIdentity } from "../subscriptions/identity.js";

describe("FileProviderAccountRepository", () => {
  it("scopes accounts per provider with 0600 files", async () => {
    const repo = new FileProviderAccountRepository(join(await mkdtemp(join(tmpdir(), "gac-")), "a"));
    assert.deepEqual(await repo.list(), []);
    const now = "";
    await repo.save({ id: "work", providerId: "openrouter", label: "Work", config: { apiKey: "sk-or-123456789" }, createdAt: now, updatedAt: now });
    await repo.save({ id: "work", providerId: "other", label: "Other", config: {}, createdAt: now, updatedAt: now });
    assert.equal((await repo.list()).length, 2);
    assert.equal((await repo.list("openrouter")).length, 1);
    assert.equal((await repo.get("openrouter", "work"))?.config["apiKey"], "sk-or-123456789");
    assert.equal(await repo.get("openrouter", "missing"), undefined);
    assert.equal(await repo.remove("openrouter", "work"), true);
    assert.equal((await repo.list("openrouter")).length, 0);
    // Same id under another provider is untouched.
    assert.equal((await repo.list("other")).length, 1);
  });

  it("masks secrets for display", () => {
    assert.equal(maskSecret("sk-or-123456789"), "sk-o…89");
    assert.equal(maskSecret("short"), "••••••••");
  });
});

describe("OpenRouterUsageReader", () => {
  it("maps key info to metrics", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ data: { label: "main", usage: 1.5, limit: 10 } }), { status: 200 })) as typeof fetch;
    const reader = new OpenRouterUsageReader({ fetchFn });
    const snapshot = await reader.readUsage({
      id: "work",
      providerId: "openrouter",
      label: "Work",
      config: { apiKey: "k" },
      createdAt: "",
      updatedAt: "",
    });
    const byLabel = new Map(snapshot.metrics.map((m) => [m.label, m.value]));
    assert.equal(byLabel.get("Spend"), "$1.50");
    assert.equal(byLabel.get("Limit"), "$10.00");
    assert.equal(byLabel.get("Used"), "15.0%");
  });

  it("rejects dead keys with a clear error", async () => {
    const fetchFn = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const reader = new OpenRouterUsageReader({ fetchFn });
    await assert.rejects(
      () =>
        reader.readUsage({ id: "w", providerId: "openrouter", label: "W", config: {}, createdAt: "", updatedAt: "" }),
      /rejected/,
    );
  });
});

describe("credentialIdentity", () => {
  it("is stable per refresh-token lineage", () => {
    const a = credentialIdentity({ accessToken: "a1", refreshToken: "same" });
    const b = credentialIdentity({ accessToken: "a2", refreshToken: "same" });
    const c = credentialIdentity({ accessToken: "a1", refreshToken: "other" });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(a.startsWith("sha256:"));
  });
});
