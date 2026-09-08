import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TrafficParser } from "@swisscode/core";
import type { ProxyTrafficEntry } from "./server.js";
import { groupTrafficConversations, summarizeTrafficEntry } from "./trafficSummary.js";

function base(over: Partial<ProxyTrafficEntry> = {}): ProxyTrafficEntry {
  return {
    ts: new Date(0).toISOString(),
    method: "POST",
    path: "/v1/messages",
    status: 200,
    ms: 2500,
    accountId: "main",
    reqBytes: 100,
    resBytes: 100,
    attempts: [{ accountId: "main", status: 200 }],
    ...over,
  };
}

const SSE_FULL = [
  'data: {"type":"message_start","message":{"id":"m1","model":"claude-sonnet-4-5","usage":{"input_tokens":1200,"output_tokens":0}}}',
  "",
  'data: {"type":"content_block_start","index":0}',
  "",
  'data: {"type":"content_block_delta","index":0,"delta":{"text":"hi"}}',
  "",
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}',
  "",
  'data: {"type":"message_stop"}',
  "",
].join("\n");

describe("summarizeTrafficEntry", () => {
  it("explains a full SSE round trip with usage", () => {
    const entry = base({
      reqBody: JSON.stringify({
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "hi" }],
        system: "be brief",
        tools: [{ name: "Bash" }, { name: "Read" }],
        max_tokens: 1024,
        stream: true,
      }),
      resBody: SSE_FULL,
    });
    const summary = summarizeTrafficEntry(entry);
    assert.equal(summary.request?.model, "claude-sonnet-4-5");
    assert.equal(summary.request?.messageCount, 1);
    assert.equal(summary.request?.toolCount, 2);
    assert.deepEqual(summary.request?.toolNames, ["Bash", "Read"]);
    assert.equal(summary.response?.kind, "sse-stream");
    assert.equal(summary.response?.model, "claude-sonnet-4-5");
    assert.equal(summary.response?.inputTokens, 1200);
    assert.equal(summary.response?.outputTokens, 12);
    assert.equal(summary.response?.stopReason, "end_turn");
    assert.equal(summary.response?.complete, true);
    const text = summary.explanation.join("\n");
    assert.ok(text.includes("claude-sonnet-4-5"));
    assert.ok(text.includes("“main”"));
    assert.ok(text.includes("2500ms"));
    assert.ok(text.includes("1,200 in"));
  });

  it("names the launching profile in the explanation", () => {
    const summary = summarizeTrafficEntry(base({ profile: "work" }));
    assert.ok(summary.explanation.some((l) => l.includes("for profile “work”")));
  });

  it("excerpts request messages and system prompts", () => {
    const messages = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          { type: "tool_use", name: "Bash" },
        ],
      },
      { role: "user", content: [{ type: "tool_result", content: "ok" }, { type: "image" }] },
    ];
    const entry = base({
      reqBody: JSON.stringify({ model: "m", messages, system: "be brief" }),
    });
    const summary = summarizeTrafficEntry(entry);
    assert.deepEqual(
      summary.request?.messages?.map((m) => [m.role, m.preview]),
      [
        ["user", "hello"],
        ["assistant", "checking\n[tool Bash]"],
        ["user", "[tool result: ok]\n[image]"],
      ],
    );
    assert.equal(summary.request?.systemPreview, "be brief");

    const many = Array.from({ length: 10 }, (_, i) => ({ role: "user", content: `m${i}` }));
    const capped = summarizeTrafficEntry(base({ reqBody: JSON.stringify({ messages: many }) }));
    assert.equal(capped.request?.messages?.length, 8);
    assert.equal(capped.request?.messagesTruncated, true);
  });

  it("concatenates streamed reply text and tool uses", () => {
    const resBody = [
      'data: {"type":"message_start","message":{"model":"m"}}',
      "",
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"Read"}}',
      "",
      'data: {"type":"content_block_delta","index":0,"delta":{"text":"Hello "}}',
      "",
      'data: {"type":"content_block_delta","index":0,"delta":{"text":"world"}}',
      "",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    const summary = summarizeTrafficEntry(base({ resBody }));
    assert.equal(summary.response?.textPreview, "Hello world");
    assert.deepEqual(summary.response?.toolUses, ["Read"]);

    const long = summarizeTrafficEntry(
      base({ resBody: `data: {"type":"content_block_delta","delta":{"text":${JSON.stringify("x".repeat(3000))}}}\n\n` }),
    );
    assert.equal(long.response?.textPreview?.length, 2000);
    assert.equal(long.response?.textTruncated, true);
  });

  it("reports cached prompt tokens in usage", () => {
    const resBody = [
      'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":34,"cache_creation_input_tokens":100,"cache_read_input_tokens":57180,"output_tokens":0}}}',
      "",
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":850}}',
      "",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    const summary = summarizeTrafficEntry(base({ resBody }));
    assert.equal(summary.response?.inputTokens, 34);
    assert.equal(summary.response?.cacheReadInputTokens, 57180);
    assert.equal(summary.response?.totalInputTokens, 57314);
    assert.ok(
      summary.explanation.some((l) => l.includes("57,314 in (57,280 cached) / 850 out")),
      JSON.stringify(summary.explanation),
    );
  });

  it("assembles streamed tool calls with input", () => {
    const resBody = [
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Bash"}}',
      "",
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}',
      "",
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \\"ls\\"}"}}',
      "",
      'data: {"type":"message_stop"}',
      "",
    ].join("\n");
    const summary = summarizeTrafficEntry(base({ resBody }));
    assert.deepEqual(summary.response?.toolCalls, [
      {
        name: "Bash",
        id: "t1",
        input: '{"command": "ls"}',
        inputTruncated: false,
        summary: "$ ls",
      },
    ]);
    assert.ok(summary.explanation.some((l) => l.includes("Plus 1 tool call: Bash.")));
  });

  it("keeps expandable full message text", () => {
    const long = "y".repeat(900);
    const summary = summarizeTrafficEntry(
      base({ reqBody: JSON.stringify({ model: "m", messages: [{ role: "user", content: long }] }) }),
    );
    const msg = summary.request?.messages?.[0];
    assert.equal(msg?.preview.length, 300);
    assert.equal(msg?.truncated, true);
    assert.equal(msg?.full?.length, 900);
    assert.equal(msg?.fullTruncated, false);
  });

  it("reads reply text from non-streamed JSON messages", () => {
    const entry = base({
      resBody: JSON.stringify({
        type: "message",
        model: "m",
        content: [{ type: "text", text: "done" }, { type: "tool_use", name: "Bash" }],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    });
    const summary = summarizeTrafficEntry(entry);
    assert.ok((summary.response?.textPreview ?? "").includes("done"));
    assert.deepEqual(summary.response?.toolUses, ["Bash"]);
  });

  it("flags a truncated stream with missing tail", () => {
    const entry = base({
      resBody: 'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":5}}}\n\n',
      resBodyTruncated: true,
      resBytes: 50000,
    });
    const summary = summarizeTrafficEntry(entry);
    assert.equal(summary.response?.kind, "sse-stream");
    assert.equal(summary.response?.complete, false);
    assert.ok(summary.explanation.some((l) => l.includes("Only the start of the stream was kept")));
  });

  it("describes failover across accounts", () => {
    const entry = base({
      attempts: [
        { accountId: "aaa", status: 429 },
        { accountId: "main", status: 200 },
      ],
    });
    const summary = summarizeTrafficEntry(entry);
    assert.ok(summary.explanation.some((l) => l.includes("replayed the identical request")));
  });

  it("explains a request that never went upstream", () => {
    const entry = base({
      status: 502,
      accountId: null,
      attempts: [{ accountId: "main", status: "stale-credential" }],
      reqBytes: 228493,
      reqBody: JSON.stringify({ model: "claude-sonnet-4-5" }),
      resBytes: 0,
      error: 'account "main": Refresh token rejected',
    });
    const summary = summarizeTrafficEntry(entry);
    const text = summary.explanation.join("\n");
    assert.ok(text.includes("No account could take this request"));
    assert.ok(text.includes("never went upstream"));
    assert.ok(text.includes("came from the proxy itself"));
    assert.ok(!text.includes("Empty response body"));
  });

  it("parses Anthropic JSON errors and model lists", () => {
    const errEntry = base({
      resBody: JSON.stringify({ error: { type: "rate_limit", message: "slow down" } }),
    });
    const errSummary = summarizeTrafficEntry(errEntry);
    assert.equal(errSummary.response?.kind, "error");
    assert.ok(errSummary.explanation.some((l) => l.includes("slow down")));

    const listEntry = base({
      method: "GET",
      path: "/v1/models",
      reqBytes: 0,
      resBody: JSON.stringify({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
    });
    const listSummary = summarizeTrafficEntry(listEntry);
    assert.equal(listSummary.response?.kind, "json");
    assert.equal(listSummary.response?.totalItems, 3);
    assert.deepEqual(listSummary.response?.items, ["a", "b", "c"]);
    assert.ok(
      listSummary.explanation.some((l) => l.includes("Model list with 3 entries: a, b, c")),
    );

    const longList = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}` }));
    const longSummary = summarizeTrafficEntry(
      base({ method: "GET", path: "/v1/models", reqBytes: 0, resBody: JSON.stringify({ data: longList }) }),
    );
    assert.equal(longSummary.response?.totalItems, 12);
    assert.equal(longSummary.response?.items?.length, 10);
    assert.equal(longSummary.response?.itemsTruncated, true);
    assert.ok(
      longSummary.explanation.some((l) => l.includes("Model list with 12 entries") && l.includes("and 4 more")),
    );
  });

  it("handles missing bodies gracefully", () => {
    const summary = summarizeTrafficEntry(base({}));
    assert.equal(summary.request, null);
    assert.equal(summary.response, null);
    assert.ok(summary.explanation.some((l) => l.includes("wasn't kept")));
  });

  it("falls back to a shape-only summary on unclaimed routes", () => {
    const entry = base({
      method: "GET",
      path: "/v1/unknown-thing",
      reqBytes: 0,
      resBody: "data: {\"type\":\"custom_ping\"}\n\ndata: [DONE]\n",
      resBytes: 40,
    });
    const summary = summarizeTrafficEntry(entry);
    assert.equal(summary.response?.kind, "sse-stream");
    assert.deepEqual(summary.response?.events, [{ type: "custom_ping", count: 1 }]);
    assert.equal(summary.response?.complete, true);
    const text = summary.explanation.join("\n");
    assert.ok(text.includes("No provider parser claimed GET /v1/unknown-thing"));
    assert.ok(text.includes("with “main” and upstream answered 200"));
    assert.equal(summary.response?.usageLine, undefined);
  });

  it("prefers the stamped provider over route matching", () => {
    const entry = base({
      providerId: "claude-subscription",
      method: "GET",
      path: "/v1/something-new",
      reqBytes: 0,
      resBody: JSON.stringify({ type: "message", content: [], usage: { input_tokens: 1 } }),
      resBytes: 60,
    });
    const summary = summarizeTrafficEntry(entry);
    assert.equal(summary.response?.kind, "json");
    assert.equal(summary.response?.usageLine, "1 in");
  });

  it("honors an explicit parser list, even when empty", () => {
    const entry = base({
      resBody: "data: {\"type\":\"message_stop\"}\n",
      resBytes: 30,
    });
    const summary = summarizeTrafficEntry(entry, []);
    assert.equal(summary.response?.kind, "sse-stream");
    assert.deepEqual(summary.response?.events, [{ type: "message_stop", count: 1 }]);
    assert.ok(summary.explanation.some((l) => l.includes("No provider parser claimed")));
    assert.ok(summary.explanation.some((l) => l.includes("Streamed 1 events")));
  });

  it("passes the provider role through to the composed summary", () => {
    const roleParser: TrafficParser = {
      providerId: "test-role",
      canParse: () => true,
      parseRequestBody: () => null,
      summarize: () => ({
        request: null,
        response: { kind: "json", complete: true },
        explanation: ["test"],
        role: { kind: "policy-check", detail: "safety screen" },
      }),
      trafficRole: () => ({ kind: "policy-check", detail: "safety screen" }),
    };
    const summary = summarizeTrafficEntry(base({}), [roleParser]);
    assert.deepEqual(summary.role, { kind: "policy-check", detail: "safety screen" });
  });

  it("passes the provider headline through, overriding it for self-answered statuses", () => {
    const headParser: TrafficParser = {
      providerId: "test-head",
      canParse: () => true,
      parseRequestBody: () => null,
      summarize: () => ({
        request: null,
        response: { kind: "json", complete: true },
        explanation: ["test"],
        headline: "Ran Bash",
      }),
    };
    assert.equal(summarizeTrafficEntry(base({}), [headParser]).headline, "Ran Bash");
    const self = summarizeTrafficEntry(
      base({ status: 503, accountId: null, error: "no accounts" }),
      [headParser],
    );
    assert.ok(self.headline?.startsWith("Never reached upstream:"));
  });

  it("groups entries sharing provider link keys into conversations", () => {
    const keyParser: TrafficParser = {
      providerId: "test-links",
      canParse: () => true,
      parseRequestBody: () => null,
      summarize: (exchange) => ({
        request: exchange.request ?? null,
        response: {
          kind: "json",
          complete: true,
          totalInputTokens: 10,
          outputTokens: 2,
        },
        explanation: ["test"],
      }),
      conversationKeys: (exchange) => {
        const keys = (exchange as { linkKeys?: string[] }).linkKeys;
        return Array.isArray(keys) ? keys : [];
      },
    };
    const parsers = [keyParser];
    const mk = (linkKeys?: string[], ts = new Date(0).toISOString()) =>
      ({
        entry: { ...base({ ts }), linkKeys } as ProxyTrafficEntry,
        summary: summarizeTrafficEntry({ ...base({ ts }), linkKeys } as ProxyTrafficEntry, parsers),
      });
    const items = [
      mk(["k1"]),
      mk(["k1", "k2"]),
      mk(["k2", "k3"]),
      mk(undefined),
      mk(["other"]),
    ];
    const groups = groupTrafficConversations(items, parsers);
    assert.equal(groups.length, 3);
    const big = groups.find((g) => g.turns === 3)!;
    assert.deepEqual(big.indexes, [0, 1, 2]);
    assert.equal(big.sessionId, undefined);
    assert.equal(big.totalInputTokens, 30);
    assert.equal(big.totalOutputTokens, 6);
    assert.ok(big.id.includes("k1"));
    const solos = groups.filter((g) => g.turns === 1);
    assert.equal(solos.length, 2);
  });

  it("builds aggregates across a multi-turn conversation", () => {
    const keyParser: TrafficParser = {
      providerId: "test-agg",
      canParse: () => true,
      parseRequestBody: () => null,
      summarize: (exchange) => ({
        request: { model: "m", toolNames: (exchange as { tn?: string[] }).tn ?? [] },
        response: {
          kind: "json",
          complete: true,
          model: "m",
          totalInputTokens: 100,
          outputTokens: 5,
          cacheReadInputTokens: 80,
          toolUses: (exchange as { tu?: string[] }).tu ?? [],
        },
        explanation: ["test"],
      }),
      conversationKeys: () => ["shared"],
    };
    const parsers = [keyParser];
    const items = [0, 1].map((i) => {
      const entry = {
        ...base({
          ts: new Date(i * 60_000).toISOString(),
          ms: 500 + i * 100,
          profile: "work",
        }),
        tn: ["Bash"],
        tu: i === 0 ? ["Bash"] : ["Read"],
      } as ProxyTrafficEntry;
      return { entry, summary: summarizeTrafficEntry(entry, parsers) };
    });
    const [conv] = groupTrafficConversations(items, parsers);
    assert.equal(conv?.turns, 2);
    assert.equal(conv?.totalInputTokens, 200);
    assert.equal(conv?.totalOutputTokens, 10);
    assert.equal(conv?.cacheReadInputTokens, 160);
    assert.deepEqual(conv?.models, ["m"]);
    assert.deepEqual(conv?.profiles, ["work"]);
    assert.deepEqual(conv?.tools, ["Bash", "Read"]);
    assert.equal(conv?.spanMs, 60_000);
    assert.equal(conv?.upstreamMs, 1100);
  });

  it("exposes the provider session key as sessionId", () => {
    const keyParser: TrafficParser = {
      providerId: "test-session",
      canParse: () => true,
      parseRequestBody: () => null,
      summarize: () => ({ request: null, response: null, explanation: ["test"] }),
      conversationKeys: (exchange) =>
        (exchange as { linkKeys?: string[] }).linkKeys ?? [],
    };
    const parsers = [keyParser];
    const mk = (linkKeys: string[]) => {
      const entry = { ...base(), linkKeys } as ProxyTrafficEntry;
      return { entry, summary: summarizeTrafficEntry(entry, parsers) };
    };
    const [conv] = groupTrafficConversations([mk(["session:abc-123", "k1"])], parsers);
    assert.equal(conv?.sessionId, "abc-123");
    // Session threads are addressed by the raw session (resume) id.
    assert.equal(conv?.id, "abc-123");
    // The session key may arrive on a later turn (policy screens carry only
    // it) — the whole group still takes the session address.
    const [merged] = groupTrafficConversations([mk(["k9"]), mk(["k9", "session:s-9"])], parsers);
    assert.equal(merged?.turns, 2);
    assert.equal(merged?.id, "s-9");
  });
});
