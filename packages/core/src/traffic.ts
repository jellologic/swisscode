// Traffic-inspection contracts. The core owns this language: the proxy
// (driven side) captures raw exchanges, and each AI-coding-agent provider
// explains its own wire format by implementing TrafficParser. Reusable
// byte mechanics (SSE splitting, truncation, token math) live in the
// adapters' traffic kit; response *semantics* stay provider-defined.

/** Route line of a captured exchange — enough to pick a parser. */
export interface TrafficRoute {
  method: string;
  path: string;
}

/** One upstream attempt inside an exchange (failover hops). */
export interface TrafficAttempt {
  accountId: string;
  status: number | string;
}

/**
 * A captured request/response exchange handed to a provider parser.
 * Structural on purpose: the proxy's stored entry satisfies this directly,
 * so parsers never import adapter internals.
 */
export interface TrafficExchange extends TrafficRoute {
  ts: string;
  status: number;
  ms: number;
  /** Account whose token served the response, or null when none did. */
  accountId: string | null;
  reqBytes: number;
  resBytes: number;
  attempts: TrafficAttempt[];
  error?: string;
  profile?: string;
  /**
   * Request facts parsed from the FULL body before truncation (small and
   * bounded). Present even when reqBody holds only the kept head.
   */
  request?: TrafficRequestSummary | null;
  reqBody?: string;
  reqBodyTruncated?: boolean;
  resBody?: string;
  resBodyTruncated?: boolean;
}

export interface TrafficMessagePreview {
  role: string;
  /** Readable excerpt of the message (text joined, tool/image blocks noted). */
  preview: string;
  truncated: boolean;
  /** Longer excerpt for expand-in-place (capped, may equal preview). */
  full?: string;
  fullTruncated?: boolean;
}

/**
 * What a turn is doing inside a workflow run. Most turns are lead turns
 * (null role); providers mark the exceptions — safety screens, subagent
 * launches — so inspection can tell a workflow apart from plain prompting.
 */
export interface TrafficRole {
  kind: "policy-check" | "agent-launch";
  /** Subagent type for launches, screen stage for policy checks. */
  detail?: string;
}

export interface TrafficToolCall {
  name: string;
  /** Provider tool-use id (e.g. toolu_…), when the format carries one. */
  id?: string;
  /** Truncated JSON input the assistant passed to the tool. */
  input?: string;
  inputTruncated?: boolean;
  /**
   * One-line human reading of the input (e.g. `$ ls -la`, `src/app.ts`).
   * Providers that know a tool's input shape set this; the UI shows it
   * instead of the raw JSON blob.
   */
  summary?: string;
}

export interface TrafficRequestSummary {
  model?: string;
  messageCount?: number;
  /** Excerpts of the leading messages, oldest first. */
  messages?: TrafficMessagePreview[];
  messagesTruncated?: boolean;
  systemChars?: number;
  systemPreview?: string;
  toolCount?: number;
  toolNames?: string[];
  maxTokens?: number;
  stream?: boolean;
  approxInputTokens?: number;
  /** Messages/blocks tagged with cache_control (reusable prefix markers). */
  cacheBreakpoints?: number;
  /** tool_result blocks echoed back (conversation history). */
  toolResultCount?: number;
  /** ...of which flagged is_error. */
  toolResultErrors?: number;
  /**
   * Provider tool-use ids seen in this request (tool_use block ids and
   * tool_result references, capped). Opaque conversation-link keys: chained
   * turns echo prior ids back, so entries sharing one belong together.
   */
  toolUseIds?: string[];
}

export interface TrafficContentBlockCount {
  type: string;
  count: number;
}

export interface TrafficResponseSummary {
  kind: "sse-stream" | "json" | "empty" | "error" | "text";
  /** Event-type tallies for SSE streams, most frequent first. */
  events?: { type: string; count: number }[];
  model?: string;
  /** Provider message id, when the wire format carries one. */
  messageId?: string;
  inputTokens?: number;
  /** Prompt-cache tokens (the bulk of Claude Code traffic). */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /** input + cache creation + cache read. */
  totalInputTokens?: number;
  outputTokens?: number;
  /** Cache-aware one-liner, e.g. "57,214 in (57,180 cached) / 850 out". */
  usageLine?: string;
  stopReason?: string;
  errorMessage?: string;
  /** Saw a terminal marker (message_stop, [DONE], or a complete JSON body). */
  complete: boolean;
  /** One-line shape note for non-message JSON (e.g. a model list). */
  detail?: string;
  /** Display names for data-array entries (model ids, ...), first few. */
  items?: string[];
  /** True when items holds only the leading entries. */
  itemsTruncated?: boolean;
  /** Full data-array length. */
  totalItems?: number;
  /** Concatenated reply text (stream deltas or content blocks). */
  textPreview?: string;
  textTruncated?: boolean;
  /** Tool names the reply tried to use. */
  toolUses?: string[];
  /** Structured tool calls with input previews (capped). */
  toolCalls?: TrafficToolCall[];
  /** Private-reasoning volume, when the format exposes it. */
  thinkingChars?: number;
  thinkingBlocks?: number;
  /** Reply composition by content-block type, in first-seen order. */
  contentBlocks?: TrafficContentBlockCount[];
  /** Serving tier / region, when the format reports them. */
  serviceTier?: string;
  inferenceGeo?: string;
  /** Server-side iterations reported inside usage, when present. */
  serverIterations?: number;
}

export interface TrafficSummary {
  request: TrafficRequestSummary | null;
  response: TrafficResponseSummary | null;
  /** Plain-English bullets explaining what happened, in order. */
  explanation: string[];
  /** Workflow role of this turn, when the provider marks one. */
  role?: TrafficRole;
  /**
   * One-line verdict, rendered as the detail headline (e.g. "Replied after
   * 2 tool calls · input mostly reused from cache"). Providers put the
   * conclusion here; explanation holds the supporting evidence.
   */
  headline?: string;
}

/**
 * Port: one AI provider's reading of its own wire format.
 * Implemented per provider in adapters; the proxy and the web UI only ever
 * touch this interface, never provider-specific shapes.
 */
export interface TrafficParser {
  /** Provider id this parser explains (matches ProviderPort.id). */
  readonly providerId: string;
  /** Upstream name for proxy routing prose, e.g. "Anthropic". */
  readonly upstreamName?: string;
  /** True when this parser owns the route (checked in registry order). */
  canParse(route: TrafficRoute): boolean;
  /**
   * Parse a COMPLETE request body. The proxy calls this on the full buffered
   * body before truncation, so large requests still yield complete facts even
   * though only the head of the raw body is kept.
   */
  parseRequestBody(text: string, reqBytes: number): TrafficRequestSummary | null;
  /** Explain one captured exchange (request + response + bullets). */
  summarize(exchange: TrafficExchange): TrafficSummary;
  /**
   * Opaque keys linking the turns of one workflow run. Fine-grained keys
   * (e.g. tool-use ids echoed across requests) chain follow-up turns;
   * run-scoped keys (e.g. a CLI session id stamped on every request) pull
   * in satellites like safety screens that share no tool ids. Entries
   * sharing a key belong together; the proxy groups by these without
   * understanding any wire format. Optional: parsers without chaining omit
   * it and every entry stands alone.
   */
  conversationKeys?(exchange: TrafficExchange): string[];
  /**
   * Workflow role of one turn (policy screen, subagent launch). Optional:
   * unmarked turns render as ordinary lead turns.
   */
  trafficRole?(exchange: TrafficExchange): TrafficRole | null;
}
