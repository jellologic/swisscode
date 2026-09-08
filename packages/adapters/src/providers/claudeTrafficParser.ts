// Adapter: Claude (Anthropic messages API) traffic parser.
// Implements the core TrafficParser port for the claude-subscription
// provider: Claude Code speaks POST /v1/messages (SSE or JSON) plus
// GET /v1/models. Field knowledge here comes from live captures — event
// types, content-block variants, and usage shapes observed on the wire
// (see probe notes in the git history), not from docs alone.

import type {
  TrafficExchange,
  TrafficParser,
  TrafficRequestSummary,
  TrafficResponseSummary,
  TrafficRole,
  TrafficRoute,
  TrafficSummary,
  TrafficToolCall,
} from "@swisscode/core";
import {
  approxTokens,
  asNumber,
  asRecord,
  asString,
  describeJsonShape,
  listItems,
  looksLikeSse,
  safeJsonParse,
  splitSsePayloads,
  tallyNames,
  truncateText,
} from "../proxy/trafficKit.js";

const MAX_PREVIEW_MESSAGES = 8;
const MAX_PREVIEW_CHARS = 300;
const MAX_FULL_MESSAGE_CHARS = 4000;
const MAX_REPLY_CHARS = 2000;
const MAX_TOOL_CALLS = 12;
const MAX_TOOL_INPUT_CHARS = 500;
const MAX_TOOL_RESULT_CHARS = 300;
const MAX_LIST_ITEMS = 10;

interface UsageTotals {
  inputTokens?: number | undefined;
  cacheCreationInputTokens?: number | undefined;
  cacheReadInputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalInputTokens?: number | undefined;
  serviceTier?: string | undefined;
  inferenceGeo?: string | undefined;
  serverIterations?: number | undefined;
}

/**
 * Pull the Anthropic usage object. Shapes seen on the wire:
 * - flat counters: input_tokens, output_tokens, cache_creation_input_tokens,
 *   cache_read_input_tokens (message_start carries input-side, message_delta
 *   carries output-side — merged field-by-field downstream).
 * - cache_creation object: {ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}
 *   (newer servers; used when the flat cache_creation field is absent).
 * - service_tier ("standard"), inference_geo ("not_available" = unset).
 * - iterations: per-iteration usage list (server-side turns on one request).
 */
function readUsage(value: unknown): UsageTotals {
  const u = asRecord(value);
  if (!u) return {};
  const out: UsageTotals = {
    inputTokens: asNumber(u["input_tokens"]),
    cacheCreationInputTokens: asNumber(u["cache_creation_input_tokens"]),
    cacheReadInputTokens: asNumber(u["cache_read_input_tokens"]),
    outputTokens: asNumber(u["output_tokens"]),
  };
  const creation = asRecord(u["cache_creation"]);
  if (creation && out.cacheCreationInputTokens === undefined) {
    const total =
      (asNumber(creation["ephemeral_1h_input_tokens"]) ?? 0) +
      (asNumber(creation["ephemeral_5m_input_tokens"]) ?? 0);
    if (total > 0) out.cacheCreationInputTokens = total;
  }
  const tier = asString(u["service_tier"]);
  if (tier) out.serviceTier = tier;
  const geo = asString(u["inference_geo"]);
  if (geo && geo !== "not_available") out.inferenceGeo = geo;
  const iterations = u["iterations"];
  if (Array.isArray(iterations)) out.serverIterations = iterations.length;
  const parts = [out.inputTokens, out.cacheCreationInputTokens, out.cacheReadInputTokens];
  if (parts.some((p) => p !== undefined)) {
    out.totalInputTokens =
      (out.inputTokens ?? 0) + (out.cacheCreationInputTokens ?? 0) + (out.cacheReadInputTokens ?? 0);
  }
  return out;
}

