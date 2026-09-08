import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AccountUsage, OAuthCredential, UsageClient } from "@swisscode/core";
import { CachingUsageClient, FileUsageCache } from "./usageCache.js";
import { FileAccountRepository } from "./accountVault.js";
import { credentialIdentity } from "./identity.js";
import { UsageError } from "./anthropic.js";

// A client built with no options resolves credential identity from the vault
// under SWISSCODE_HOME, so the whole file gets a throwaway home: no test may
// read the developer's real ~/.swisscode.
process.env["SWISSCODE_HOME"] = mkdtempSync(join(tmpdir(), "uc-home-"));

function credential(refreshToken: string): OAuthCredential {
  return { accessToken: "at", refreshToken, expiresAt: Date.now() + 3_600_000 };
}

function snapshot(): AccountUsage {
  return {
    accountId: "a",
    fetchedAt: new Date(0).toISOString(),
    fiveHour: { utilization: 40 },
  };
}

function stub(failures: Error[], ok = snapshot()): UsageClient & { calls: number } {
  const s = {
    calls: 0,
    async fetchUsage(): Promise<AccountUsage> {
      s.calls += 1;
      const next = failures.shift();
      if (next) throw next;
      return { ...ok, fetchedAt: new Date().toISOString() };
    },
  };
  return s;
}

