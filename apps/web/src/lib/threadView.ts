// What the /proxy/$threadId page shows, decided in one pure place.
//
// The page polls every 2.5s over a ring buffer, so two things happen routinely
// that used to destroy it: the thread being read scrolls out of the buffer
// (the loader threw "Unknown thread" and the root error page replaced the
// article), and a poll fails or the proxy stops (the loader returned an empty
// list and the reader lost the page). Both are STATES here, and a poll that
// brings nothing back never overwrites data the reader is looking at.

import type { ProxyTrafficEntry, TrafficConversation, TrafficSummary } from "@swisscode/adapters";

/** A buffered entry plus its plain-English summary. */
export interface ProxyTrafficItem extends ProxyTrafficEntry {
  summary: TrafficSummary;
}

export interface ThreadView {
  /** False when the proxy could not be reached for this poll. */
  running: boolean;
  /** Null when the thread is not in the buffer (evicted, or never was). */
  conversation: TrafficConversation | null;
  /** The buffer snapshot the conversation's indexes point into. */
  entries: ProxyTrafficItem[];
}

export function findThread(
  conversations: readonly TrafficConversation[],
  threadId: string,
): TrafficConversation | null {
  return conversations.find((c) => c.id === threadId) ?? null;
}

/**
 * Ids of the entries this thread renders — the only ones worth asking the
 * proxy for bodies. Entries recorded before ids existed have none and stay
 * body-less rather than dragging the whole buffer along.
 */
export function threadEntryIds(
  entries: readonly ProxyTrafficItem[],
  conversation: TrafficConversation,
): string[] {
  const ids: string[] = [];
  for (const index of conversation.indexes) {
    const id = entries[index]?.id;
    if (id !== undefined && id !== "" && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Overlay the body-carrying copies onto the body-less snapshot, keeping the
 * array positions the conversation's indexes refer to. An entry that vanished
 * between the two calls keeps its body-less version.
 */
export function mergeEntryBodies(
  entries: readonly ProxyTrafficItem[],
  full: readonly ProxyTrafficItem[],
): ProxyTrafficItem[] {
  if (full.length === 0) return [...entries];
  const byId = new Map(full.filter((e) => e.id !== undefined).map((e) => [e.id as string, e]));
  return entries.map((entry) => (entry.id ? (byId.get(entry.id) ?? entry) : entry));
}

/** Token/model/tool facts a thread can state, recomputed from its own entries. */
export interface ThreadTotals {
  totalInputTokens?: number;
  totalOutputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  models: string[];
  tools: string[];
}

/**
 * Re-derive the thread header from the entries the page actually holds.
 *
 * The conversation arrives with the body-less list, so everything a response
 * body carries — tokens, tool calls, answering model — is missing from it.
 * This page fetched the real bodies for its own turns, so it can state those
 * numbers itself. Same accumulation as groupTrafficConversations, applied to
 * one thread.
 */
export function threadTotals(
  entries: readonly ProxyTrafficItem[],
  conversation: TrafficConversation,
): ThreadTotals {
  let input = 0;
  let output = 0;
  let read = 0;
  let creation = 0;
  let seenTokens = false;
  const models: string[] = [];
  const tools: string[] = [];
  for (const index of conversation.indexes) {
    const summary = entries[index]?.summary;
    if (!summary) continue;
    const res = summary.response;
    if (res?.totalInputTokens !== undefined || res?.outputTokens !== undefined) {
      seenTokens = true;
      input += res?.totalInputTokens ?? res?.inputTokens ?? 0;
      output += res?.outputTokens ?? 0;
      read += res?.cacheReadInputTokens ?? 0;
      creation += res?.cacheCreationInputTokens ?? 0;
    }
    const model = summary.request?.model ?? res?.model;
    if (model && !models.includes(model)) models.push(model);
    for (const tool of [...(summary.request?.toolNames ?? []), ...(res?.toolUses ?? [])]) {
      if (!tools.includes(tool)) tools.push(tool);
    }
  }
  // No entry reported tokens (bodies never arrived): keep whatever the
  // grouping already knew rather than claiming the thread used nothing.
  const tokens: Partial<ThreadTotals> = seenTokens
    ? {
        totalInputTokens: input,
        totalOutputTokens: output,
        ...(read > 0 ? { cacheReadInputTokens: read } : {}),
        ...(creation > 0 ? { cacheCreationInputTokens: creation } : {}),
      }
    : {
        ...(conversation.totalInputTokens === undefined
          ? {}
          : { totalInputTokens: conversation.totalInputTokens }),
        ...(conversation.totalOutputTokens === undefined
          ? {}
          : { totalOutputTokens: conversation.totalOutputTokens }),
        ...(conversation.cacheReadInputTokens === undefined
          ? {}
          : { cacheReadInputTokens: conversation.cacheReadInputTokens }),
        ...(conversation.cacheCreationInputTokens === undefined
          ? {}
          : { cacheCreationInputTokens: conversation.cacheCreationInputTokens }),
      };
  return {
    ...tokens,
    models: models.length > 0 ? models : [...conversation.models],
    tools: tools.length > 0 ? tools : [...conversation.tools],
  };
}

/**
 * Fold a poll result into what the reader already has.
 *  - fresh data with the thread in it always wins;
 *  - the proxy answering without the thread means it really is gone (show the
 *    "no longer buffered" state, do not pretend otherwise);
 *  - an unreachable proxy keeps the last good thread on screen, flagged, so a
 *    restart or a hiccup does not blank the page being read.
 */
export function keepLastGood<T extends ThreadView>(prev: T | null, next: T): T {
  if (next.conversation) return next;
  if (!prev?.conversation) return next;
  if (next.running) return next;
  return { ...prev, running: false };
}
