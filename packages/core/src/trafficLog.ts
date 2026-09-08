// Queryable traffic reporting: pure filter/rollup language plus the
// `TrafficLog` port. Zero I/O — adapters implement the port against SQLite,
// and every surface (CLI `proxy report`, web `/proxy`, `show` spend lines)
// asks the same questions through it. Bodies, headers, and tokens never reach
// this layer: a stored exchange is scalar facts only, by construction.

/** Pure-data filter — every surface builds the same object. */
export interface TrafficFilter {
  profile?: string;
  route?: string;
  account?: string;
  model?: string;
  /** ISO timestamps: since inclusive, until exclusive. */
  since?: string;
  until?: string;
  /** status >= 400 or an error note — client aborts (499) count. */
  errorsOnly?: boolean;
  /** Row cap for list queries (default 5000, 0 = unlimited). */
  limit?: number;
}

/** Rollup dimensions. `day` keys are UTC `YYYY-MM-DD` slices of `ts`. */
export type TrafficRollupGrain = "profile" | "route" | "day";

export interface TrafficRollupRow {
  /** Profile name / route match / day; unattributed rows use the constants. */
  key: string;
  requests: number;
  errors: number;
  /** errors / requests, 0 when requests is 0. */
  errorRate: number;
  /** Nearest-rank percentiles over `ms`; 0 with no rows. */
  p50Ms: number;
  p95Ms: number;
  /** Sums over rows that reported usage — token-blind rows add nothing. */
  reqTokens: number;
  resTokens: number;
}

/** Key for exchanges no profile claimed (ambient/direct traffic). */
export const UNATTRIBUTED_PROFILE_KEY = "(unattributed)";
/** Key for requests the base provider served (no route matched). */
export const BASE_ROUTE_KEY = "(base)";

/**
 * One queryable exchange. The SQLite adapter maps the proxy's redacted entry
 * onto this; token counts come from the provider parser's response reading
 * and stay undefined when the (possibly truncated) body carried no usage.
 */
export interface StoredTrafficExchange {
  id: string;
  ts: string;
  profile?: string;
  route?: string;
  accountId?: string | null;
  model?: string;
  upstreamModel?: string;
  status: number;
  ms: number;
  reqTokens?: number;
  resTokens?: number;
  error?: string;
  /** Upstream attempts in order (failover hops) — ids and statuses only. */
  attempts?: { accountId: string; status: number | string }[];
}

/**
 * Port: append/query/rollup over stored exchanges. The adapter's `rollup`
 * must agree with `rollupExchanges` below — cheapest way to guarantee that is
 * `rollup = rollupExchanges(await query(filter))`, one code path everywhere.
 */
export interface TrafficLog {
  append(entry: StoredTrafficExchange): Promise<void>;
  query(filter: TrafficFilter): Promise<StoredTrafficExchange[]>;
  rollup(filter: TrafficFilter, grain: TrafficRollupGrain): Promise<TrafficRollupRow[]>;
}

/**
 * The shared predicate: SQLite implements it in SQL, JSONL readers (CLI
 * `proxy log`) apply it in memory — same questions, same answers, two
 * sources. `limit` is NOT applied here (sources cap after filtering).
 */
export function matchTrafficFilter(
  entry: Pick<
    StoredTrafficExchange,
    "profile" | "route" | "accountId" | "model" | "upstreamModel" | "ts" | "status" | "error"
  >,
  filter: TrafficFilter,
): boolean {
  if (filter.profile !== undefined && entry.profile !== filter.profile) return false;
  if (filter.route !== undefined && entry.route !== filter.route) return false;
  if (filter.account !== undefined && (entry.accountId ?? undefined) !== filter.account) return false;
  if (
    filter.model !== undefined &&
    entry.model !== filter.model &&
    entry.upstreamModel !== filter.model
  ) {
    return false;
  }
  if (filter.since !== undefined && entry.ts < filter.since) return false;
  if (filter.until !== undefined && !(entry.ts < filter.until)) return false;
  if (filter.errorsOnly === true && !(entry.status >= 400 || entry.error !== undefined)) return false;
  return true;
}

/** Pure rollup over an entry array — the semantics every adapter reuses. */
export function rollupExchanges(
  entries: StoredTrafficExchange[],
  grain: TrafficRollupGrain,
): TrafficRollupRow[] {
  const groups = new Map<string, StoredTrafficExchange[]>();
  for (const entry of entries) {
    const key =
      grain === "profile"
        ? (entry.profile ?? UNATTRIBUTED_PROFILE_KEY)
        : grain === "route"
          ? (entry.route ?? BASE_ROUTE_KEY)
          : entry.ts.slice(0, 10);
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const rows = [...groups.entries()].map(([key, group]) => rollupGroup(key, group));
  rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return rows;
}

/**
 * The whole selection as one row (the report summary cards). Same grouping
 * math as `rollupExchanges` — percentiles over the full sample, not folded
 * from per-group rows — so the cards can never disagree with the table.
 */
export function rollupTotal(entries: StoredTrafficExchange[]): TrafficRollupRow {
  return rollupGroup("total", entries);
}

function rollupGroup(key: string, group: StoredTrafficExchange[]): TrafficRollupRow {
  const latencies = group.map((e) => e.ms).sort((a, b) => a - b);
  let errors = 0;
  let reqTokens = 0;
  let resTokens = 0;
  for (const e of group) {
    if (e.status >= 400 || e.error !== undefined) errors += 1;
    reqTokens += e.reqTokens ?? 0;
    resTokens += e.resTokens ?? 0;
  }
  return {
    key,
    requests: group.length,
    errors,
    errorRate: group.length === 0 ? 0 : errors / group.length,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    reqTokens,
    resTokens,
  };
}

/** Nearest-rank percentile over an ascending-sorted sample. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0;
}
