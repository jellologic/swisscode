// Store tests run against throwaway DBs in the system temp dir — the real
// ~/.swisscode (and its live proxy-traffic.sqlite) is never opened here.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchTrafficFilter, rollupExchanges } from "@swisscode/core";
import type { StoredTrafficExchange } from "@swisscode/core";
import type { ProxyTrafficEntry } from "./server.js";
import { openTrafficStore, toStoredExchange } from "./trafficStore.js";

let seq = 0;

/** Minimal capture; overrides specialize per test. Timestamps rise with seq. */
function entry(overrides: Partial<ProxyTrafficEntry> = {}): ProxyTrafficEntry {
  seq += 1;
  return {
    id: `t-${seq}`,
    ts: new Date(Date.UTC(2026, 8, 8, 10, 0, seq)).toISOString(),
    method: "POST",
    path: "/v1/messages",
    status: 200,
    ms: 100 + seq,
    accountId: "vault-a",
    reqBytes: 12,
    resBytes: 34,
    attempts: [{ accountId: "vault-a", status: 200 }],
    ...overrides,
  };
}

const USAGE_BODY = JSON.stringify({
  type: "message",
  content: [],
  usage: { input_tokens: 1200, output_tokens: 85 },
});

async function tempStore(name: string, opts?: { maxDays?: number; maxRows?: number }) {
  const dir = await mkdtemp(join(tmpdir(), name));
  return openTrafficStore(join(dir, "proxy-traffic.sqlite"), opts);
}

describe("toStoredExchange", () => {
  it("keeps named scalars and drops bodies, headers, and secrets", () => {
    const stored = toStoredExchange(
      entry({
        profile: "work",
        route: "opus",
        request: { model: "opus", approxInputTokens: 50 },
        providerId: "claude-subscription",
        reqBody: JSON.stringify({ model: "opus", key: "sk-ant-secret-xyz" }),
        resBody: USAGE_BODY,
      }),
    );
    assert.equal(stored.profile, "work");
    assert.equal(stored.route, "opus");
    assert.equal(stored.accountId, "vault-a");
    assert.equal(stored.model, "opus");
    assert.equal(stored.reqTokens, 1200);
    assert.equal(stored.resTokens, 85);
    // The secret crossed the boundary inside a body; nothing stored keeps it.
    assert.ok(!JSON.stringify(stored).includes("sk-ant-secret-xyz"));
  });

  it("falls back to the request approx and upstream model without usage", () => {
    const stored = toStoredExchange(
      entry({
        request: { approxInputTokens: 40 },
        upstreamModel: "openai/gpt-5",
        resBody: undefined,
      }),
    );
    assert.equal(stored.reqTokens, 40);
    assert.equal(stored.model, "openai/gpt-5");
    assert.equal(stored.upstreamModel, "openai/gpt-5");
    assert.equal(stored.resTokens, undefined);
  });

  it("mints an id for entries captured before ids existed", () => {
    const stored = toStoredExchange(entry({ id: undefined }));
    assert.equal(typeof stored.id, "string");
    assert.ok(stored.id.length > 0);
    assert.equal(toStoredExchange(entry({ id: "kept" })).id, "kept");
  });

  it("reduces hops to account ids and statuses, preserving string causes", () => {
    const stored = toStoredExchange(
      entry({
        attempts: [
          { accountId: "vault-a", status: 429 },
          { accountId: "vault-b", status: "network-error" },
        ],
      }),
    );
    assert.deepEqual(stored.attempts, [
      { accountId: "vault-a", status: 429 },
      { accountId: "vault-b", status: "network-error" },
    ]);
  });
});