/** Later usage events override earlier ones field-by-field. */
function mergeUsage(base: UsageTotals, over: UsageTotals): UsageTotals {
  const merged: UsageTotals = { ...base };
  for (
    const key of [
      "inputTokens",
      "cacheCreationInputTokens",
      "cacheReadInputTokens",
      "outputTokens",
      "serviceTier",
      "inferenceGeo",
      "serverIterations",
    ] as const
  ) {
    const value = over[key];
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  const parts = [merged.inputTokens, merged.cacheCreationInputTokens, merged.cacheReadInputTokens];
  if (parts.some((p) => p !== undefined)) {
    merged.totalInputTokens =
      (merged.inputTokens ?? 0) +
      (merged.cacheCreationInputTokens ?? 0) +
      (merged.cacheReadInputTokens ?? 0);
  }
  return merged;
}

/** "57,214 in (57,180 cached) / 850 out" — cache-aware one-liner. */
function usageLine(usage: UsageTotals): string | undefined {
  const out = usage.outputTokens;
  const total = usage.totalInputTokens ?? usage.inputTokens;
  if (total === undefined && out === undefined) return undefined;
  const cached = (usage.cacheCreationInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0);
  const inPart =
    total === undefined
      ? undefined
      : cached > 0
        ? `${total.toLocaleString()} in (${cached.toLocaleString()} cached)`
        : `${total.toLocaleString()} in`;
  const bits = [inPart, out !== undefined ? `${out.toLocaleString()} out` : undefined].filter(
    (b): b is string => b !== undefined,
  );
  return bits.length > 0 ? bits.join(" / ") : undefined;
}

/** Serving-tier suffix, mentioned only when it is not the quiet default. */
function tierSuffix(usage: UsageTotals): string | undefined {
  const bits: string[] = [];
  if (usage.serviceTier && usage.serviceTier !== "standard") bits.push(`tier ${usage.serviceTier}`);
  if (usage.inferenceGeo) bits.push(`geo ${usage.inferenceGeo}`);
  return bits.length > 0 ? bits.join(", ") : undefined;
}

/**
 * Readable one-line rendering of one Anthropic content block. Block types
 * below are the ones Claude Code actually sends: text, thinking (echoed
 * history), redacted_thinking, tool_use, tool_result (str or list content),
 * image. Unknown future types degrade to [type], never to silence.
 */
function describeBlock(block: unknown): string {
  if (typeof block === "string") return block;
  const b = asRecord(block);
  if (!b) return "";
  const type = asString(b["type"]) ?? "block";
  switch (type) {
    case "text":
      return asString(b["text"]) ?? "";
    case "thinking": {
      const text = asString(b["thinking"]) ?? "";
      return `[thinking, ${text.length.toLocaleString()} chars]`;
    }
    case "redacted_thinking":
      return "[redacted thinking]";
    case "tool_use":
      return `[tool ${asString(b["name"]) ?? "use"}]`;
    case "tool_result": {
      const failed = b["is_error"] === true;
      const label = failed ? "tool result ERROR" : "tool result";
      const content = b["content"];
      if (typeof content === "string") {
        const t = truncateText(content, MAX_TOOL_RESULT_CHARS);
        return `[${label}: ${t.text}]${t.truncated ? "…" : ""}`;
      }
      if (Array.isArray(content)) {
        const texts = content
          .map((item) => {
            const r = asRecord(item);
            return r && r["type"] === "text" ? (asString(r["text"]) ?? "") : "";
          })
          .filter((s) => s.length > 0)
          .join("\n");
        const others = content.filter((item) => {
          const r = asRecord(item);
          return !r || r["type"] !== "text";
        }).length;
        if (!texts && others === 0) return `[${label}]`;
        const t = truncateText(texts, MAX_TOOL_RESULT_CHARS);
        const more = others > 0 ? ` (+${others} non-text part${others === 1 ? "" : "s"})` : "";
        return `[${label}: ${t.text}]${t.truncated ? "…" : ""}${more}`;
      }
      return `[${label}]`;
    }
    case "image":
      return "[image]";
    case "document":
      return "[document]";
    case "server_tool_use":
      return `[server tool ${asString(b["name"]) ?? "use"}]`;
    case "web_search_tool_result":
      return "[web search result]";
    case "code_execution_tool_result":
      return "[code execution result]";
    case "mcp_tool_use":
      return `[mcp tool ${asString(b["name"]) ?? "use"}]`;
    case "mcp_tool_result":
      return `[mcp tool result${b["is_error"] === true ? " ERROR" : ""}]`;
    case "container_upload":
      return "[container upload]";
    default:
      return `[${type}]`;
  }
}

/** Readable excerpt of a message/content-block payload. */
function previewContent(content: unknown, cap: number = MAX_PREVIEW_CHARS): { preview: string; truncated: boolean } {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map(describeBlock)
      .filter((s) => s.length > 0)
      .join("\n");
  } else {
    return { preview: "", truncated: false };
  }
  const t = truncateText(text, cap);
  return { preview: t.text, truncated: t.truncated };
}

function previewMessages(messages: unknown[]): { messages: TrafficRequestSummary["messages"]; truncated: boolean } {
  const kept = messages.slice(0, MAX_PREVIEW_MESSAGES).map((m) => {
    const msg = asRecord(m) ?? {};
    const role = asString(msg["role"]) ?? "unknown";
    const { preview, truncated } = previewContent(msg["content"]);
    const full = previewContent(msg["content"], MAX_FULL_MESSAGE_CHARS);
    return {
      role,
      preview,
      truncated,
      full: full.preview || undefined,
      fullTruncated: full.truncated,
    };
  });
  return { messages: kept, truncated: messages.length > kept.length };
}

const MAX_TOOL_USE_IDS = 32;

/**
 * Tool-use ids in a parsed messages array: tool_use block ids plus the
 * tool_use_id references on tool_result blocks. Chained turns echo prior
 * ids back, so these link one conversation's requests together.
 */
function collectRequestToolIds(messages: unknown[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    const content = asRecord(m)?.["content"];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const b = asRecord(block);
      if (!b) continue;
      if (b["type"] === "tool_use") {
        const id = asString(b["id"]);
        if (id && !ids.includes(id)) ids.push(id);
      } else if (b["type"] === "tool_result") {
        const ref = asString(b["tool_use_id"]);
        if (ref && !ids.includes(ref)) ids.push(ref);
      }
      if (ids.length >= MAX_TOOL_USE_IDS) return ids;
    }
  }
  return ids;
}

