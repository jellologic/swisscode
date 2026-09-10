import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ROTATION_HYSTERESIS_PTS,
  ROTATION_MIN_RESET_EDGE_MS,
  ROTATION_UNKNOWN_UTIL,
  rankAccountsForRotation,
  shouldRotate,
} from "./rotation.js";
import type { RotationInput } from "./rotation.js";

const NOW = 1_786_000_000_000;
const MIN = 60_000;
const POLL_MS = 5 * MIN;

function input(over: Partial<RotationInput> & { accountId: string }): RotationInput {
  return {
    fiveHourUtil: undefined,
    sevenDayUtil: undefined,
    stale: false,
    cooling: false,
    dead: false,
    ...over,
  };
}

describe("rankAccountsForRotation", () => {
  it("reset-soonest orders by soonest reset, then utilization, then id", () => {
    const ranked = rankAccountsForRotation(
      [
        input({ accountId: "b", fiveHourUtil: 10, fiveHourResetMs: NOW + 60 * MIN }),
        input({ accountId: "a", fiveHourUtil: 90, fiveHourResetMs: NOW + 5 * MIN }),
        input({ accountId: "c", fiveHourUtil: 5, fiveHourResetMs: NOW + 60 * MIN }),
      ],
      "reset-soonest",
      NOW,
    );
    // a resets soonest despite higher use; b/c tie on reset, lower use first.
    assert.deepEqual(ranked.map((r) => r.accountId), ["a", "c", "b"]);
  });

  it("least-used orders by utilization first", () => {
    const ranked = rankAccountsForRotation(
      [
        input({ accountId: "b", fiveHourUtil: 10, fiveHourResetMs: NOW + 60 * MIN }),
        input({ accountId: "a", fiveHourUtil: 90, fiveHourResetMs: NOW + 5 * MIN }),
      ],
      "least-used",
      NOW,
    );
    assert.deepEqual(ranked.map((r) => r.accountId), ["b", "a"]);
  });

  it("balances 5h against 7d via the max, and an exhausted-but-soonest account sinks", () => {
    const ranked = rankAccountsForRotation(
      [
        input({ accountId: "hot", fiveHourUtil: 99, fiveHourResetMs: NOW + MIN }),
        input({ accountId: "warm", fiveHourUtil: 20, sevenDayUtil: 88, sevenDayResetMs: NOW + 60 * MIN }),
        input({ accountId: "cool", fiveHourUtil: 20, sevenDayUtil: 30, sevenDayResetMs: NOW + 90 * MIN }),
      ],
      "reset-soonest",
      NOW,
    );
    assert.equal(ranked[0]?.accountId, "warm");
    assert.equal(ranked[0]?.effectiveUtil, 88);
    assert.equal(ranked[1]?.accountId, "cool");
    assert.equal(ranked[ranked.length - 1]?.accountId, "hot");
    assert.equal(ranked[ranked.length - 1]?.tier, "excluded");
  });

  it("treats null utilization as unlimited (0), not as exhausted", () => {
    const ranked = rankAccountsForRotation(
      [input({ accountId: "free", fiveHourUtil: null, sevenDayUtil: null })],
      "least-used",
      NOW,
    );
    assert.equal(ranked[0]?.tier, "usable");
    assert.equal(ranked[0]?.effectiveUtil, 0);
  });

  it("ranks fully-unknown utilization mid-pack without inventing a reset", () => {
    const ranked = rankAccountsForRotation(
      [
        input({ accountId: "known-good", fiveHourUtil: 10, fiveHourResetMs: NOW + 60 * MIN }),
        input({ accountId: "mystery" }),
        input({ accountId: "known-bad", fiveHourUtil: 80, fiveHourResetMs: NOW + 60 * MIN }),
      ],
      "least-used",
      NOW,
    );
    assert.deepEqual(ranked.map((r) => r.accountId), ["known-good", "mystery", "known-bad"]);
    assert.equal(ranked[1]?.effectiveUtil, ROTATION_UNKNOWN_UTIL);
    assert.equal(ranked[1]?.soonestResetMs, Number.POSITIVE_INFINITY);
  });

  it("demotes stale and cooling accounts below usable ones", () => {
    const ranked = rankAccountsForRotation(
      [
        input({ accountId: "stale", fiveHourUtil: 5, fiveHourResetMs: NOW + MIN, stale: true }),
        input({ accountId: "cooling", fiveHourUtil: 5, fiveHourResetMs: NOW + MIN, cooling: true }),
        input({ accountId: "fresh", fiveHourUtil: 50, fiveHourResetMs: NOW + 60 * MIN }),
      ],
      "reset-soonest",
      NOW,
    );
    assert.equal(ranked[0]?.accountId, "fresh");
    assert.deepEqual(ranked.slice(1).map((r) => r.tier), ["degraded", "degraded"]);
  });

  it("excludes dead credentials however healthy their numbers look", () => {
    const ranked = rankAccountsForRotation(
      [
        input({ accountId: "dead", fiveHourUtil: 1, fiveHourResetMs: NOW + MIN, dead: true }),
        input({ accountId: "alive", fiveHourUtil: 90, fiveHourResetMs: NOW + 60 * MIN }),
      ],
      "reset-soonest",
      NOW,
    );
    assert.equal(ranked[0]?.accountId, "alive");
    assert.equal(ranked[1]?.tier, "excluded");
  });

  it("clamps an already-passed reset to now so fresh quota sorts first", () => {
    const ranked = rankAccountsForRotation(
      [
        input({ accountId: "later", fiveHourUtil: 10, fiveHourResetMs: NOW + 60 * MIN }),
        input({ accountId: "just-reset", fiveHourUtil: 95, fiveHourResetMs: NOW - MIN }),
      ],
      "reset-soonest",
      NOW,
    );
    // just-reset is still usable (95 < 98) and its reset passed: it sorts first.
    assert.equal(ranked[0]?.accountId, "just-reset");
    assert.equal(ranked[0]?.soonestResetMs, NOW);
  });

  it("breaks full ties by id, matching the vault sort", () => {
    const ranked = rankAccountsForRotation(
      [
        input({ accountId: "b", fiveHourUtil: 10, fiveHourResetMs: NOW + 60 * MIN }),
        input({ accountId: "a", fiveHourUtil: 10, fiveHourResetMs: NOW + 60 * MIN }),
      ],
      "reset-soonest",
      NOW,
    );
    assert.deepEqual(ranked.map((r) => r.accountId), ["a", "b"]);
  });
});

