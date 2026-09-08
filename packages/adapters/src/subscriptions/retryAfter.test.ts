import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_RETRY_AFTER_MS, parseRetryAfterMs } from "./retryAfter.js";

describe("parseRetryAfterMs", () => {
  it("reads delta-seconds", () => {
    assert.equal(parseRetryAfterMs("30"), 30_000);
    assert.equal(parseRetryAfterMs(" 30 "), 30_000);
    assert.equal(parseRetryAfterMs("0"), 0);
  });

  it("reads an HTTP-date and never goes negative", () => {
    const now = 1_700_000_000_000;
    const at = new Date(now + 45_000).toUTCString();
    assert.equal(parseRetryAfterMs(at, { now: () => now }), 45_000);
    const past = new Date(now - 60_000).toUTCString();
    assert.equal(parseRetryAfterMs(past, { now: () => now }), 0);
  });

  it("clamps an absurd delay: a day-long cooldown looks permanently broken", () => {
    assert.equal(parseRetryAfterMs("86400"), MAX_RETRY_AFTER_MS);
    assert.equal(parseRetryAfterMs("999999999"), MAX_RETRY_AFTER_MS);
    assert.equal(parseRetryAfterMs("60", { max: 10_000 }), 10_000);
  });

  it("is undefined for absent or malformed values — the caller owns the default", () => {
    assert.equal(parseRetryAfterMs(undefined), undefined);
    assert.equal(parseRetryAfterMs(null), undefined);
    assert.equal(parseRetryAfterMs(""), undefined);
    assert.equal(parseRetryAfterMs("   "), undefined);
    assert.equal(parseRetryAfterMs("soon"), undefined);
    // The old proxy copy used parseInt and called this twelve seconds while the
    // usage client called it unparseable. One reading now, and it is "no".
    assert.equal(parseRetryAfterMs("12abc"), undefined);
  });
});
