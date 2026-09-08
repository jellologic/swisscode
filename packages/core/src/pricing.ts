// Estimated spend over stored proxy traffic. Prices are static USD-per-1M-token
// estimates (input, output) — not bills: subscription traffic does not meter
// per token, cached/discounted traffic prices differently, and any static table
// goes stale. Unknown models and token-blind rows price as undefined and are
// counted, never silently folded into $0. Every surface renders
// SPEND_ESTIMATE_NOTE next to a figure.

import { BASE_ROUTE_KEY, UNATTRIBUTED_PROFILE_KEY } from "./trafficLog.js";
import type { StoredTrafficExchange, TrafficRollupGrain, TrafficRollupRow } from "./trafficLog.js";

/** USD per 1M tokens: what the provider publishes for on-demand traffic. */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * Static estimate table, checked 2026-09-08 against published Anthropic
 * pricing. Update values (and add ids) as providers publish changes; ids the
 * proxy never sees (in-session aliases) are deliberately absent.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-4-1": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-opus-4": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-sonnet-4-5": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-sonnet-4": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
  "claude-haiku-4": { inputPerMTok: 1, outputPerMTok: 5 },
};

/** Caveat every surface prints next to a spend figure. */
export const SPEND_ESTIMATE_NOTE = "Estimated spend, not a bill — subscriptions don't meter per token.";

const SPEND_SCALE = 1_000_000;

/**
 * Price for a model id: exact hit first, then the segment after the last "/"
 * (OpenRouter-style `anthropic/claude-sonnet-4-5`). Undefined = unpriceable,
 * never $0 by default.
 */
export function priceForModel(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const id = model.trim();
  if (!id) return undefined;
  const exact = MODEL_PRICES[id];
  if (exact) return exact;
  const slash = id.lastIndexOf("/");
  if (slash >= 0) {
    const suffix = MODEL_PRICES[id.slice(slash + 1)];
    if (suffix) return suffix;
  }
  return undefined;
}

/** Facts spend needs from an exchange — a subset StoredTrafficExchange satisfies. */
export type SpendableExchange = Pick<
  StoredTrafficExchange,
  "model" | "upstreamModel" | "reqTokens" | "resTokens"
>;

/**
 * Estimated USD for one exchange, priced on the model actually sent upstream.
 * Undefined when the model is unknown OR the row reported no usage (mirrors
 * the rollup rule: token-blind rows add nothing instead of poisoning the sum).
 */
export function estimateExchangeSpend(exchange: SpendableExchange): number | undefined {
  if (exchange.reqTokens === undefined && exchange.resTokens === undefined) return undefined;
  const price = priceForModel(exchange.upstreamModel ?? exchange.model);
  if (!price) return undefined;
  return (
    ((exchange.reqTokens ?? 0) * price.inputPerMTok +
      (exchange.resTokens ?? 0) * price.outputPerMTok) /
    SPEND_SCALE
  );
}

export interface SpendRow {
  key: string;
  requests: number;
  estSpendUsd: number;
  /** Requests with a computed figure (including $0 from zero-token rows). */
  pricedRequests: number;
  /** Requests carrying tokens no known model prices. */
  unpricedRequests: number;
}

/** Grouping keys identical to rollupExchanges, so spend joins rollup rows. */
function spendKey(
  entry: Pick<StoredTrafficExchange, "profile" | "route" | "ts">,
  grain: TrafficRollupGrain,
): string {
  return grain === "profile"
    ? (entry.profile ?? UNATTRIBUTED_PROFILE_KEY)
    : grain === "route"
      ? (entry.route ?? BASE_ROUTE_KEY)
      : entry.ts.slice(0, 10);
}