describe("shouldRotate", () => {
  const ranked = () =>
    rankAccountsForRotation(
      [
        input({ accountId: "a", fiveHourUtil: 80, fiveHourResetMs: NOW + 120 * MIN }),
        input({ accountId: "b", fiveHourUtil: 20, fiveHourResetMs: NOW + 100 * MIN }),
      ],
      "reset-soonest",
      NOW,
    );

  it("stays when already on the winner", () => {
    assert.equal(shouldRotate("b", ranked(), null, NOW, POLL_MS).to, null);
  });

  it("switches at once on a decisive utilization gap", () => {
    // b at 20 vs a at 80: gap (60) exceeds the hysteresis band.
    const res = shouldRotate("a", ranked(), NOW, NOW, POLL_MS);
    assert.equal(res.to, "b");
  });

  it("stays inside the noise band when the reset edge is small", () => {
    const close = rankAccountsForRotation(
      [
        input({ accountId: "a", fiveHourUtil: 30, fiveHourResetMs: NOW + 120 * MIN }),
        input({ accountId: "b", fiveHourUtil: 32, fiveHourResetMs: NOW + 112 * MIN }),
      ],
      "reset-soonest",
      NOW,
    );
    // Winner: b resets 8min sooner but is 2pts MORE used — inside every band.
    assert.equal(shouldRotate("a", close, null, NOW, POLL_MS).to, null);
  });

  it("switches on a big reset edge inside the band, but only after the min-hold", () => {
    const band = rankAccountsForRotation(
      [
        input({ accountId: "a", fiveHourUtil: 30, fiveHourResetMs: NOW + 120 * MIN }),
        input({ accountId: "b", fiveHourUtil: 32, fiveHourResetMs: NOW + 60 * MIN }),
      ],
      "reset-soonest",
      NOW,
    );
    assert.ok(band[0]?.accountId === "b");
    // Switched just now: hold.
    assert.equal(shouldRotate("a", band, NOW, NOW, POLL_MS).to, null);
    // A full cycle later: switch.
    const res = shouldRotate("a", band, NOW - POLL_MS, NOW, POLL_MS);
    assert.equal(res.to, "b");
    assert.match(res.reason, /sooner/);
  });

  it("abandons an excluded current account for any selectable winner", () => {
    const r = rankAccountsForRotation(
      [
        input({ accountId: "a", fiveHourUtil: 99, fiveHourResetMs: NOW + MIN }),
        input({ accountId: "b", fiveHourUtil: 50, fiveHourResetMs: NOW + 60 * MIN }),
      ],
      "reset-soonest",
      NOW,
    );
    assert.equal(shouldRotate("a", r, NOW, NOW, POLL_MS).to, "b");
  });

  it("reports no usable account when everything is excluded", () => {
    const r = rankAccountsForRotation(
      [
        input({ accountId: "a", fiveHourUtil: 99 }),
        input({ accountId: "b", fiveHourUtil: 50, dead: true }),
      ],
      "reset-soonest",
      NOW,
    );
    const res = shouldRotate("a", r, null, NOW, POLL_MS);
    assert.equal(res.to, null);
    assert.match(res.reason, /no usable/);
  });

  it("moves to the winner when the current account is gone", () => {
    assert.equal(shouldRotate("deleted", ranked(), null, NOW, POLL_MS).to, "b");
  });

  it("moves from nothing to the winner on first run", () => {
    assert.equal(shouldRotate(null, ranked(), null, NOW, POLL_MS).to, "b");
  });

  it("uses the exported hysteresis constant, not a magic number", () => {
    assert.equal(ROTATION_HYSTERESIS_PTS, 10);
    assert.equal(ROTATION_MIN_RESET_EDGE_MS, 15 * 60 * 1000);
  });
});
