// Tests for the reusable traffic kit: provider-agnostic byte mechanics.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  approxTokens,
  describeJsonShape,
  looksLikeSse,
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

describe("looksLikeSse", () => {
  it("reads only the head, so a JSON body quoting \"data:\" is not a stream", () => {
    assert.equal(looksLikeSse('{"error":{"message":"bad data: field"}}'), false);
    assert.equal(looksLikeSse('{"data":[{"id":"m1"}]}'), false);
    assert.equal(looksLikeSse('[{"note":"data: x"}]'), false);
    assert.equal(looksLikeSse("plain text mentioning data: here"), false);
    assert.equal(looksLikeSse(""), false);
  });

  it("accepts every SSE opening line", () => {
    assert.equal(looksLikeSse('data: {"type":"message_stop"}\n\n'), true);
    assert.equal(looksLikeSse('event: ping\ndata: {"a":1}\n\n'), true);
    assert.equal(looksLikeSse("id: 42\ndata: x\n\n"), true);
    assert.equal(looksLikeSse("retry: 3000\n\n"), true);
    assert.equal(looksLikeSse(": keep-alive\n\ndata: x\n\n"), true);
    // Blank lines and indentation before the first field (stubs, proxies).
    assert.equal(looksLikeSse('\n\n  data: {"a":1}\n'), true);
  });
});