/** Per-key estimated spend over an entry array. */
export function spendRollup(
  entries: Pick<StoredTrafficExchange, "profile" | "route" | "ts" | "model" | "upstreamModel" | "reqTokens" | "resTokens">[],
  grain: TrafficRollupGrain,
): SpendRow[] {
  const groups = new Map<string, { requests: number; spend: number; priced: number; unpriced: number }>();
  for (const entry of entries) {
    const key = spendKey(entry, grain);
    let group = groups.get(key);
    if (!group) {
      group = { requests: 0, spend: 0, priced: 0, unpriced: 0 };
      groups.set(key, group);
    }
    group.requests += 1;
    const spend = estimateExchangeSpend(entry);
    if (spend !== undefined) {
      group.spend += spend;
      group.priced += 1;
    } else if (entry.reqTokens !== undefined || entry.resTokens !== undefined) {
      group.unpriced += 1;
    }
  }
  const rows: SpendRow[] = [...groups.entries()].map(([key, group]) => ({
    key,
    requests: group.requests,
    estSpendUsd: group.spend,
    pricedRequests: group.priced,
    unpricedRequests: group.unpriced,
  }));
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}

/** Whole-selection spend as one row (joins rollupTotal the way rollups join). */
export function spendTotal(
  entries: Pick<StoredTrafficExchange, "profile" | "route" | "ts" | "model" | "upstreamModel" | "reqTokens" | "resTokens">[],
): SpendRow {
  const total: SpendRow = { key: "total", requests: 0, estSpendUsd: 0, pricedRequests: 0, unpricedRequests: 0 };
  for (const entry of entries) {
    total.requests += 1;
    const spend = estimateExchangeSpend(entry);
    if (spend !== undefined) {
      total.estSpendUsd += spend;
      total.pricedRequests += 1;
    } else if (entry.reqTokens !== undefined || entry.resTokens !== undefined) {
      total.unpricedRequests += 1;
    }
  }
  return total;
}

/** Small USD figures that stay readable ($0.0042, not $0.00). */
export function formatSpend(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

export interface SuggestInsightsOptions {
  /** Route `match` ids the profile configures — observed rows join by key. */
  configuredRoutes?: string[];
  /** Window label callers prepend ("this week", "last 30 days"). */
  windowLabel?: string;
}

/**
 * Read-only route suggestions over rollup rows + a spend lookup. Pure copy,
 * no auto-action: callers render the strings next to the estimates caveat.
 */
export function suggestInsights(
  rows: TrafficRollupRow[],
  spendByKey: Record<string, number>,
  options: SuggestInsightsOptions = {},
): string[] {
  const window = options.windowLabel ? ` ${options.windowLabel}` : "";
  const tips: string[] = [];
  const priced = rows.filter((r) => (spendByKey[r.key] ?? 0) > 0);
  if (priced.length > 0) {
    const top = priced.reduce((a, b) => ((spendByKey[b.key] ?? 0) > (spendByKey[a.key] ?? 0) ? b : a));
    const tokens = top.reqTokens + top.resTokens;
    tips.push(
      `\`${top.key}\` burned ≈${formatSpend(spendByKey[top.key] ?? 0)}${window} — ` +
        `${top.requests} request${top.requests === 1 ? "" : "s"}, ${tokens.toLocaleString()} tokens.`,
    );
  }
  for (const route of options.configuredRoutes ?? []) {
    const observed = rows.find((r) => r.key === route);
    if (!observed || observed.requests === 0) {
      tips.push(`\`${route}\` saw no traffic${window} — spare capacity or a match that never fires?`);
    }
  }
  for (const row of rows) {
    if (row.errors > 0 && row.errorRate >= 0.5) {
      tips.push(
        `\`${row.key}\` errored ${row.errors} of ${row.requests} request${row.requests === 1 ? "" : "s"}${window} — check the route's account.`,
      );
    }
  }
  if (rows.some((r) => r.reqTokens + r.resTokens > 0 && !((spendByKey[r.key] ?? 0) > 0))) {
    tips.push("Some usage couldn't be priced (unknown model) — treat figures as estimates.");
  }
  return tips.slice(0, 6);
}