/** Request facts: model, messages, tools, plus cache/tool-result markers. */
function parseRequestObject(parsed: Record<string, unknown>, reqBytes: number): TrafficRequestSummary {
  const messages = Array.isArray(parsed["messages"]) ? parsed["messages"] : undefined;
  const tools = Array.isArray(parsed["tools"]) ? parsed["tools"] : undefined;
  const out: TrafficRequestSummary = { approxInputTokens: approxTokens(reqBytes) };
  if (typeof parsed["model"] === "string") out.model = parsed["model"];
  if (messages) {
    out.messageCount = messages.length;
    const { messages: excerpts, truncated } = previewMessages(messages);
    out.messages = excerpts;
    out.messagesTruncated = truncated;
    let breakpoints = 0;
    let results = 0;
    let resultErrors = 0;
    for (const m of messages) {
      const content = asRecord(m)?.["content"];
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const b = asRecord(block);
        if (!b) continue;
        if (b["cache_control"] !== undefined) breakpoints += 1;
        if (b["type"] === "tool_result") {
          results += 1;
          if (b["is_error"] === true) resultErrors += 1;
        }
      }
    }
    if (breakpoints > 0) out.cacheBreakpoints = breakpoints;
    if (results > 0) out.toolResultCount = results;
    if (resultErrors > 0) out.toolResultErrors = resultErrors;
    const toolIds = collectRequestToolIds(messages);
    if (toolIds.length > 0) out.toolUseIds = toolIds;
  }
  const system = parsed["system"];
  if (typeof system === "string" || Array.isArray(system)) {
    const chars = typeof system === "string"
      ? system.length
      : system.reduce(
          (n: number, b: unknown) => n + (asString(asRecord(b)?.["text"]) ?? "").length,
          0,
        );
    out.systemChars = chars;
    out.systemPreview = previewContent(system, 200).preview || undefined;
    if (Array.isArray(system)) {
      const systemBreakpoints = system.filter(
        (b: unknown) => asRecord(b)?.["cache_control"] !== undefined,
      ).length;
      if (systemBreakpoints > 0) {
        out.cacheBreakpoints = (out.cacheBreakpoints ?? 0) + systemBreakpoints;
      }
    }
  }
  if (tools) {
    out.toolCount = tools.length;
    out.toolNames = tools
      .map((t) => asString(asRecord(t)?.["name"]))
      .filter((n): n is string => n !== null && n !== undefined)
      .slice(0, 12);
  }
  if (typeof parsed["max_tokens"] === "number") out.maxTokens = parsed["max_tokens"];
  if (typeof parsed["stream"] === "boolean") out.stream = parsed["stream"];
  return out;
}

interface SseAccum {
  counts: Map<string, number>;
  model?: string;
  messageId?: string;
  usage: UsageTotals;
  stopReason?: string;
  errorMessage?: string;
  complete: boolean;
  texts: string[];
  thinkingChars: number;
  thinkingBlocks: number;
  /** Content-block types in first-seen order (reply composition). */
  blockOrder: string[];
  toolUses: string[];
  /** Per-block tool input fragments, keyed by content-block index. */
  toolInputs: Map<number, { name?: string; id?: string; parts: string[] }>;
}

/** Tool-input bucket for a content-block index (creates on first use). */
function bucket(
  accum: SseAccum,
  event: Record<string, unknown>,
): { name?: string; id?: string; parts: string[] } {
  const index = typeof event["index"] === "number" ? (event["index"] as number) : -1;
  let entry = accum.toolInputs.get(index);
  if (!entry) {
    entry = { parts: [] };
    accum.toolInputs.set(index, entry);
  }
  return entry;
}

function noteBlock(accum: SseAccum, type: string): void {
  if (!accum.blockOrder.includes(type)) accum.blockOrder.push(type);
}

const MAX_TOOL_SUMMARY_CHARS = 140;

/** First line, capped — the readable core of a shell/file/tool argument. */
function oneLine(value: unknown, cap: number = MAX_TOOL_SUMMARY_CHARS): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const first = value.split("\n")[0]!.trim();
  if (!first) return undefined;
  return first.length <= cap ? first : `${first.slice(0, cap)}…`;
}

/**
 * One-line human reading of a tool input. Claude Code's tool shapes are
 * fixed knowledge: Bash runs a command, Read/Edit/Write take a file path,
 * Task takes an agent type + description. Unknown tools (incl. MCP) fall
 * back to a compact JSON slice — never silence, never a raw blob in UI.
 */
function summarizeToolInput(name: string, input: unknown): string | undefined {
  const obj = typeof input === "string" ? asRecord(safeJsonParse(input)) : asRecord(input);
  if (!obj) {
    return typeof input === "string" ? oneLine(input) : undefined;
  }
  const str = (key: string): string | undefined => asString(obj[key]);
  switch (name) {
    case "Bash": {
      const command = oneLine(str("command"));
      return command ? `$ ${command}` : undefined;
    }
    case "Read":
    case "NotebookRead":
      return str("file_path") ?? str("notebook_path");
    case "Edit": {
      const path = str("file_path");
      const oldLen = str("old_string")?.length ?? 0;
      const newLen = str("new_string")?.length ?? 0;
      if (!path) return undefined;
      return oldLen > 0 || newLen > 0 ? `${path} (${oldLen}→${newLen} chars)` : path;
    }
    case "Write": {
      const path = str("file_path");
      const len = str("content")?.length ?? 0;
      if (!path) return undefined;
      return len > 0 ? `${path} (${len.toLocaleString()} chars)` : path;
    }
    case "MultiEdit": {
      const path = str("file_path");
      const edits = obj["edits"];
      if (!path) return undefined;
      return Array.isArray(edits) ? `${path} (${edits.length} edits)` : path;
    }
    case "NotebookEdit":
      return str("notebook_path");
    case "Glob": {
      const pattern = str("pattern");
      const path = str("path");
      if (!pattern) return undefined;
      return path && path !== "." ? `${pattern} in ${path}` : pattern;
    }
    case "Grep": {
      const pattern = oneLine(str("pattern"), 80);
      const path = str("path");
      if (!pattern) return undefined;
      return path && path !== "." ? `${pattern} in ${path}` : pattern;
    }
    case "LS":
      return str("path") ?? ".";
    case "Task":
    case "Agent": {
      const agent = str("subagent_type");
      const desc = oneLine(str("description"));
      if (agent && desc) return `${agent}: ${desc}`;
      return agent ?? desc;
    }
    case "TodoWrite": {
      const todos = obj["todos"];
      return Array.isArray(todos) ? `${todos.length} todo${todos.length === 1 ? "" : "s"}` : undefined;
    }
    case "WebFetch":
      return oneLine(str("url"));
    case "WebSearch":
      return oneLine(str("query"));
    default: {
      const flat = JSON.stringify(obj);
      return flat.length <= MAX_TOOL_SUMMARY_CHARS ? flat : `${flat.slice(0, MAX_TOOL_SUMMARY_CHARS)}…`;
    }
  }
}