describe("CachingUsageClient", () => {
  it("caches success and serves stale on 429 without refetching inside Retry-After", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uc-"));
    const cache = new FileUsageCache(join(dir, "cache.json"));
    let now = 1_000_000;
    const inner = stub([], snapshot());
    const client = new CachingUsageClient(inner, cache, { now: () => now });

    const fresh = await client.fetchUsage("a", "tok");
    assert.equal(fresh.stale, false);
    assert.equal(inner.calls, 1);

    // 429 with Retry-After: stale served, window recorded.
    inner.fetchUsage = async () => {
      inner.calls += 1;
      throw new UsageError("Usage fetch failed: HTTP 429", 429, 60_000);
    };
    const stale = await client.fetchUsage("a", "tok");
    assert.equal(stale.stale, true);
    assert.equal(stale.fiveHour?.utilization, 40);
    assert.equal(inner.calls, 2);

    // Inside the window: network untouched.
    const stale2 = await client.fetchUsage("a", "tok");
    assert.equal(stale2.stale, true);
    assert.equal(inner.calls, 2);

    // After the window: refetch attempted.
    now += 61_000;
    inner.fetchUsage = async () => {
      inner.calls += 1;
      return { ...snapshot(), fetchedAt: new Date().toISOString() };
    };
    const fresh2 = await client.fetchUsage("a", "tok");
    assert.equal(fresh2.stale, false);
    assert.equal(inner.calls, 3);
  });

  it("rethrows auth failures even with a warm cache", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uc-"));
    const cache = new FileUsageCache(join(dir, "cache.json"));
    await cache.set("a", { snapshot: snapshot() });
    const inner = stub([new UsageError("Usage fetch failed: HTTP 401", 401)]);
    const client = new CachingUsageClient(inner, cache);
    await assert.rejects(() => client.fetchUsage("a", "tok"), /401/);
  });

  it("does not serve a previous login's snapshot after a re-import", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uc-"));
    const cache = new FileUsageCache(join(dir, "cache.json"));
    let identity = "sha256:first-login";
    const inner = stub([], snapshot());
    const client = new CachingUsageClient(inner, cache, {
      accountIdentity: async () => identity,
    });
    await client.fetchUsage("a", "tok");
    assert.equal(inner.calls, 1);
    // Same id, different credential lineage: the old numbers are not this
    // account's, so the cache must miss rather than show them.
    identity = "sha256:second-login";
    inner.fetchUsage = async () => {
      inner.calls += 1;
      throw new UsageError("Usage fetch failed: HTTP 429", 429, 60_000);
    };
    await assert.rejects(() => client.fetchUsage("a", "tok"), /429/);
    assert.equal(inner.calls, 2);
    // Both logins are keyed separately in the same file.
    const keys = Object.keys(
      JSON.parse(await readFile(join(dir, "cache.json"), "utf8")) as Record<string, unknown>,
    ).sort();
    assert.deepEqual(keys, ["a#sha256:first-login", "a#sha256:second-login"]);
  });

  it("keys on credential identity with the shipped wiring (no options)", async () => {
    // Exactly how the CLI and the web server build it: any regression back to
    // an id-only key shows a deleted login's utilization after a re-import.
    const home = await mkdtemp(join(tmpdir(), "uc-home-"));
    const previousHome = process.env["SWISSCODE_HOME"];
    process.env["SWISSCODE_HOME"] = home;
    try {
      const vault = new FileAccountRepository(join(home, "subscriptions"));
      const first = credential("refresh-login-one");
      const account = {
        id: "a",
        label: "Personal",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      };
      await vault.save(account, first);

      const path = join(home, "usage-cache.json");
      const cache = new FileUsageCache(path);
      const inner = stub([], snapshot());
      const client = new CachingUsageClient(inner, cache);
      assert.equal((await client.fetchUsage("a", "tok")).stale, false);
      assert.equal(inner.calls, 1);

      // Re-import: same account id, a DIFFERENT login.
      const second = credential("refresh-login-two");
      await vault.save(account, second);
      inner.fetchUsage = async () => {
        inner.calls += 1;
        throw new UsageError("Usage fetch failed: HTTP 429", 429, 60_000);
      };
      await assert.rejects(() => client.fetchUsage("a", "tok"), /429/);
      assert.equal(inner.calls, 2);

      const keys = Object.keys(
        JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>,
      ).sort();
      assert.deepEqual(
        keys,
        [`a#${credentialIdentity(first)}`, `a#${credentialIdentity(second)}`].sort(),
      );
    } finally {
      if (previousHome === undefined) delete process.env["SWISSCODE_HOME"];
      else process.env["SWISSCODE_HOME"] = previousHome;
    }
  });

  it("keeps concurrent writes for different accounts from losing each other", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uc-"));
    const path = join(dir, "cache.json");
    const cache = new FileUsageCache(path);
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((id) => cache.set(id, { snapshot: { ...snapshot(), accountId: id } })),
    );
    const all = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(all).sort(), ["a", "b", "c", "d", "e"]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it("serializes two cache instances pointed at the same file", async () => {
    // The per-instance promise chain this replaced only knew about its own
    // object: the CLI and a server fn holding separate FileUsageCache handles
    // on one path could still lose each other's entries.
    const dir = await mkdtemp(join(tmpdir(), "uc-"));
    const path = join(dir, "cache.json");
    const a = new FileUsageCache(path);
    const b = new FileUsageCache(path);
    await Promise.all([
      a.set("one", { snapshot: { ...snapshot(), accountId: "one" } }),
      b.set("two", { snapshot: { ...snapshot(), accountId: "two" } }),
      a.set("three", { snapshot: { ...snapshot(), accountId: "three" } }),
      b.set("four", { snapshot: { ...snapshot(), accountId: "four" } }),
    ]);
    const all = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(all).sort(), ["four", "one", "three", "two"]);
  });

  it("survives a corrupt cache file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uc-"));
    const path = join(dir, "cache.json");
    await writeFile(path, "{ half-written", "utf8");
    const cache = new FileUsageCache(path);
    assert.equal(await cache.get("a"), undefined);
    const inner = stub([], snapshot());
    const fresh = await new CachingUsageClient(inner, cache).fetchUsage("a", "tok");
    assert.equal(fresh.stale, false);
  });

  it("throws when nothing is cached and the fetch fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uc-"));
    const cache = new FileUsageCache(join(dir, "cache.json"));
    const inner = stub([new UsageError("boom")]);
    const client = new CachingUsageClient(inner, cache);
    await assert.rejects(() => client.fetchUsage("a", "tok"), /boom/);
  });

  it("cools down without a snapshot so failures stop hitting the network", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uc-"));
    const cache = new FileUsageCache(join(dir, "cache.json"));
    let now = 1_000_000;
    const inner = stub([new UsageError("slow down", 429)]);
    const client = new CachingUsageClient(inner, cache, { now: () => now });
    await assert.rejects(() => client.fetchUsage("a", "tok"), /slow down/);
    assert.equal(inner.calls, 1);
    // Still cooling: no second network call, friendlier error.
    await assert.rejects(() => client.fetchUsage("a", "tok"), /rate-limited/);
    assert.equal(inner.calls, 1);
    now += 5 * 60_000 + 1;
    inner.fetchUsage = async () => {
      inner.calls += 1;
      return { ...snapshot(), fetchedAt: new Date().toISOString() };
    };
    const fresh = await client.fetchUsage("a", "tok");
    assert.equal(fresh.stale, false);
    assert.equal(inner.calls, 2);
  });
});
