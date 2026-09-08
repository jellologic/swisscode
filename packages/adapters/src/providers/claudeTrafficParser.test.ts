// Tests for the Claude provider traffic adapter: the evidence-driven shapes
// (cache_creation objects, thinking/signature deltas, iterations, tier/geo,
// tool-result excerpts, cache breakpoints) plus the port contract itself.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TrafficExchange } from "@swisscode/core";
import { groupTrafficConversations } from "../proxy/trafficSummary.js";
import { claudeTrafficParser } from "./claudeTrafficParser.js";

function exchange(over: Partial<TrafficExchange> = {}): TrafficExchange {
  return {
    ts: new Date(0).toISOString(),
    method: "POST",
    path: "/v1/messages",
    status: 200,
    ms: 1000,
    accountId: "main",
    reqBytes: 100,
    resBytes: 100,
    attempts: [{ accountId: "main", status: 200 }],
    ...over,
  };
}

const sse = (lines: string[]): string =>
  lines.map((l) => `data: ${l}`).join("\n") + "\n";

describe("claudeTrafficParser port", () => {
  it("identifies itself and its routes", () => {
    assert.equal(claudeTrafficParser.providerId, "claude-subscription");
    assert.ok(claudeTrafficParser.canParse({ method: "POST", path: "/v1/messages" }));
    assert.ok(claudeTrafficParser.canParse({ method: "POST", path: "/v1/messages/count_tokens" }));
    assert.ok(claudeTrafficParser.canParse({ method: "GET", path: "/v1/models" }));
    assert.ok(!claudeTrafficParser.canParse({ method: "GET", path: "/__swisscode/traffic" }));
    assert.ok(!claudeTrafficParser.canParse({ method: "POST", path: "/v1/embeddings" }));
  });

  it("folds the cache_creation object into cached usage", () => {
    const summary = claudeTrafficParser.summarize(
      exchange({
        resBody: sse([
          '{"type":"message_start","message":{"model":"m","usage":{"input_tokens":100,"cache_creation":{"ephemeral_5m_input_tokens":900,"ephemeral_1h_input_tokens":100}}}}',
          '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
          '{"type":"message_stop"}',
        ]),
      }),
    );
    assert.equal(summary.response?.cacheCreationInputTokens, 1000);
    assert.equal(summary.response?.totalInputTokens, 1100);
    assert.equal(summary.response?.usageLine, "1,100 in (1,000 cached) / 7 out");
  });

  it("prefers the flat cache_creation counter when both shapes appear", () => {
    const summary = claudeTrafficParser.summarize(
      exchange({
        resBody: sse([
          '{"type":"message_start","message":{"model":"m","usage":{"input_tokens":10,"cache_creation_input_tokens":50,"cache_creation":{"ephemeral_5m_input_tokens":50}}}}',
          '{"type":"message_stop"}',
        ]),
      }),
    );
    assert.equal(summary.response?.cacheCreationInputTokens, 50);
    assert.equal(summary.response?.totalInputTokens, 60);
  });

  it("tracks thinking volume and keeps signatures out of reply text", () => {
    const summary = claudeTrafficParser.summarize(
      exchange({
        resBody: sse([
          '{"type":"message_start","message":{"model":"m"}}',
          '{"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
          '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me consider"}}',
          '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}',
          '{"type":"content_block_start","index":1,"content_block":{"type":"text"}}',
          '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hi"}}',
          '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
          '{"type":"message_stop"}',
        ]),
      }),
    );
    assert.equal(summary.response?.thinkingChars, "let me consider".length);
    assert.equal(summary.response?.thinkingBlocks, 1);
    assert.equal(summary.response?.textPreview, "hi");
    assert.deepEqual(
      summary.response?.contentBlocks,
      [{ type: "thinking", count: 1 }, { type: "text", count: 1 }],
    );
    const text = summary.explanation.join("\n");
    assert.ok(text.includes("Extended thinking ran"));
    assert.ok(text.includes("Reply structure: 1 thinking + 1 text."));
  });

  it("counts server iterations and non-default serving facts", () => {
    const summary = claudeTrafficParser.summarize(
      exchange({
        resBody: sse([
          '{"type":"message_start","message":{"model":"m","id":"msg_1","usage":{"input_tokens":5,"service_tier":"standard","inference_geo":"not_available"}}}',
          '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2,"iterations":[{"output_tokens":1},{"output_tokens":1}],"service_tier":"priority"}}',
          '{"type":"message_stop"}',
        ]),
      }),
    );
    assert.equal(summary.response?.messageId, "msg_1");
    assert.equal(summary.response?.serverIterations, 2);
    assert.equal(summary.response?.serviceTier, "priority");
    assert.equal(summary.response?.inferenceGeo, undefined);
    const text = summary.explanation.join("\n");
    assert.ok(text.includes("2 server-side iterations"));
    assert.ok(text.includes("tier priority"));
  });

  it("stays quiet on default tier and unavailable geo", () => {
    const summary = claudeTrafficParser.summarize(
      exchange({
        resBody: sse([
          '{"type":"message_start","message":{"model":"m","usage":{"input_tokens":5,"service_tier":"standard","inference_geo":"not_available"}}}',
          '{"type":"message_stop"}',
        ]),
      }),
    );
    assert.equal(summary.response?.serviceTier, "standard");
    assert.ok(!summary.explanation.join("\n").includes("tier standard"));
  });

  it("reads thinking blocks and message ids from non-streamed JSON", () => {
    const summary = claudeTrafficParser.summarize(
      exchange({
        resBody: JSON.stringify({
          type: "message",
          id: "msg_2",
          model: "m",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "answer" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 8, output_tokens: 4 },
        }),
      }),
    );
    assert.equal(summary.response?.messageId, "msg_2");
    assert.equal(summary.response?.thinkingChars, 3);
    assert.equal(summary.response?.thinkingBlocks, 1);
    assert.equal(summary.response?.textPreview, "answer");
    assert.deepEqual(summary.response?.toolUses, ["Bash"]);
  });

  it("excerpts tool results, flags errors, and counts cache breakpoints", () => {
    const reqBody = JSON.stringify({
      model: "m",
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: "go" },
        {
          role: "user",
          content: [
            { type: "tool_result", content: "all good", cache_control: { type: "ephemeral" } },
            { type: "tool_result", content: "boom", is_error: true },
            { type: "thinking", thinking: "earlier thought" },
          ],
        },
      ],
    });
    const summary = claudeTrafficParser.summarize(
      exchange({
        reqBody,
        reqBytes: reqBody.length,
        resBody: sse([
          '{"type":"message_start","message":{"model":"m","usage":{"input_tokens":10,"cache_read_input_tokens":90}}}',
          '{"type":"message_stop"}',
        ]),
      }),
    );
    assert.equal(summary.request?.cacheBreakpoints, 2);
    assert.equal(summary.request?.toolResultCount, 2);
    assert.equal(summary.request?.toolResultErrors, 1);
    assert.ok(
      (summary.request?.messages?.[1]?.preview ?? "").includes("[tool result ERROR: boom]"),
    );
    assert.ok(
      (summary.request?.messages?.[1]?.preview ?? "").includes("[thinking, 15 chars]"),
    );
    const text = summary.explanation.join("\n");
    assert.ok(text.includes("2 cache breakpoints"));
    assert.ok(text.includes("90% of this turn's input arrived cache-read"));
    assert.ok(text.includes("2 tool results echoed back (1 error)"));
  });

  it("links chained turns through tool-use ids", () => {
    const turn1Res = sse([
      '{"type":"message_start","message":{"model":"m"}}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
      '{"type":"message_stop"}',
    ]);
    const turn2Req = JSON.stringify({
      model: "m",
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
        { role: "assistant", content: [{ type: "text", text: "follow-up" }] },
      ],
    });
    const turn1 = claudeTrafficParser.summarize(exchange({ resBody: turn1Res }));
    assert.deepEqual(turn1.response?.toolCalls?.map((t) => t.id), ["toolu_1"]);

    const turn2ReqSummary = claudeTrafficParser.parseRequestBody(turn2Req, turn2Req.length);
    assert.deepEqual(turn2ReqSummary?.toolUseIds, ["toolu_1"]);
    assert.equal(turn2ReqSummary?.toolResultCount, 1);

    const keys1 = claudeTrafficParser.conversationKeys!(exchange({ resBody: turn1Res }));
    const keys2 = claudeTrafficParser.conversationKeys!(
      exchange({ reqBody: turn2Req, request: turn2ReqSummary }),
    );
    assert.deepEqual(keys1, ["toolu_1"]);
    assert.deepEqual(keys2, ["toolu_1"]);
    assert.ok(keys1.some((k) => keys2.includes(k)));
  });

  it("marks safety screens and links runs by session id", () => {
    const sessionReq = (messages: unknown, extra: Record<string, unknown> = {}): string =>
      JSON.stringify({
        model: "claude-sonnet-5",
        metadata: { user_id: JSON.stringify({ device_id: "d1", session_id: "sess-9" }) },
        messages,
        ...extra,
      });
    const screenReq = sessionReq(
      [{ role: "user", content: [{ type: "text", text: "<transcript>\n{\"Bash\":\"rm -rf /\"}\n" }] }],
      {
        system: [{ type: "text", text: "You are a security monitor for autonomous AI coding agents." }],
        max_tokens: 64,
      },
    );
    const role = claudeTrafficParser.trafficRole!(exchange({ reqBody: screenReq }));
    assert.deepEqual(role, { kind: "policy-check", detail: "safety screen" });

    const summary = claudeTrafficParser.summarize(
      exchange({
        reqBody: screenReq,
        reqBytes: screenReq.length,
        resBody: sse(['{"type":"message_stop"}']),
      }),
    );
    assert.deepEqual(summary.role, { kind: "policy-check", detail: "safety screen" });
    assert.ok(summary.explanation[0]!.startsWith("Safety screen, not a work turn"));
    assert.ok(summary.explanation[0]!.includes("capped at 64 output tokens"));

    const keys = claudeTrafficParser.conversationKeys!(exchange({ reqBody: screenReq }));
    assert.ok(keys.includes("session:sess-9"));

    const plainReq = sessionReq([{ role: "user", content: "hi" }]);
    assert.equal(claudeTrafficParser.trafficRole!(exchange({ reqBody: plainReq })), null);
    assert.ok(claudeTrafficParser.conversationKeys!(exchange({ reqBody: plainReq })).includes("session:sess-9"));
  });

  it("writes verdicts and human tool summaries", () => {
    const usage = { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 5 };
    const reply = {
      type: "message",
      model: "m",
      content: [
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la /tmp\nsecond" } },
        { type: "tool_use", id: "t2", name: "Read", input: { file_path: "src/a.ts" } },
        { type: "tool_use", id: "t3", name: "Mystery", input: { x: 1 } },
      ],
      stop_reason: "tool_use",
      usage,
    };
    const summary = claudeTrafficParser.summarize(exchange({ resBody: JSON.stringify(reply) }));
    assert.equal(summary.headline, "Ran Bash, Read, Mystery · 90% reused from cache");
    assert.deepEqual(
      summary.response?.toolCalls?.map((t) => t.summary),
      ["$ ls -la /tmp", "src/a.ts", '{"x":1}'],
    );

    const plain = claudeTrafficParser.summarize(
      exchange({
        resBody: JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "hello there" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      }),
    );
    assert.equal(plain.headline, "“hello there”");

    const capped = claudeTrafficParser.summarize(
      exchange({
        resBody: JSON.stringify({
          type: "message",
          content: [{ type: "text", text: "x" }],
          stop_reason: "max_tokens",
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      }),
    );
    assert.ok(capped.headline?.includes("hit the output cap"));
  });

  it("summarizes streamed tool inputs", () => {
    const summary = claudeTrafficParser.summarize(
      exchange({
        resBody: sse([
          '{"type":"message_start","message":{"model":"m"}}',
          '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"Edit"}}',
          '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"file_path\\":\\"f.ts\\",\\"old_string\\":\\"ab\\",\\"new_string\\":\\"abcd\\"}"}}',
          '{"type":"message_stop"}',
        ]),
      }),
    );
    assert.equal(summary.response?.toolCalls?.[0]?.summary, "f.ts (2→4 chars)");
  });

  it("reads token pre-counts as measuring calls", () => {
    const summary = claudeTrafficParser.summarize(
      exchange({
        path: "/v1/messages/count_tokens",
        resBody: JSON.stringify({ input_tokens: 10652 }),
        resBytes: 22,
      }),
    );
    assert.equal(summary.response?.kind, "json");
    assert.equal(summary.response?.detail, "token pre-count");
    assert.equal(summary.headline, "Measured 10,652 input tokens before sending");
    assert.ok(summary.explanation.some((l) => l.includes("Billed nothing")));
  });

  it("marks subagent launches with their agent type", () => {
    const resBody = sse([
      '{"type":"message_start","message":{"model":"m"}}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_9","name":"Agent"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"subagent_type\\": \\"Explore\\""}}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}',
      '{"type":"message_stop"}',
    ]);
    const role = claudeTrafficParser.trafficRole!(exchange({ resBody }));
    assert.deepEqual(role, { kind: "agent-launch", detail: "Explore" });
    const summary = claudeTrafficParser.summarize(exchange({ resBody }));
    assert.ok(
      summary.explanation.some((l) => l.includes("Launched an Explore subagent")),
    );
  });

  it("groups a lead chain with its safety satellite into one run", () => {
    const meta = { user_id: JSON.stringify({ device_id: "d1", session_id: "sess-7" }) };
    const leadReq = (messages: unknown): string =>
      JSON.stringify({ model: "m", metadata: meta, messages });
    const lead1Res = sse([
      '{"type":"message_start","message":{"model":"m"}}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
      '{"type":"message_stop"}',
    ]);
    const satReq = JSON.stringify({
      model: "m",
      metadata: meta,
      max_tokens: 64,
      system: [{ type: "text", text: "You are a security monitor for autonomous AI coding agents." }],
      messages: [{ role: "user", content: [{ type: "text", text: "<transcript>\n{\"Bash\":\"x\"}\n" }] }],
    });
    const followReq = leadReq([
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
    ]);
    const mkEntry = (over: Partial<TrafficExchange>): { entry: TrafficExchange; summary: ReturnType<typeof claudeTrafficParser.summarize> } => {
      const entry = exchange(over);
      return { entry, summary: claudeTrafficParser.summarize(entry) };
    };
    const items = [
      mkEntry({ reqBody: leadReq([{ role: "user", content: "go" }]), resBody: lead1Res }),
      mkEntry({ reqBody: satReq, resBody: sse(['{"type":"message_stop"}']) }),
      mkEntry({ reqBody: followReq, resBody: sse(['{"type":"message_stop"}']) }),
    ];
    const groups = groupTrafficConversations(items);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.turns, 3);
    assert.deepEqual(groups[0]!.policyChecks, [1]);
    assert.deepEqual(groups[0]!.agentLaunches, []);
  });

  it("skips empty input_json fragments when reassembling tool calls", () => {
    const summary = claudeTrafficParser.summarize(
      exchange({
        resBody: sse([
          '{"type":"message_start","message":{"model":"m"}}',
          '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"Bash"}}',
          '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":""}}',
          '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\":1}"}}',
          '{"type":"message_stop"}',
        ]),
      }),
    );
    assert.deepEqual(summary.response?.toolCalls, [
      { name: "Bash", input: '{"x":1}', inputTruncated: false },
    ]);
  });
});
