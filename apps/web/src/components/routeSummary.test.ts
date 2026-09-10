// Pure mapping behind the Model overrides editor: row encoding round-trips,
// destination list shape, and the effective-mapping summary. No React, no
// stores — only core's route renderer.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MODEL_PRICES, type ModelRouteLabels } from "@swisscode/core";
import {
  SUBSCRIPTION_KNOWN_MODELS,
  destinationOptions,
  effectiveMapping,
  routeToRow,
  rowToRoute,
} from "./routeSummary.js";

const labels: ModelRouteLabels = {
  subscriptionAccountLabel: (id) => (id === "work" ? "Work" : undefined),
  providerAccountLabel: (providerId, id) =>
    providerId === "openrouter" && id === "main" ? "Main key" : undefined,
  providerDisplayName: (providerId) =>
    providerId === "openrouter" ? "OpenRouter" : undefined,
};

describe("routeToRow / rowToRoute", () => {
  it("round-trips a pinned subscription route", () => {
    const row = routeToRow({ match: "claude-opus-5", kind: "subscription", subscriptionAccountId: "work" });
    assert.equal(row.dest, "subscription:work");
    assert.deepEqual(rowToRoute(row), {
      match: "claude-opus-5",
      kind: "subscription",
      subscriptionAccountId: "work",
    });
  });

  it("round-trips the profile base (absent account id)", () => {
    const row = routeToRow({ match: "claude-sonnet-4-5", kind: "subscription" });
    assert.equal(row.dest, "subscription:");
    assert.deepEqual(rowToRoute(row), { match: "claude-sonnet-4-5", kind: "subscription" });
  });

  it("round-trips a key-account route and splits on the first colon", () => {
    const row = routeToRow({
      match: "anthropic/claude-opus-4",
      kind: "providerAccount",
      providerId: "openrouter",
      providerAccountId: "main",
      upstreamModel: "anthropic/claude-opus-4",
    });
    assert.equal(row.dest, "key:openrouter:main");
    assert.deepEqual(rowToRoute(row), {
      match: "anthropic/claude-opus-4",
      kind: "providerAccount",
      providerId: "openrouter",
      providerAccountId: "main",
      upstreamModel: "anthropic/claude-opus-4",
    });
  });

  it("omits a blank upstream model (passthrough, never persisted)", () => {
    assert.deepEqual(rowToRoute({ match: "x", dest: "subscription:", upstreamModel: "  " }), {
      match: "x",
      kind: "subscription",
    });
    assert.equal(routeToRow({ match: "x", kind: "subscription" }).upstreamModel, "");
  });

  it("trims the match", () => {
    assert.equal(rowToRoute({ match: "  claude-opus-5 ", dest: "subscription:", upstreamModel: "" }).match, "claude-opus-5");
  });
});

describe("destinationOptions", () => {
  const options = destinationOptions(
    [{ id: "work", label: "Work" }],
    [{ id: "main", label: "Main key", providerId: "openrouter" }],
    (pid) => (pid === "openrouter" ? "OpenRouter" : undefined),
  );

  it("lists the profile base first, then vault, then keys", () => {
    assert.deepEqual(
      options.map((o) => o.value),
      ["subscription:", "subscription:work", "key:openrouter:main"],
    );
  });

  it("falls back to the provider id when no display name is known", () => {
    const [, only] = destinationOptions(
      [],
      [{ id: "a", label: "A", providerId: "mystery" }],
      () => undefined,
    );
    assert.equal(only?.kind, "mystery");
  });
});

describe("effectiveMapping", () => {
  it("numbers rows in order and ends with the fallback", () => {
    const rows = effectiveMapping(
      [
        { match: "claude-opus-5", dest: "subscription:work", upstreamModel: "" },
        { match: "anthropic/claude-opus-4", dest: "key:openrouter:main", upstreamModel: "" },
      ],
      labels,
      "Everything else → OpenRouter via Main key (provider default)",
    );
    assert.equal(rows.length, 3);
    assert.equal(rows[0]?.kind, "route");
    assert.ok(rows[0]?.sentence.startsWith("Row 1:"));
    assert.ok(rows[1]?.sentence.startsWith("Row 2:"));
    assert.deepEqual(rows[2], {
      sentence: "Everything else → OpenRouter via Main key (provider default)",
      kind: "fallback",
    });
  });

  it("flags duplicate matches as never-firing (first-row-wins)", () => {
    const rows = effectiveMapping(
      [
        { match: "claude-opus-5", dest: "subscription:work", upstreamModel: "" },
        { match: " claude-opus-5 ", dest: "key:openrouter:main", upstreamModel: "" },
      ],
      labels,
      "fallback",
    );
    assert.equal(rows[0]?.kind, "route");
    assert.equal(rows[1]?.kind, "duplicate");
  });

  it("renders a lone fallback when there are no overrides", () => {
    assert.deepEqual(effectiveMapping([], labels, "All models → default backend"), [
      { sentence: "All models → default backend", kind: "fallback" },
    ]);
  });
});

describe("SUBSCRIPTION_KNOWN_MODELS", () => {
  it("covers the price table and stays deduped", () => {
    for (const id of Object.keys(MODEL_PRICES)) {
      assert.ok(SUBSCRIPTION_KNOWN_MODELS.includes(id), `missing ${id}`);
    }
    assert.equal(new Set(SUBSCRIPTION_KNOWN_MODELS).size, SUBSCRIPTION_KNOWN_MODELS.length);
  });
});