describe("SqliteTrafficLog", () => {
  it("round-trips an exchange with its hops in order", async () => {
    const store = await tempStore("traffic-roundtrip-");
    try {
      const stored = toStoredExchange(
        entry({
          id: "round-1",
          profile: "work",
          attempts: [
            { accountId: "vault-a", status: 429 },
            { accountId: "vault-b", status: 200 },
          ],
        }),
      );
      await store.append(stored);
      const rows = await store.query({});
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.id, "round-1");
      assert.equal(rows[0]?.profile, "work");
      assert.deepEqual(rows[0]?.attempts, [
        { accountId: "vault-a", status: 429 },
        { accountId: "vault-b", status: 200 },
      ]);
    } finally {
      store.close();
    }
  });

  it("answers every filter dimension the same way the core predicate does", async () => {
    const store = await tempStore("traffic-filters-");
    try {
      const seeds: StoredTrafficExchange[] = [
        toStoredExchange(
          entry({ id: "e1", profile: "work", route: "opus", accountId: "vault-a", request: { model: "opus" } }),
        ),
        toStoredExchange(
          entry({
            id: "e2",
            profile: "work",
            route: "codex",
            accountId: "vault-b",
            request: { model: "codex" },
            upstreamModel: "openai/gpt-5",
          }),
        ),
        toStoredExchange(
          entry({ id: "e3", profile: "home", route: "opus", accountId: "vault-a", request: { model: "opus" }, status: 429 }),
        ),
        // 200 with an error note: errorsOnly must still catch it.
        toStoredExchange(
          entry({ id: "e4", profile: "work", route: "opus", accountId: "vault-a", request: { model: "opus" }, error: "client hung up" }),
        ),
        // Ambient base traffic: no profile, no route, no account, no model.
        toStoredExchange(entry({ id: "e5", profile: undefined, route: undefined, accountId: null })),
      ];
      for (const s of seeds) await store.append(s);
      const ids = (rows: StoredTrafficExchange[]) => rows.map((r) => r.id);

      assert.deepEqual(ids(await store.query({})), ["e1", "e2", "e3", "e4", "e5"]);
      assert.deepEqual(ids(await store.query({ profile: "work" })), ["e1", "e2", "e4"]);
      assert.deepEqual(ids(await store.query({ route: "opus" })), ["e1", "e3", "e4"]);
      assert.deepEqual(ids(await store.query({ account: "vault-a" })), ["e1", "e3", "e4"]);
      assert.deepEqual(ids(await store.query({ model: "openai/gpt-5" })), ["e2"]);
      assert.deepEqual(ids(await store.query({ model: "opus" })), ["e1", "e3", "e4"]);
      assert.deepEqual(
        ids(await store.query({ since: seeds[1]?.ts, until: seeds[3]?.ts })),
        ["e2", "e3"],
      );
      assert.deepEqual(ids(await store.query({ errorsOnly: true })), ["e3", "e4"]);
      assert.deepEqual(ids(await store.query({ limit: 2 })), ["e1", "e2"]);
      assert.equal((await store.query({ limit: 0 })).length, 5);

      // The SQL rendering must agree with the shared in-memory predicate on
      // every dimension above — same questions, same answers, two sources.
      const filters = [
        {},
        { profile: "work" },
        { route: "opus" },
        { account: "vault-a" },
        { model: "opus" },
        { errorsOnly: true } as const,
      ];
      for (const filter of filters) {
        assert.deepEqual(
          ids(await store.query(filter)),
          ids(seeds.filter((s) => matchTrafficFilter(s, filter))),
          `SQL disagrees with matchTrafficFilter on ${JSON.stringify(filter)}`,
        );
      }
    } finally {
      store.close();
    }
  });

  it("rolls up with core semantics over the uncapped set, not the list cap", async () => {
    const store = await tempStore("traffic-rollup-");
    try {
      for (let i = 0; i < 10; i += 1) {
        await store.append(
          toStoredExchange(
            entry({
              profile: i % 2 === 0 ? "work" : "home",
              route: "opus",
              status: i === 0 ? 429 : 200,
              request: { approxInputTokens: 10 },
            }),
          ),
        );
      }
      const all = await store.query({ limit: 0 });
      assert.deepEqual(await store.rollup({}, "profile"), rollupExchanges(all, "profile"));
      assert.deepEqual(await store.rollup({}, "route"), rollupExchanges(all, "route"));
      assert.deepEqual(await store.rollup({}, "day"), rollupExchanges(all, "day"));

      // A list cap must never shrink a total.
      assert.equal((await store.query({ limit: 3 })).length, 3);
      const rows = await store.rollup({}, "profile");
      assert.equal(rows.reduce((n, r) => n + r.requests, 0), 10);
      assert.equal(rows.find((r) => r.key === "work")?.requests, 5);
      assert.equal(rows.find((r) => r.key === "work")?.errors, 1);
    } finally {
      store.close();
    }
  });

  it("prunes aged rows and caps row count, keeping the newest", async () => {
    const store = await tempStore("traffic-retention-", { maxDays: 30, maxRows: 5 });
    try {
      const stale = "2020-01-01T00:00:00.000Z";
      for (let i = 0; i < 3; i += 1) {
        await store.append(toStoredExchange(entry({ ts: stale })));
      }
      // Prune fires every 100 appends: 3 stale + 97 fresh trips it exactly
      // once, on the final append, so the cap assertion sees its output.
      for (let i = 0; i < 97; i += 1) {
        await store.append(toStoredExchange(entry()));
      }
      const rows = await store.query({ limit: 0 });
      assert.ok(!rows.some((r) => r.ts === stale), "aged rows are pruned");
      assert.ok(rows.length <= 5, `row cap holds, got ${rows.length}`);
      const newest = rows.reduce((a, b) => (a.ts > b.ts ? a : b));
      assert.equal(newest.id, `t-${seq}`, "the newest exchange survives");
    } finally {
      store.close();
    }
  });

  it("treats 0 bounds as unbounded", async () => {
    const store = await tempStore("traffic-unbounded-", { maxDays: 0, maxRows: 0 });
    try {
      for (let i = 0; i < 100; i += 1) {
        await store.append(toStoredExchange(entry()));
      }
      assert.equal((await store.query({ limit: 0 })).length, 100);
    } finally {
      store.close();
    }
  });

  it("holds scalar facts only — no body, header, or token columns exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "traffic-redaction-"));
    const path = join(dir, "proxy-traffic.sqlite");
    const store = await openTrafficStore(path);
    try {
      await store.append(
        toStoredExchange(
          entry({
            reqBody: JSON.stringify({ key: "sk-ant-secret-xyz" }),
            resBody: JSON.stringify({ usage: { input_tokens: 7 } }),
          }),
        ),
      );
    } finally {
      store.close();
    }
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(path);
    try {
      const columns = (table: string) =>
        (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map(
          (c) => c.name,
        );
      assert.deepEqual(columns("exchanges"), [
        "id", "ts", "profile", "route", "account_id", "model", "upstream_model",
        "status", "ms", "req_tokens", "res_tokens", "error",
      ]);
      assert.deepEqual(columns("attempts"), ["exchange_id", "ord", "account_id", "status"]);
      const dump = db.prepare("SELECT * FROM exchanges").all();
      assert.ok(!JSON.stringify(dump).includes("sk-ant-secret-xyz"));
    } finally {
      db.close();
    }
  });
});
