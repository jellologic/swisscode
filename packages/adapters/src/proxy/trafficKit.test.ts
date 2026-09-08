// Tests for the reusable traffic kit: provider-agnostic byte mechanics.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  approxTokens,
  describeJsonShape,
  safeJsonParse,
  splitSsePayloads,
  tallyNames,
  truncateText,
} from "./trafficKit.js";

describe("trafficKit", () => {
  it("splits SSE payloads and skips non-data lines", () => {
    assert.deepEqual(
      splitSsePayloads('event: ping\ndata: {"a":1}\n\ndata: [DONE]\n: comment\n'),
      ['{"a":1}', "[DONE]"],
    );
  });

  it("parses JSON safely", () => {
    assert.deepEqual(safeJsonParse('{"a":1}'), { a: 1 });
    assert.equal(safeJsonParse("{nope"), undefined);
  });

  it("truncates and approximates", () => {
    assert.deepEqual(truncateText("abcdef", 3), { text: "abc", truncated: true });
    assert.deepEqual(truncateText("ab", 3), { text: "ab", truncated: false });
    assert.equal(approxTokens(400), 100);
  });

  it("tallies in frequency order", () => {
    assert.deepEqual(tallyNames(["b", "a", "b"]), [
      { type: "b", count: 2 },
      { type: "a", count: 1 },
    ]);
  });

  it("describes JSON shapes", () => {
    assert.equal(describeJsonShape({ data: [1, 2] }), "object with a data array of 2");
    assert.equal(describeJsonShape([1]), "array of 1");
  });
});