/** Assembled tool calls (name + truncated input), in block order. */
function assembleToolCalls(accum: SseAccum): TrafficToolCall[] {
  const calls: TrafficToolCall[] = [];
  for (const [index, entry] of [...accum.toolInputs.entries()].sort((a, b) => a[0] - b[0])) {
    const input = entry.parts.join("");
    if (!entry.name && !input) continue;
    const call: TrafficToolCall = { name: entry.name ?? `block #${index}` };
    if (entry.id) call.id = entry.id;
    if (input) {
      const t = truncateText(input, MAX_TOOL_INPUT_CHARS);
      call.input = t.text;
      call.inputTruncated = t.truncated;
      const summary = summarizeToolInput(call.name, input);
      if (summary) call.summary = summary;
    } else if (entry.name) {
      const summary = summarizeToolInput(entry.name, undefined);
      if (summary) call.summary = summary;
    }
    calls.push(call);
    if (calls.length >= MAX_TOOL_CALLS) break;
  }
  return calls;
}

function feedSseEvent(accum: SseAccum, payload: string): void {
  if (payload === "[DONE]") {
    accum.complete = true;
    return;
  }
  const event = asRecord(safeJsonParse(payload));
  if (!event || typeof event["type"] !== "string") return;
  const type = event["type"] as string;
  accum.counts.set(type, (accum.counts.get(type) ?? 0) + 1);
  if (type === "message_start") {
    const message = asRecord(event["message"]);
    if (message) {
      const model = asString(message["model"]);
      if (model) accum.model = model;
      const id = asString(message["id"]);
      if (id) accum.messageId = id;
      accum.usage = mergeUsage(accum.usage, readUsage(message["usage"]));
    }
  } else if (type === "content_block_start") {
    const block = asRecord(event["content_block"]);
    const blockType = block ? (asString(block["type"]) ?? "unknown") : "unknown";
    noteBlock(accum, blockType);
    if (blockType === "tool_use") {
      const name = block ? asString(block["name"]) : undefined;
      if (name) {
        accum.toolUses.push(name);
        const bucketEntry = bucket(accum, event);
        bucketEntry.name = name;
        const id = block ? asString(block["id"]) : undefined;
        if (id) bucketEntry.id = id;
      }
    } else if (blockType === "thinking" || blockType === "redacted_thinking") {
      accum.thinkingBlocks += 1;
    }
  } else if (type === "content_block_delta") {
    const delta = asRecord(event["delta"]);
    if (!delta) return;
    if (typeof delta["text"] === "string") accum.texts.push(delta["text"] as string);
    if (typeof delta["thinking"] === "string") accum.thinkingChars += (delta["thinking"] as string).length;
    if (typeof delta["partial_json"] === "string" && delta["partial_json"] !== "") {
      bucket(accum, event).parts.push(delta["partial_json"] as string);
    }
  } else if (type === "message_delta") {
    const delta = asRecord(event["delta"]);
    if (delta && typeof delta["stop_reason"] === "string") {
      accum.stopReason = delta["stop_reason"] as string;
    }
    accum.usage = mergeUsage(accum.usage, readUsage(event["usage"]));
  } else if (type === "message_stop") {
    accum.complete = true;
  } else if (type === "error") {
    const error = asRecord(event["error"]);
    if (error && typeof error["message"] === "string") {
      accum.errorMessage = error["message"] as string;
    }
  }
}

function cappedReply(text: string): { textPreview: string; textTruncated: boolean } {
  if (text.length <= MAX_REPLY_CHARS) return { textPreview: text, textTruncated: false };
  return { textPreview: text.slice(0, MAX_REPLY_CHARS), textTruncated: true };
}

function blockCounts(order: string[], counts: Map<string, number>): { type: string; count: number }[] {
  return order.map((type) => ({ type, count: counts.get(type) ?? 0 }));
}

