import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TrafficConversation } from "@swisscode/adapters";

import {
  findThread,
  keepLastGood,
  mergeEntryBodies,
  threadEntryIds,
  threadTotals,
  type ProxyTrafficItem,
  type ThreadView,
} from "./threadView.js";

function item(id: string | undefined, extra: Partial<ProxyTrafficItem> = {}): ProxyTrafficItem {
  return {
    ...(id === undefined ? {} : { id }),
    ts: "2026-01-01T00:00:00.000Z",
    method: "POST",
    path: "/v1/messages",
    status: 200,
    ms: 12,
    accountId: "ada",
    reqBytes: 10,
    resBytes: 20,
    attempts: [],
    summary: { explanation: [] },
    ...extra,
  } as ProxyTrafficItem;
}

function conversation(indexes: number[]): TrafficConversation {
  return {
    id: "sess-1",
    indexes,
    turns: indexes.length,
    statuses: [200],
    profiles: [],
    models: [],
    tools: [],
    spanMs: 0,
    upstreamMs: 0,
    agentLaunches: [],
    policyChecks: [],
  } as unknown as TrafficConversation;
}

describe("findThread", () => {
  it("is null instead of throwing when the thread left the buffer", () => {
    assert.equal(findThread([conversation([0])], "gone"), null);
    assert.equal(findThread([], "sess-1"), null);
    assert.equal(findThread([conversation([0])], "sess-1")?.id, "sess-1");
  });
});

describe("threadEntryIds", () => {
  it("asks only for the entries this thread renders", () => {
    const entries = [item("a"), item("b"), item("c")];
    assert.deepEqual(threadEntryIds(entries, conversation([0, 2])), ["a", "c"]);
  });

  it("skips duplicates and id-less legacy entries", () => {
    const entries = [item("a"), item(undefined), item("a")];
    assert.deepEqual(threadEntryIds(entries, conversation([0, 1, 2])), ["a"]);
  });
});

describe("mergeEntryBodies", () => {
  it("overlays bodies without moving the indexes the conversation points at", () => {
    const entries = [item("a"), item("b")];
    const merged = mergeEntryBodies(entries, [item("b", { reqBody: "{...}" })]);
    assert.equal(merged[0]?.reqBody, undefined);
    assert.equal(merged[1]?.reqBody, "{...}");
    assert.equal(merged.length, 2);
  });

  it("keeps the body-less copy for entries that vanished between calls", () => {
    const entries = [item("a")];
    assert.deepEqual(mergeEntryBodies(entries, []), entries);
  });
});

describe("threadTotals", () => {
  const withUsage = (input: number, output: number, cached: number): ProxyTrafficItem =>
    item("x", {
      summary: {
        explanation: [],
        request: { model: "claude-sonnet", toolNames: ["Bash"] },
        response: {
          kind: "sse-stream",
          totalInputTokens: input,
          outputTokens: output,
          cacheReadInputTokens: cached,
          toolUses: ["Read"],
        },
      },
    } as unknown as Partial<ProxyTrafficItem>);

  it("re-derives the header from the entries whose bodies arrived", () => {
    const entries = [withUsage(100, 10, 40), withUsage(200, 20, 60)];
    const totals = threadTotals(entries, conversation([0, 1]));
    assert.equal(totals.totalInputTokens, 300);
    assert.equal(totals.totalOutputTokens, 30);
    assert.equal(totals.cacheReadInputTokens, 100);
    assert.deepEqual(totals.models, ["claude-sonnet"]);
    assert.deepEqual(totals.tools, ["Bash", "Read"]);
  });

  it("falls back to the grouping when no body reported tokens", () => {
    const conv = { ...conversation([0]), totalInputTokens: 7, models: ["m"], tools: ["T"] };
    const totals = threadTotals([item("x")], conv as never);
    assert.equal(totals.totalInputTokens, 7);
    assert.deepEqual(totals.models, ["m"]);
    assert.deepEqual(totals.tools, ["T"]);
  });
});

describe("keepLastGood", () => {
  const good: ThreadView = { running: true, conversation: conversation([0]), entries: [item("a")] };

  it("takes fresh data whenever the thread is there", () => {
    const next: ThreadView = { ...good, entries: [item("a"), item("b")] };
    assert.equal(keepLastGood(good, next), next);
  });

  it("keeps the page on screen when the proxy could not be reached", () => {
    const next: ThreadView = { running: false, conversation: null, entries: [] };
    const folded = keepLastGood(good, next);
    assert.equal(folded.conversation, good.conversation);
    assert.equal(folded.running, false);
  });

  it("accepts the eviction when the proxy answered without the thread", () => {
    const next: ThreadView = { running: true, conversation: null, entries: [] };
    assert.equal(keepLastGood(good, next), next);
  });

  it("has nothing to keep on a first load that found nothing", () => {
    const next: ThreadView = { running: false, conversation: null, entries: [] };
    assert.equal(keepLastGood(null, next), next);
  });
});
