// Proxy layer: compose a provider parser's reading with proxy-owned routing.
// The proxy never interprets wire formats — it picks the provider parser
// that claimed the route (stamped as entry.providerId at capture), falls
// back to a shape-only summary for unknown routes, and splices in the one
// bullet only the proxy can write: which account served the request.
// No I/O, no secrets — safe to run anywhere (tested with node:test).

import type {
  TrafficExchange,
  TrafficParser,
  TrafficResponseSummary,
  TrafficSummary,
} from "@swisscode/core";
import type { ProxyTrafficEntry } from "./server.js";
import { defaultTrafficParsers } from "../registry.js";
import {
  approxTokens,
  asRecord,
  asString,
  describeJsonShape,
  listItems,
  looksLikeSse,
  safeJsonParse,
  splitSsePayloads,
  tallyNames,
} from "./trafficKit.js";

// Summary shapes now live on the core port contract; re-exported here so
// existing imports keep working.
export type {
  TrafficMessagePreview,
  TrafficRequestSummary,
  TrafficResponseSummary,
  TrafficSummary,
  TrafficToolCall,
} from "@swisscode/core";

/**
 * Back-compat: parse a complete request body with the Claude parser.
 * Prefer parser.parseRequestBody via the provider registry for new code.
 */
export function parseRequestJson(
  text: string,
  reqBytes: number,
): import("@swisscode/core").TrafficRequestSummary | null {
  const parsers = defaultTrafficParsers();
  const parser = parsers.find((p) => p.providerId === "claude-subscription");
  if (!parser) return { approxInputTokens: approxTokens(reqBytes) };
  return parser.parseRequestBody(text, reqBytes);
}

function fallbackResponse(entry: TrafficExchange): TrafficResponseSummary | null {
  if (entry.resBytes === 0) return { kind: "empty", complete: true };
  if (!entry.resBody) return null;
  if (looksLikeSse(entry.resBody)) {
    const names: string[] = [];
    let done = false;
    for (const payload of splitSsePayloads(entry.resBody)) {
      if (payload === "[DONE]") {
        done = true;
        continue;
      }
      const type = asString(asRecord(safeJsonParse(payload))?.["type"]);
      if (type) names.push(type);
    }
    if (names.length === 0 && !done) return { kind: "text", complete: false };
    return {
      kind: "sse-stream",
      events: tallyNames(names),
      complete: done,
    };
  }
  const parsed = safeJsonParse(entry.resBody);
  if (parsed === undefined) return { kind: "text", complete: false };
  const obj = asRecord(parsed);
  if (obj && asRecord(obj["error"])) {
    const err = asRecord(obj["error"])!;
    return {
      kind: "error",
      errorMessage: asString(err["message"]) ?? JSON.stringify(err).slice(0, 300),
      complete: true,
    };
  }
  if (obj && Array.isArray(obj["data"])) {
    return {
      kind: "json",
      complete: true,
      detail: describeJsonShape(parsed),
      ...listItems(obj["data"] as unknown[], 10),
    };
  }
  return { kind: "json", complete: true, detail: describeJsonShape(parsed) };
}

/**
 * Shape-only summary for routes no provider parser claimed. Renders raw
 * structure (event tallies, JSON shape) without pretending at semantics.
 */
function fallbackSummary(entry: TrafficExchange): TrafficSummary {
  const request = entry.request
    ? entry.request
    : entry.reqBody
      ? { approxInputTokens: approxTokens(entry.reqBytes) }
      : null;
  const response = fallbackResponse(entry);
  const explanation = [
    `No provider parser claimed ${entry.method} ${entry.path} — showing raw shape only, no provider reading.`,
  ];
  if (response?.kind === "sse-stream") {
    const total = response.events?.reduce((n, e) => n + e.count, 0) ?? 0;
    const types = response.events?.slice(0, 4).map((e) => `${e.type}×${e.count}`).join(", ");
    explanation.push(`Streamed ${total} events${types ? ` (${types})` : ""}.`);
  } else if (response?.kind === "json" && response.detail) {
    explanation.push(`JSON reply (${response.detail}).`);
  } else if (response?.kind === "error") {
    explanation.push(`Upstream rejected this request: ${response.errorMessage ?? "unknown error"}.`);
  }
  return { request, response, explanation };
}