function summarizeAccum(accum: SseAccum, kind: "sse-stream" | "json"): TrafficResponseSummary {
  const events = [...accum.counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
  if (accum.errorMessage) {
    return { kind: "error", events, errorMessage: accum.errorMessage, complete: true };
  }
  const counts = new Map<string, number>();
  for (const t of accum.blockOrder) counts.set(t, (counts.get(t) ?? 0) + 1);
  const reply = cappedReply(accum.texts.join(""));
  const toolCalls = assembleToolCalls(accum);
  return {
    kind,
    events: kind === "sse-stream" ? events : undefined,
    model: accum.model,
    messageId: accum.messageId,
    inputTokens: accum.usage.inputTokens,
    cacheCreationInputTokens: accum.usage.cacheCreationInputTokens,
    cacheReadInputTokens: accum.usage.cacheReadInputTokens,
    totalInputTokens: accum.usage.totalInputTokens,
    outputTokens: accum.usage.outputTokens,
    serviceTier: accum.usage.serviceTier,
    inferenceGeo: accum.usage.inferenceGeo,
    serverIterations: accum.usage.serverIterations,
    stopReason: accum.stopReason,
    complete: accum.complete,
    ...(reply.textPreview ? { ...reply } : {}),
    ...(accum.toolUses.length > 0 ? { toolUses: accum.toolUses } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(accum.thinkingChars > 0 || accum.thinkingBlocks > 0
      ? { thinkingChars: accum.thinkingChars, thinkingBlocks: accum.thinkingBlocks }
      : {}),
    ...(accum.blockOrder.length > 0 ? { contentBlocks: blockCounts(accum.blockOrder, counts) } : {}),
  };
}

function parseSseResponse(text: string): TrafficResponseSummary {
  const accum: SseAccum = {
    counts: new Map(),
    usage: {},
    complete: false,
    texts: [],
    thinkingChars: 0,
    thinkingBlocks: 0,
    blockOrder: [],
    toolUses: [],
    toolInputs: new Map(),
  };
  for (const payload of splitSsePayloads(text)) feedSseEvent(accum, payload);
  if (accum.counts.size === 0) return { kind: "text", complete: false };
  return summarizeAccum(accum, "sse-stream");
}

function parseMessageObject(obj: Record<string, unknown>): TrafficResponseSummary {
  const usage = readUsage(obj["usage"]);
  const blocks = Array.isArray(obj["content"]) ? obj["content"] : [];
  // Reply text is text blocks only — tool blocks are calls, not prose.
  const texts = blocks
    .map((b) => {
      const r = asRecord(b);
      return r && r["type"] === "text" ? (asString(r["text"]) ?? "") : "";
    })
    .filter((s) => s.length > 0)
    .join("\n");
  const reply = cappedReply(texts);
  const toolUses = blocks
    .map((b) => asRecord(b))
    .filter((b) => b?.["type"] === "tool_use")
    .map((b) => asString(b?.["name"]))
    .filter((n): n is string => typeof n === "string");
  const toolCalls: TrafficToolCall[] = blocks
    .map((b) => asRecord(b))
    .filter((b) => b?.["type"] === "tool_use")
    .slice(0, MAX_TOOL_CALLS)
    .map((b, i) => {
      const call: TrafficToolCall = {
        name: asString(b?.["name"]) ?? `block #${i}`,
      };
      const id = asString(b?.["id"]);
      if (id) call.id = id;
      const summary = summarizeToolInput(call.name, b?.["input"]);
      if (summary) call.summary = summary;
      if (b?.["input"] !== undefined) {
        const t = truncateText(JSON.stringify(b["input"]), MAX_TOOL_INPUT_CHARS);
        call.input = t.text;
        call.inputTruncated = t.truncated;
      }
      return call;
    });
  const blockTypes = blocks.map((b) => asString(asRecord(b)?.["type"]) ?? "unknown");
  const order = [...new Set(blockTypes)];
  const counts = new Map<string, number>();
  for (const t of blockTypes) counts.set(t, (counts.get(t) ?? 0) + 1);
  let thinkingChars = 0;
  let thinkingBlocks = 0;
  for (const b of blocks) {
    const r = asRecord(b);
    if (r?.["type"] === "thinking") {
      thinkingBlocks += 1;
      thinkingChars += (asString(r["thinking"]) ?? "").length;
    } else if (r?.["type"] === "redacted_thinking") {
      thinkingBlocks += 1;
    }
  }
  return {
    kind: "json",
    model: asString(obj["model"]),
    messageId: asString(obj["id"]),
    inputTokens: usage.inputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    totalInputTokens: usage.totalInputTokens,
    outputTokens: usage.outputTokens,
    serviceTier: usage.serviceTier,
    inferenceGeo: usage.inferenceGeo,
    serverIterations: usage.serverIterations,
    stopReason: asString(obj["stop_reason"]),
    complete: true,
    ...(reply.textPreview ? { ...reply } : {}),
    ...(toolUses.length > 0 ? { toolUses } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(thinkingChars > 0 || thinkingBlocks > 0 ? { thinkingChars, thinkingBlocks } : {}),
    ...(order.length > 0 ? { contentBlocks: blockCounts(order, counts) } : {}),
  };
}

function parseJsonResponse(text: string, path?: string): TrafficResponseSummary {
  const parsed = safeJsonParse(text);
  if (parsed === undefined) return { kind: "text", complete: false };
  const obj = asRecord(parsed);
  if (obj) {
    // Token pre-count: Claude Code measures a payload before sending it.
    // Same messages shape in, {"input_tokens": N} out — billed nothing.
    if (path?.endsWith("/count_tokens") && typeof obj["input_tokens"] === "number") {
      const counted = obj["input_tokens"] as number;
      return {
        kind: "json",
        complete: true,
        inputTokens: counted,
        totalInputTokens: counted,
        usageLine: `${counted.toLocaleString()} in`,
        detail: "token pre-count",
      };
    }
    const err = asRecord(obj["error"]);
    if (err) {
      return {
        kind: "error",
        errorMessage:
          asString(err["message"]) ?? JSON.stringify(err).slice(0, 300),
        complete: true,
      };
    }
    const usage = readUsage(obj["usage"]);
    if (
      obj["type"] === "message" ||
      Object.keys(usage).length > 0 ||
      typeof obj["stop_reason"] === "string"
    ) {
      return parseMessageObject(obj);
    }
    const data = obj["data"];
    if (Array.isArray(data)) {
      return { kind: "json", complete: true, detail: describeJsonShape(parsed), ...listItems(data, MAX_LIST_ITEMS) };
    }
    return { kind: "json", complete: true, detail: describeJsonShape(parsed) };
  }
  if (Array.isArray(parsed)) {
    return { kind: "json", complete: true, detail: describeJsonShape(parsed), ...listItems(parsed, MAX_LIST_ITEMS) };
  }
  return { kind: "json", complete: true, detail: describeJsonShape(parsed) };
}

/**
 * One-line verdict for the detail headline: the conclusion first, evidence
 * in the bullets. Names what Claude did (replied / ran tools / screened /
 * listed / got rejected) plus the one fact that changes the reading —
 * a hit output cap or a cache-dominated turn.
 */
function verdict(
  request: TrafficRequestSummary | null,
  response: TrafficResponseSummary | null,
  role: TrafficRole | null,
): string | undefined {
  if (role?.kind === "policy-check") return "Safety screen ran — run continues";
  if (!response) return undefined;
  if (response.kind === "error") {
    const msg = response.errorMessage ?? "unknown error";
    return `Rejected: ${msg.length > 80 ? `${msg.slice(0, 80)}…` : msg}`;
  }
  if (response.kind === "empty") return "Empty reply";
  if (response.kind === "text") return "Reply wasn't JSON or SSE";
  const calls = response.toolCalls ?? [];
  const names = [...new Set(calls.map((c) => c.name))];
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` +${names.length - 3} more` : "";
  const stopBit = response.stopReason === "max_tokens" ? " · hit the output cap" : "";
  const total = response.totalInputTokens ?? response.inputTokens ?? 0;
  const cached = (response.cacheCreationInputTokens ?? 0) + (response.cacheReadInputTokens ?? 0);
  const cacheBit =
    total > 0 && cached / total >= 0.5
      ? ` · ${Math.round((cached / total) * 100)}% reused from cache`
      : "";
  if (response.totalItems !== undefined && !response.stopReason) {
    return `Listed ${response.totalItems} model${response.totalItems === 1 ? "" : "s"}`;
  }
  if (response.detail === "token pre-count" && response.totalInputTokens !== undefined) {
    return `Measured ${response.totalInputTokens.toLocaleString()} input tokens before sending`;
  }
  if (calls.length > 0) return `Ran ${shown}${more}${stopBit}${cacheBit}`;
  const text = (response.textPreview ?? "").replace(/\s+/g, " ").trim();
  if (text) return `“${text.length > 90 ? `${text.slice(0, 90)}…”` : text}”${stopBit}${cacheBit}`;
  return `No text reply${stopBit}${cacheBit}` || undefined;
}

/** Plain-English walkthrough of one Claude exchange, minus proxy routing. */
function explainClaude(entry: TrafficExchange, request: TrafficRequestSummary | null, response: TrafficResponseSummary | null): string[] {
  const explanation: string[] = [];

  if (request?.model) {
    let line = `The client asked ${request.model}`;
    const parts: string[] = [];
    if (request.messageCount !== undefined) {
      parts.push(
        `${request.messageCount} message${request.messageCount === 1 ? "" : "s"} (~${request.approxInputTokens?.toLocaleString() ?? "?"} input tokens)`,
      );
    }
    if (request.toolResultCount) {
      parts.push(
        `${request.toolResultCount} tool result${request.toolResultCount === 1 ? "" : "s"} echoed back${request.toolResultErrors ? ` (${request.toolResultErrors} error${request.toolResultErrors === 1 ? "" : "s"})` : ""}`,
      );
    }
    if (request.systemChars) parts.push(`a ${(request.systemChars / 1000).toFixed(1)}k-char system prompt`);
    if (request.toolCount) parts.push(`${request.toolCount} tools`);
    if (parts.length > 0) line += ` with ${parts.join(", ")}`;
    line += request.stream === false ? " (single reply, no stream)." : ".";
    explanation.push(line);
  } else if (request) {
    explanation.push(
      `${entry.method} ${entry.path} carried a non-JSON body (~${request.approxInputTokens?.toLocaleString() ?? "?"} tokens).`,
    );
  } else if (entry.reqBytes > 0) {
    explanation.push(
      `${entry.method} ${entry.path} sent ${entry.reqBytes.toLocaleString()}B upstream (body wasn't kept).`,
    );
  } else {
    explanation.push(`${entry.method} ${entry.path} — no request body.`);
  }

  if (response?.kind === "sse-stream") {
    const total = response.events?.reduce((n, e) => n + e.count, 0) ?? 0;
    const types = response.events?.slice(0, 4).map((e) => `${e.type}×${e.count}`).join(", ");
    let line = `Anthropic streamed ${total} events${types ? ` (${types})` : ""}`;
    const usageBits: string[] = [];
    const usage = response.usageLine;
    if (usage) usageBits.push(usage);
    if (response.stopReason) usageBits.push(`stop: ${response.stopReason}`);
    const tier = tierSuffix(response);
    if (tier) usageBits.push(tier);
    line += usageBits.length > 0 ? ` — ${usageBits.join(", ")}.` : ".";
    explanation.push(line);
    if (!response.complete) {
      explanation.push(
        entry.resBodyTruncated
          ? "Only the start of the stream was kept, so the final usage and stop reason are missing — raise the buffer body cap to see them."
          : "No terminal stream event was seen, so the reply may have been cut off.",
      );
    }
  } else if (response?.kind === "json") {
    const usage = response.usageLine;
    if (response.detail === "token pre-count" && response.totalInputTokens !== undefined) {
      explanation.push(
        `Pre-flight token count — Claude Code measured the payload (${response.totalInputTokens.toLocaleString()} input tokens) before sending it. Billed nothing.`,
      );
    } else if (response.stopReason || usage !== undefined) {
      const bits: string[] = [];
      if (usage) bits.push(usage);
      if (response.stopReason) bits.push(`stop: ${response.stopReason}`);
      const tier = tierSuffix(response);
      if (tier) bits.push(tier);
      explanation.push(`Single JSON reply — ${bits.join(", ")}.`);
    } else if (response.totalItems !== undefined) {
      const label = entry.path.endsWith("/models") ? "Model list" : "List reply";
      const shownItems = (response.items ?? []).slice(0, 8);
      const hidden = response.totalItems - shownItems.length;
      const more = hidden > 0 ? `, and ${hidden} more` : "";
      explanation.push(
        `${label} with ${response.totalItems} entr${response.totalItems === 1 ? "y" : "ies"}${shownItems.length > 0 ? `: ${shownItems.join(", ")}${more}` : "."}`,
      );
    } else {
      explanation.push(`JSON reply (${response.detail ?? "object"}) — not a model response, likely a control call.`);
    }
  } else if (response?.kind === "error") {
    explanation.push(
      `Anthropic itself rejected this request — not a proxy failure: ${response.errorMessage ?? "unknown error"}.`,
    );
  } else if (response?.kind === "empty") {
    explanation.push("Empty response body (typical for HEAD/preflight checks).");
  } else if (response?.kind === "text") {
    explanation.push(
      entry.resBodyTruncated
        ? "The response wasn't recognized JSON/SSE in the bytes kept."
        : "The response wasn't recognized JSON or SSE.",
    );
  } else {
    explanation.push("The response body wasn't kept, so there's nothing more to say about it.");
  }

  if (request?.cacheBreakpoints) {
    const cached = (response?.cacheCreationInputTokens ?? 0) + (response?.cacheReadInputTokens ?? 0);
    const total = response?.totalInputTokens ?? response?.inputTokens ?? 0;
    const share = total > 0 ? ` — ${Math.round((cached / total) * 100)}% of this turn's input arrived cache-read` : "";
    explanation.push(
      `${request.cacheBreakpoints} cache breakpoint${request.cacheBreakpoints === 1 ? "" : "s"} tag${request.cacheBreakpoints === 1 ? "s" : ""} reusable context${share}.`,
    );
  }

  if ((response?.thinkingChars ?? 0) > 0 || (response?.thinkingBlocks ?? 0) > 0) {
    const chars = response?.thinkingChars ?? 0;
    const blocks = response?.thinkingBlocks ?? 0;
    const volume = chars > 0 ? `~${chars.toLocaleString()} chars` : `${blocks} block${blocks === 1 ? "" : "s"}`;
    explanation.push(
      `Extended thinking ran (${volume}) before the reply — private reasoning, billed as output tokens.`,
    );
  }

  if (response?.contentBlocks && response.contentBlocks.some((b) => b.type !== "text")) {
    const shape = response.contentBlocks.map((b) => `${b.count} ${b.type}`).join(" + ");
    explanation.push(`Reply structure: ${shape}.`);
  }

  if (response?.serverIterations) {
    explanation.push(
      `Usage reports ${response.serverIterations} server-side iteration${response.serverIterations === 1 ? "" : "s"} folded into this turn.`,
    );
  }

  const toolCalls = response?.toolCalls ?? [];
  if ((response?.kind === "sse-stream" || response?.kind === "json") && toolCalls.length > 0) {
    const names = toolCalls.slice(0, 4).map((t) => t.name).join(", ");
    const more = toolCalls.length > 4 ? `, and ${toolCalls.length - 4} more` : "";
    explanation.push(`Plus ${toolCalls.length} tool call${toolCalls.length === 1 ? "" : "s"}: ${names}${more}.`);
  }

  return explanation;
}

function parseRequest(exchange: TrafficExchange): TrafficRequestSummary | null {
  // Prefer facts parsed from the full body pre-truncation.
  if (exchange.request) return exchange.request;
  if (!exchange.reqBody) return null;
  const summary = claudeTrafficParser.parseRequestBody(exchange.reqBody, exchange.reqBytes);
  // A truncated head is not valid JSON — say so instead of pretending.
  if (
    summary &&
    exchange.reqBodyTruncated &&
    summary.model === undefined &&
    summary.messageCount === undefined
  ) {
    return { approxInputTokens: approxTokens(exchange.reqBytes) };
  }
  return summary;
}

function parseResponse(exchange: TrafficExchange): TrafficResponseSummary | null {
  if (exchange.resBytes === 0) return { kind: "empty", complete: true };
  if (!exchange.resBody) return null;
  return looksLikeSse(exchange.resBody)
    ? parseSseResponse(exchange.resBody)
    : parseJsonResponse(exchange.resBody, exchange.path);
}

const POLICY_MONITOR_MARKER = "You are a security monitor for autonomous AI coding agents";
const TRANSCRIPT_OPEN = "<transcript>";

/**
 * Claude Code stamps every request of one CLI run with metadata.user_id,
 * a JSON string carrying device_id and session_id. The session id is the
 * workflow-run key: lead turns, safety screens, and any future satellite
 * all share it, so one `claude -p` invocation groups into one thread.
 */
function requestSessionId(reqBody: string | undefined): string | undefined {
  if (!reqBody) return undefined;
  const metadata = asRecord(asRecord(safeJsonParse(reqBody))?.["metadata"]);
  const userId = asString(metadata?.["user_id"]);
  if (!userId) return undefined;
  return asString(asRecord(safeJsonParse(userId))?.["session_id"]);
}

/** Safety-screen turn: security-monitor system + transcript message, no tools. */
function isPolicyScreen(parsed: Record<string, unknown>): boolean {
  const system = parsed["system"];
  const systemText = typeof system === "string"
    ? system
    : Array.isArray(system)
      ? system.map((b) => asString(asRecord(b)?.["text"]) ?? "").join("\n")
      : "";
  if (!systemText.includes(POLICY_MONITOR_MARKER)) return false;
  const messages = parsed["messages"];
  if (!Array.isArray(messages) || messages.length !== 1) return false;
  return JSON.stringify(messages[0]).includes(TRANSCRIPT_OPEN);
}

/** Subagent launches in a response: Task/Agent tool calls and their types. */
function responseLaunches(resBody: string | undefined): { name: string; agent?: string }[] {
  if (!resBody) return [];
  const out: { name: string; agent?: string }[] = [];
  if (looksLikeSse(resBody)) {
    for (const payload of splitSsePayloads(resBody)) {
      if (payload === "[DONE]") continue;
      const event = asRecord(safeJsonParse(payload));
      if (event?.["type"] !== "content_block_start") continue;
      const block = asRecord(event["content_block"]);
      if (block?.["type"] !== "tool_use") continue;
      const name = asString(block["name"]);
      if (name === "Task" || name === "Agent") out.push({ name });
    }
    // Subagent type arrives inside streamed input_json fragments — scan raw.
    // Fragments stay JSON-escaped in the kept bytes (\"subagent_type\").
    const types = [...resBody.matchAll(/subagent_type\\?"?\s*:\\?"?\s*\\?"([^"\\]+)/g)].map(
      (m) => m[1]!,
    );
    out.forEach((launch, i) => {
      if (types[i]) launch.agent = types[i];
    });
    return out;
  }
  const obj = asRecord(safeJsonParse(resBody));
  const content = obj?.["content"];
  if (Array.isArray(content)) {
    for (const item of content) {
      const b = asRecord(item);
      if (b?.["type"] === "tool_use") {
        const name = asString(b["name"]);
        if (name === "Task" || name === "Agent") {
          const agent = asString(asRecord(b["input"])?.["subagent_type"]);
          out.push(agent ? { name, agent } : { name });
        }
      }
    }
  }
  return out;
}

/** Tool-use ids in a response body (stream start-blocks or JSON content). */
function collectResponseToolIds(resBody: string): string[] {
  const ids: string[] = [];
  const take = (id: string | undefined): void => {
    if (id && !ids.includes(id) && ids.length < MAX_TOOL_USE_IDS) ids.push(id);
  };
  if (looksLikeSse(resBody)) {
    for (const payload of splitSsePayloads(resBody)) {
      if (payload === "[DONE]") continue;
      const event = asRecord(safeJsonParse(payload));
      if (event?.["type"] !== "content_block_start") continue;
      const block = asRecord(event["content_block"]);
      if (block?.["type"] === "tool_use") take(asString(block["id"]));
    }
    return ids;
  }
  const obj = asRecord(safeJsonParse(resBody));
  const content = obj?.["content"];
  if (Array.isArray(content)) {
    for (const item of content) {
      const b = asRecord(item);
      if (b?.["type"] === "tool_use") take(asString(b["id"]));
    }
  }
  return ids;
}

export const claudeTrafficParser: TrafficParser = {
  providerId: "claude-subscription",
  upstreamName: "Anthropic",

  canParse(route: TrafficRoute): boolean {
    return (
      route.path === "/v1/messages" ||
      route.path.startsWith("/v1/messages/") ||
      route.path === "/v1/models" ||
      route.path.startsWith("/v1/models/")
    );
  },

  parseRequestBody(text: string, reqBytes: number): TrafficRequestSummary | null {
    const parsed = safeJsonParse(text);
    const obj = asRecord(parsed);
    if (!obj) return { approxInputTokens: approxTokens(reqBytes) };
    return parseRequestObject(obj, reqBytes);
  },

  summarize(exchange: TrafficExchange): TrafficSummary {
    const request = parseRequest(exchange);
    const response = parseResponse(exchange);
    if (response && (response.kind === "sse-stream" || response.kind === "json")) {
      response.usageLine = usageLine(response);
    }
    const explanation = explainClaude(exchange, request, response);
    const role = detectRole(exchange);
    const headline = verdict(request, response, role);
    if (role?.kind === "policy-check") {
      const cap = request?.maxTokens !== undefined ? `capped at ${request.maxTokens} output tokens` : "a tiny output cap";
      explanation.unshift(
        `Safety screen, not a work turn: Claude Code had Sonnet judge a transcript excerpt (${cap}, no tools) before letting the run continue.`,
      );
    }
    if (role?.kind === "agent-launch") {
      // Detail is the subagent type when streamed fragments kept it (e.g.
      // "Explore"); otherwise it falls back to the tool name ("Agent").
      // Verified execution model: the subagent is an in-process sidechain
      // (own transcript, same session, own API client) — never a fork, and
      // its turns never pass the proxy. Only the verdict echoes back here.
      const what =
        role.detail && role.detail !== "Task" && role.detail !== "Agent"
          ? `an ${role.detail} subagent`
          : `a subagent via ${role.detail ?? "Agent"}`;
      explanation.push(
        `Launched ${what} as an in-process sidechain — its own turns bypass the proxy, so only the verdict echoes back into this thread.`,
      );
    }
    return {
      request,
      response,
      explanation,
      ...(role ? { role } : {}),
      ...(headline ? { headline } : {}),
    };
  },

  conversationKeys(exchange: TrafficExchange): string[] {
    const ids = new Set<string>();
    for (const id of exchange.request?.toolUseIds ?? []) ids.add(id);
    if (exchange.reqBody) {
      const parsed = asRecord(safeJsonParse(exchange.reqBody));
      const messages = parsed?.["messages"];
      if (Array.isArray(messages)) {
        for (const id of collectRequestToolIds(messages)) ids.add(id);
      }
      // Run-scoped key: one CLI invocation shares a session id across lead
      // turns and satellites (safety screens), grouping the whole workflow.
      const metadata = asRecord(parsed?.["metadata"]);
      const userId = asString(metadata?.["user_id"]);
      const sessionId = userId
        ? asString(asRecord(safeJsonParse(userId))?.["session_id"])
        : undefined;
      if (sessionId) ids.add(`session:${sessionId}`);
    }
    if (exchange.resBody) {
      for (const id of collectResponseToolIds(exchange.resBody)) ids.add(id);
    }
    return [...ids].slice(0, MAX_TOOL_USE_IDS + 1);
  },

  trafficRole(exchange: TrafficExchange): TrafficRole | null {
    return detectRole(exchange);
  },
};

/** Workflow role of one turn, shared by trafficRole and summarize. */
function detectRole(exchange: TrafficExchange): TrafficRole | null {
  if (exchange.reqBody) {
    const parsed = asRecord(safeJsonParse(exchange.reqBody));
    if (parsed && isPolicyScreen(parsed)) {
      return { kind: "policy-check", detail: "safety screen" };
    }
  }
  const launches = responseLaunches(exchange.resBody);
  if (launches.length > 0) {
    const agents = [...new Set(launches.map((l) => l.agent).filter((a) => a !== undefined))];
    return {
      kind: "agent-launch",
      detail: agents.length > 0 ? agents.join(", ") : launches[0]!.name,
    };
  }
  return null;
}
