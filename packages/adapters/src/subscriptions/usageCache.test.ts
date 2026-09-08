import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AccountUsage, UsageClient } from "@swisscode/core";
import { CachingUsageClient, FileUsageCache } from "./usageCache.js";
import { UsageError } from "./anthropic.js";

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