/** The one bullet only the proxy can write: which account served it. */
function routingBullet(entry: TrafficExchange, upstream: string): string {
  const forProfile = entry.profile !== undefined ? ` for profile “${entry.profile}”` : "";
  if (entry.accountId) {
    const hops = entry.attempts.map((a) => `“${a.accountId}” → ${a.status}`).join(", ");
    if (entry.attempts.length > 1) {
      return (
        `The proxy tried ${entry.attempts.length} accounts in order (${hops}): an early account hit a limit, so it replayed the identical request${forProfile} on “${entry.accountId}”, which answered ${entry.status} in ${entry.ms}ms.`
      );
    }
    return `The proxy signed the request${forProfile} with “${entry.accountId}” and ${upstream} answered ${entry.status} in ${entry.ms}ms.`;
  }
  return (
    `No account could take this request${entry.error ? `: ${entry.error}` : ""} — it never went upstream.`
  );
}

/** One conversation: chained turns sharing provider link keys. */
export interface TrafficConversation {
  /**
   * Thread address: session id, first link key, or the lone entry's id —
   * always slug-shaped (see SAFE_ID_RE) and stable within one grouping.
   */
  id: string;
  /** Positions in the input array, chronological (oldest turn first). */
  indexes: number[];
  turns: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  models: string[];
  profiles: string[];
  tools: string[];
  statuses: number[];
  /** Wall span from first to last turn start. */
  spanMs: number;
  /** Summed upstream time across turns. */
  upstreamMs: number;
  /** Entry indexes of safety-screen satellites (not work turns). */
  policyChecks: number[];
  /** Subagent launches inside this run (entry index + agent type). */
  agentLaunches: { index: number; agent: string }[];
  /**
   * Local Claude Code session behind this run (from the provider's
   * `session:` link key). Unlocks on-disk context — transcript, workflow
   * scripts, subagent branches — via GET /__swisscode/session/<id>.
   */
  sessionId?: string;
}

// A conversation id is a route segment (/proxy/<id>) and the lookup key for
// on-disk session context, but its raw material — provider link keys — is
// client-supplied (Claude reads the session id out of request metadata). Ids
// that are not plain slugs get a synthetic id instead of a broken link.
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** First candidate safe to use as a thread address, else undefined. */
function safeThreadId(...candidates: (string | undefined)[]): string | undefined {
  return candidates.find((c): c is string => c !== undefined && SAFE_ID_RE.test(c));
}

function parserFor(
  entry: TrafficExchange & { providerId?: string },
  parsers: TrafficParser[],
): TrafficParser | undefined {
  if (entry.providerId !== undefined) {
    const stamped = parsers.find((p) => p.providerId === entry.providerId);
    if (stamped) return stamped;
  }
  return parsers.find((p) => p.canParse(entry));
}

/**
 * Group buffered entries into conversations. Each provider names opaque
 * link keys per entry (tool-use ids for Claude); entries sharing a key
 * merge transitively, keyless entries stand alone. Aggregates come from the
 * already-computed summaries, so grouping costs no re-parsing.
 */
