import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_ROUTE_KEY,
  estimateExchangeSpend,
  formatSpend,
  priceForModel,
  spendRollup,
  spendTotal,
  suggestInsights,
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

describe("priceForModel", () => {
  it("prices exact ids and OpenRouter-style prefixed ids", () => {
    assert.deepEqual(priceForModel("claude-sonnet-4-5"), { inputPerMTok: 3, outputPerMTok: 15 });
    assert.deepEqual(priceForModel("anthropic/claude-sonnet-4-5"), {
      inputPerMTok: 3,
      outputPerMTok: 15,
    });
  });
  it("returns undefined for unknown, blank, and missing models", () => {
    assert.equal(priceForModel("claude-fictional-9"), undefined);
    assert.equal(priceForModel("  "), undefined);
    assert.equal(priceForModel(undefined), undefined);
  });
});

describe("estimateExchangeSpend", () => {
  it("prices the upstream model first, tokens at per-1M rates", () => {
    // 1M in + 1M out of Sonnet 4.5 = $3 + $15.
    assert.equal(
      estimateExchangeSpend(
        exchange({ model: "claude-opus-5", upstreamModel: "claude-sonnet-4-5", reqTokens: 1_000_000, resTokens: 1_000_000 }),
      ),
      18,
    );
  });
  it("falls back to the requested model without a rewrite", () => {
    assert.equal(
      estimateExchangeSpend(exchange({ model: "claude-haiku-4-5", reqTokens: 1_000_000, resTokens: 0 })),
      1,
    );
  });
  it("leaves token-blind and unknown-model rows unpriced, never $0 by default", () => {
    assert.equal(estimateExchangeSpend(exchange({ model: "claude-sonnet-4-5" })), undefined);
    assert.equal(
      estimateExchangeSpend(exchange({ model: "claude-fictional-9", reqTokens: 100, resTokens: 50 })),
      undefined,
    );
    // Zero-token rows are priced ($0 is a figure, not a gap).
    assert.equal(
      estimateExchangeSpend(exchange({ model: "claude-sonnet-4-5", reqTokens: 0, resTokens: 0 })),
      0,
    );
  });
});

describe("spendRollup / spendTotal", () => {
  const rows = [
    exchange({ id: "a", route: "opus", model: "claude-sonnet-4-5", reqTokens: 1_000_000, resTokens: 0 }),
    exchange({ id: "b", route: "opus", model: "claude-fictional-9", reqTokens: 10, resTokens: 5 }),
    exchange({ id: "c", model: "claude-haiku-4-5", reqTokens: 1_000_000, resTokens: 0 }),
    exchange({ id: "d", ms: 400 }),
  ];
  it("groups by route with priced/unpriced counts", () => {
    const byRoute = spendRollup(rows, "route");
    assert.deepEqual(
      byRoute.map((r) => [r.key, r.requests, r.estSpendUsd, r.pricedRequests, r.unpricedRequests]),
      [
        [BASE_ROUTE_KEY, 2, 1, 1, 0],
        ["opus", 2, 3, 1, 1],
      ],
    );
  });
  it("totals the whole selection in one row", () => {
    assert.deepEqual(spendTotal(rows), {
      key: "total",
      requests: 4,
      estSpendUsd: 4,
      pricedRequests: 2,
      unpricedRequests: 1,
    });
  });
  it("returns an empty total for no entries", () => {
    assert.deepEqual(spendTotal([]), {
      key: "total",
      requests: 0,
      estSpendUsd: 0,
      pricedRequests: 0,
      unpricedRequests: 0,
    });
  });
});

describe("suggestInsights", () => {
  it("names the top-spend route, dead routes, and flaky routes", () => {
    const tips = suggestInsights(
      [
        { key: "opus", requests: 10, errors: 0, errorRate: 0, p50Ms: 1, p95Ms: 2, reqTokens: 1_000_000, resTokens: 0 },
        { key: "base", requests: 2, errors: 2, errorRate: 1, p50Ms: 1, p95Ms: 2, reqTokens: 0, resTokens: 0 },
      ],
      { opus: 3, base: 0 },
      { configuredRoutes: ["opus", "sonnet"], windowLabel: "this week" },
    );
    assert.ok(tips.some((t) => t.includes("`opus` burned ≈$3.00") && t.includes("this week")));
    assert.ok(tips.some((t) => t.includes("`sonnet` saw no traffic")));
    assert.ok(tips.some((t) => t.includes("`base` errored 2 of 2")));
  });
  it("flags unpriced usage and stays silent on empty input", () => {
    const tips = suggestInsights(
      [{ key: "opus", requests: 1, errors: 0, errorRate: 0, p50Ms: 1, p95Ms: 2, reqTokens: 10, resTokens: 5 }],
      {},
    );
    assert.ok(tips.some((t) => t.includes("couldn't be priced")));
    assert.deepEqual(suggestInsights([], {}), []);
  });
  it("keeps small figures readable", () => {
    assert.equal(formatSpend(18), "$18.00");
    assert.equal(formatSpend(0.0042), "$0.0042");
  });
});
