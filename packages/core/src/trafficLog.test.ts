import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_ROUTE_KEY,
  UNATTRIBUTED_PROFILE_KEY,
  matchTrafficFilter,
  rollupExchanges,
  rollupTotal,
  type StoredTrafficExchange,
} from "./index.js";

function exchange(overrides: Partial<StoredTrafficExchange> = {}): StoredTrafficExchange {
  return {
    id: "t1",
    ts: "2026-09-08T10:00:00.000Z",
    status: 200,
    ms: 100,
    ...overrides,
  };
}

describe("matchTrafficFilter", () => {
  const routed = exchange({
    profile: "work",
    route: "opus",
    accountId: "vault-a",
    model: "claude-opus-5",
    upstreamModel: "claude-opus-5",
  });
  it("matches everything on an empty filter", () => {
    assert.equal(matchTrafficFilter(routed, {}), true);
  });
  it("filters on profile, route, account, and model", () => {
    assert.equal(matchTrafficFilter(routed, { profile: "work" }), true);
    assert.equal(matchTrafficFilter(routed, { profile: "other" }), false);
    assert.equal(matchTrafficFilter(routed, { route: "opus" }), true);
    assert.equal(matchTrafficFilter(routed, { route: "sonnet" }), false);
    assert.equal(matchTrafficFilter(routed, { account: "vault-a" }), true);
    assert.equal(matchTrafficFilter(routed, { account: "vault-b" }), false);
    // Either side of a rewrite answers a model question.
    assert.equal(matchTrafficFilter({ ...routed, upstreamModel: "opus-plan" }, { model: "opus-plan" }), true);
    assert.equal(matchTrafficFilter(routed, { model: "claude-opus-5" }), true);
    assert.equal(matchTrafficFilter(routed, { model: "ghost" }), false);
  });
  it("bounds time with since-inclusive / until-exclusive", () => {
    assert.equal(matchTrafficFilter(routed, { since: "2026-09-08T10:00:00.000Z" }), true);
    assert.equal(matchTrafficFilter(routed, { since: "2026-09-08T10:00:00.001Z" }), false);
    assert.equal(matchTrafficFilter(routed, { until: "2026-09-08T10:00:00.000Z" }), false);
    assert.equal(matchTrafficFilter(routed, { until: "2026-09-09T00:00:00.000Z" }), true);
  });
  it("treats 4xx/5xx, client aborts, and error notes as errors", () => {
    assert.equal(matchTrafficFilter(exchange({ status: 429 }), { errorsOnly: true }), true);
    assert.equal(matchTrafficFilter(exchange({ status: 499 }), { errorsOnly: true }), true);
    assert.equal(matchTrafficFilter(exchange({ error: "boom" }), { errorsOnly: true }), true);
    assert.equal(matchTrafficFilter(exchange(), { errorsOnly: true }), false);
  });
});

describe("rollupExchanges", () => {
  const rows = [
    exchange({ id: "a", profile: "work", route: "opus", ms: 100, reqTokens: 10, resTokens: 5 }),
    exchange({ id: "b", profile: "work", route: "opus", ms: 200, status: 429, error: "busy" }),
    exchange({ id: "c", profile: "home", ms: 300, reqTokens: 7, resTokens: 3 }),
    exchange({ id: "d", ts: "2026-09-07T10:00:00.000Z", ms: 400 }),
  ];
  it("rolls up by profile with error rates and percentiles", () => {
    const byProfile = rollupExchanges(rows, "profile");
    assert.deepEqual(
      byProfile.map((r) => [r.key, r.requests, r.errors, r.errorRate]),
      [
        [UNATTRIBUTED_PROFILE_KEY, 1, 0, 0],
        ["home", 1, 0, 0],
        ["work", 2, 1, 0.5],
      ],
    );
    const work = byProfile.find((r) => r.key === "work");
    assert.equal(work?.p50Ms, 100);
    assert.equal(work?.p95Ms, 200);
    // Token-blind rows add nothing instead of poisoning the sum.
    assert.equal(work?.reqTokens, 10);
    assert.equal(work?.resTokens, 5);
  });
  it("rolls up by route and by day", () => {
    assert.deepEqual(
      rollupExchanges(rows, "route").map((r) => [r.key, r.requests]),
      [
        [BASE_ROUTE_KEY, 2],
        ["opus", 2],
      ],
    );
    assert.deepEqual(
      rollupExchanges(rows, "day").map((r) => [r.key, r.requests]),
      [
        ["2026-09-07", 1],
        ["2026-09-08", 3],
      ],
    );
  });
  it("returns no rows for no entries", () => {
    assert.deepEqual(rollupExchanges([], "profile"), []);
  });
  it("rolls the whole selection into one totals row", () => {
    // Percentiles come from the full sample, not folded from group rows.
    const total = rollupTotal(rows);
    assert.equal(total.key, "total");
    assert.equal(total.requests, 4);
    assert.equal(total.errors, 1);
    assert.equal(total.errorRate, 0.25);
    assert.equal(total.p50Ms, 200);
    assert.equal(total.p95Ms, 400);
    assert.equal(total.reqTokens, 17);
    assert.equal(total.resTokens, 8);
    assert.deepEqual(rollupTotal([]), {
      key: "total",
      requests: 0,
      errors: 0,
      errorRate: 0,
      p50Ms: 0,
      p95Ms: 0,
      reqTokens: 0,
      resTokens: 0,
    });
  });
});