export function groupTrafficConversations(
  items: { entry: TrafficExchange & { id?: string; providerId?: string }; summary: TrafficSummary }[],
  parsers: TrafficParser[] = defaultTrafficParsers(),
): TrafficConversation[] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[i] !== root) {
      const next = parent[i]!;
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const keyOwner = new Map<string, number>();
  const itemKeys = items.map(({ entry }) => {
    const parser = parserFor(entry, parsers);
    const keys = parser?.conversationKeys?.(entry) ?? [];
    return [...new Set(keys)].slice(0, 32);
  });
  itemKeys.forEach((keys, i) => {
    for (const key of keys) {
      const owner = keyOwner.get(key);
      if (owner === undefined) {
        keyOwner.set(key, find(i));
      } else {
        const a = find(i);
        const b = find(owner);
        if (a !== b) parent[a] = b;
        keyOwner.set(key, find(i));
      }
    }
  });
  const members = new Map<number, number[]>();
  items.forEach((_, i) => {
    const root = find(i);
    const list = members.get(root) ?? [];
    list.push(i);
    members.set(root, list);
  });
  const groups: TrafficConversation[] = [];
  for (const indexes of members.values()) {
    // Chronological: oldest turn first, regardless of buffer order.
    indexes.sort((a, b) => {
      const byTs =
        Date.parse(items[a]!.entry.ts) - Date.parse(items[b]!.entry.ts);
      return Number.isFinite(byTs) && byTs !== 0 ? byTs : a - b;
    });
    const firstKeys = itemKeys[indexes[0]!]!;
    // The session key may arrive on any turn (policy screens carry only it,
    // work turns carry it alongside tool keys), so scan the whole group.
    const sessionKey = indexes
      .flatMap((i) => itemKeys[i]!)
      .find((k) => k.startsWith("session:"));
    // Only a slug-shaped session id becomes an address: anything else can
    // neither name a route nor resolve to a local transcript.
    const sessionId =
      sessionKey !== undefined ? safeThreadId(sessionKey.slice("session:".length)) : undefined;
    const conv: TrafficConversation = {
      // Thread address: session runs are the raw session (resume) id so the
      // thread page lives at /proxy/<sessionId>; linked runs use their first
      // key; keyless solos fall back to the entry id; anything unsafe falls
      // back to the group's position, which is unique within one grouping.
      id:
        sessionId ??
        safeThreadId(
          firstKeys.length > 0 ? `conv-${firstKeys[0]}` : undefined,
          items[indexes[0]!]!.entry.id,
        ) ??
        `thread-${indexes[0]}`,
      indexes,
      turns: indexes.length,
      models: [],
      profiles: [],
      tools: [],
      statuses: [],
      spanMs: 0,
      upstreamMs: 0,
      policyChecks: [],
      agentLaunches: [],
    };
    let input = 0;
    let output = 0;
    let read = 0;
    let creation = 0;
    let seenTokens = false;
    if (sessionId !== undefined) conv.sessionId = sessionId;
    let firstTs = Number.POSITIVE_INFINITY;
    let lastTs = 0;
    for (const i of indexes) {
      const { entry, summary } = items[i]!;
      const role = summary.role;
      if (role?.kind === "policy-check") conv.policyChecks.push(i);
      if (role?.kind === "agent-launch") {
        conv.agentLaunches.push({ index: i, agent: role.detail ?? "subagent" });
      }
      const res = summary.response;
      if (res?.totalInputTokens !== undefined || res?.outputTokens !== undefined) {
        seenTokens = true;
        input += res?.totalInputTokens ?? res?.inputTokens ?? 0;
        output += res?.outputTokens ?? 0;
        read += res?.cacheReadInputTokens ?? 0;
        creation += res?.cacheCreationInputTokens ?? 0;
      }
      const model = summary.request?.model ?? res?.model;
      if (model && !conv.models.includes(model)) conv.models.push(model);
      if (entry.profile && !conv.profiles.includes(entry.profile)) {
        conv.profiles.push(entry.profile);
      }
      for (const t of [
        ...(summary.request?.toolNames ?? []),
        ...(res?.toolUses ?? []),
      ]) {
        if (!conv.tools.includes(t)) conv.tools.push(t);
      }
      if (typeof entry.status === "number" && !conv.statuses.includes(entry.status)) {
        conv.statuses.push(entry.status);
      }
      const ts = Date.parse(entry.ts);
      if (Number.isFinite(ts)) {
        firstTs = Math.min(firstTs, ts);
        lastTs = Math.max(lastTs, ts);
      }
      conv.upstreamMs += entry.ms;
    }
    if (seenTokens) {
      conv.totalInputTokens = input;
      conv.totalOutputTokens = output;
      if (read > 0) conv.cacheReadInputTokens = read;
      if (creation > 0) conv.cacheCreationInputTokens = creation;
    }
    if (lastTs >= firstTs && Number.isFinite(firstTs)) conv.spanMs = lastTs - firstTs;
    groups.push(conv);
  }
  return groups;
}

/**
 * Explain one buffered entry: the owning provider reads the exchange, the
 * proxy splices its routing bullet into second place. Entries captured
 * before provider stamping (or on unknown routes) match by route, else get
 * the shape-only fallback.
 */
export function summarizeTrafficEntry(
  entry: ProxyTrafficEntry,
  parsers: TrafficParser[] = defaultTrafficParsers(),
): TrafficSummary {
  const parser = parserFor(entry, parsers);
  const inner = parser ? parser.summarize(entry) : fallbackSummary(entry);
  const upstream = parser?.upstreamName ?? "upstream";
  const routing = routingBullet(entry, upstream);
  if (entry.accountId === null) {
    // The proxy answered itself (no account served this): response-shape
    // bullets would mislead (e.g. "empty body, typical for preflight"), so
    // the explanation is just request → routing → proxy-itself.
    const head = inner.explanation.length > 0 ? [inner.explanation[0]] : [];
    // A self-answered status overrides any provider verdict.
    const headline = `Never reached ${upstream}: ${entry.error ?? `HTTP ${entry.status}`}`;
    return {
      request: inner.request,
      response: inner.response,
      explanation: [
        ...head,
        routing,
        `The ${entry.status} came from the proxy itself — ${upstream} never saw this request.`,
      ],
      ...(inner.role ? { role: inner.role } : {}),
      headline,
    };
  }
  const explanation =
    inner.explanation.length > 0
      ? [inner.explanation[0], routing, ...inner.explanation.slice(1)]
      : [routing];
  return {
    request: inner.request,
    response: inner.response,
    explanation,
    ...(inner.role ? { role: inner.role } : {}),
    ...(inner.headline ? { headline: inner.headline } : {}),
  };
}
