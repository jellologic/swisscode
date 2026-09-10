// Queryable traffic store: the SQLite index over the proxy's redacted
// entries. The JSONL firehose stays the raw record (with capped bodies); this
// store keeps scalar facts only — no bodies, never headers/tokens — so every
// reporting surface (CLI `proxy report`, web `/proxy`, `show` spend lines)
// asks the same questions through the core `TrafficLog` port.
//
// `node:sqlite` is imported dynamically inside `openTrafficStore`, so processes
// that never open the store (every non-report CLI command) never pay its
// ExperimentalWarning. Bun has no `node:sqlite`, so under Bun the same call
// falls back to `bun:sqlite` (Database/exec/query/run/all/close all line up
// with the surface this store uses). Engines require Node ≥22; the store
// itself needs Node 22.5+ (or Bun) and says so plainly when both imports fail.

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { rollupExchanges } from "@swisscode/core";
import type {
  StoredTrafficExchange,
  TrafficFilter,
  TrafficLog,
  TrafficParser,
  TrafficRollupGrain,
  TrafficRollupRow,
} from "@swisscode/core";
import { defaultTrafficParsers } from "../registry.js";
import { summarizeTrafficEntry } from "./trafficSummary.js";
import type { ProxyTrafficEntry } from "./server.js";

type DatabaseSync = import("node:sqlite").DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exchanges(
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  profile TEXT,
  route TEXT,
  account_id TEXT,
  model TEXT,
  upstream_model TEXT,
  status INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  req_tokens INTEGER,
  res_tokens INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_exchanges_ts ON exchanges(ts);
CREATE INDEX IF NOT EXISTS idx_exchanges_profile_ts ON exchanges(profile, ts);
CREATE TABLE IF NOT EXISTS attempts(
  exchange_id TEXT NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY(exchange_id, ord)
);`;

export interface TrafficStoreOptions {
  /** Days of history to keep (default 30, 0 = unbounded). Env: SWISSCODE_TRAFFIC_STORE_DAYS. */
  maxDays?: number;
  /** Newest rows to keep (default 100000, 0 = unbounded). Env: SWISSCODE_TRAFFIC_STORE_ROWS. */
  maxRows?: number;
  /** Provider parsers for response-usage reading (default: built-ins). */
  parsers?: TrafficParser[];
}

const DEFAULT_MAX_DAYS = 30;
const DEFAULT_MAX_ROWS = 100_000;
/** Prune at most this often — every request must stay a cheap fire-and-forget. */
const PRUNE_EVERY_N_APPENDS = 100;
/** Default cap for list queries (0 or negative = unlimited). Rollups always read uncapped. */
const DEFAULT_QUERY_LIMIT = 5000;

function envBound(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Map a captured entry onto storable facts. Redaction is by construction:
 * only named scalar fields cross this boundary — bodies, headers, and raw
 * credentials cannot leak because they are never selected. Usage comes from
 * the provider parser's response reading (authoritative when the body carried
 * it), falling back to the request's approximate input count.
 */
export function toStoredExchange(
  entry: ProxyTrafficEntry,
  parsers: TrafficParser[] = defaultTrafficParsers(),
): StoredTrafficExchange {
  let response: { totalInputTokens?: number; inputTokens?: number; outputTokens?: number } | null =
    null;
  try {
    response = summarizeTrafficEntry(entry, parsers).response;
  } catch {
    // A parser must never break the insert path — tokens stay unknown.
  }
  return {
    id: entry.id ?? randomUUID(),
    ts: entry.ts,
    profile: entry.profile,
    route: entry.route,
    accountId: entry.accountId,
    model: entry.request?.model ?? entry.upstreamModel,
    upstreamModel: entry.upstreamModel,
    status: entry.status,
    ms: entry.ms,
    reqTokens: response?.totalInputTokens ?? response?.inputTokens ?? entry.request?.approxInputTokens,
    resTokens: response?.outputTokens,
    error: entry.error,
    attempts: entry.attempts.map((a) => ({ accountId: a.accountId, status: a.status })),
  };
}

interface ExchangeRow {
  id: string;
  ts: string;
  profile: string | null;
  route: string | null;
  account_id: string | null;
  model: string | null;
  upstream_model: string | null;
  status: number;
  ms: number;
  req_tokens: number | null;
  res_tokens: number | null;
  error: string | null;
}

interface AttemptRow {
  exchange_id: string;
  ord: number;
  account_id: string;
  status: string;
}

/** The shared core predicate, rendered in SQL (mirrors matchTrafficFilter). */
function exchangeWhere(filter: TrafficFilter): { where: string; params: (string | number | null)[] } {
  const clauses: string[] = [];
  const params: (string | number | null)[] = [];
  if (filter.profile !== undefined) {
    clauses.push("profile = ?");
    params.push(filter.profile);
  }
  if (filter.route !== undefined) {
    clauses.push("route = ?");
    params.push(filter.route);
  }
  if (filter.account !== undefined) {
    clauses.push("account_id = ?");
    params.push(filter.account);
  }
  if (filter.model !== undefined) {
    clauses.push("(model = ? OR upstream_model = ?)");
    params.push(filter.model, filter.model);
  }
  if (filter.since !== undefined) {
    clauses.push("ts >= ?");
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    clauses.push("ts < ?");
    params.push(filter.until);
  }
  if (filter.errorsOnly === true) {
    clauses.push("(status >= 400 OR error IS NOT NULL)");
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

/** Attempt statuses round-trip as TEXT; restore numbers on read. */
function numericStatus(status: string): number | string {
  return /^\d+$/.test(status) ? parseInt(status, 10) : status;
}

export class SqliteTrafficLog implements TrafficLog {
  private appends = 0;

  constructor(
    private readonly db: DatabaseSync,
    private readonly opts: { maxDays: number; maxRows: number },
  ) {}

  async append(entry: StoredTrafficExchange): Promise<void> {
    // One transaction: an exchange without its hops (or vice versa) would lie.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO exchanges(
            id, ts, profile, route, account_id, model, upstream_model,
            status, ms, req_tokens, res_tokens, error
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          entry.id,
          entry.ts,
          entry.profile ?? null,
          entry.route ?? null,
          entry.accountId ?? null,
          entry.model ?? null,
          entry.upstreamModel ?? null,
          entry.status,
          entry.ms,
          entry.reqTokens ?? null,
          entry.resTokens ?? null,
          entry.error ?? null,
        );
      const deleteHops = this.db.prepare("DELETE FROM attempts WHERE exchange_id = ?");
      const insertHop = this.db.prepare(
        "INSERT OR REPLACE INTO attempts(exchange_id, ord, account_id, status) VALUES(?, ?, ?, ?)",
      );
      deleteHops.run(entry.id);
      (entry.attempts ?? []).forEach((attempt, ord) => {
        insertHop.run(entry.id, ord, attempt.accountId, String(attempt.status));
      });
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already unwound — the original error is what matters.
      }
      throw err;
    }
    this.appends += 1;
    if (this.appends % PRUNE_EVERY_N_APPENDS === 0) this.prune();
  }

  /**
   * Enforce the retention bounds — 0 on either dimension means unbounded.
   * Hop rows go first, explicitly: the cascade would handle them, but an
   * orphaned hop would lie about failover history, so don't rely on pragmas.
   */
  private prune(): void {
    const { maxDays, maxRows } = this.opts;
    if (maxDays > 0) {
      // Entries stamp ISO UTC timestamps, which order lexicographically.
      const cutoff = new Date(Date.now() - maxDays * 86_400_000).toISOString();
      this.db
        .prepare("DELETE FROM attempts WHERE exchange_id IN (SELECT id FROM exchanges WHERE ts < ?)")
        .run(cutoff);
      this.db.prepare("DELETE FROM exchanges WHERE ts < ?").run(cutoff);
    }
    if (maxRows > 0) {
      this.db
        .prepare(
          `DELETE FROM attempts WHERE exchange_id IN (
             SELECT id FROM exchanges ORDER BY ts DESC, id DESC LIMIT -1 OFFSET ?)`,
        )
        .run(maxRows);
      this.db
        .prepare(
          `DELETE FROM exchanges WHERE id NOT IN (
             SELECT id FROM exchanges ORDER BY ts DESC, id DESC LIMIT ?)`,
        )
        .run(maxRows);
    }
  }

  async query(filter: TrafficFilter): Promise<StoredTrafficExchange[]> {
    const { where, params } = exchangeWhere(filter);
    const limit = filter.limit === undefined ? DEFAULT_QUERY_LIMIT : filter.limit;
    const rows = (
      this.db
        .prepare(
          `SELECT id, ts, profile, route, account_id, model, upstream_model,
            status, ms, req_tokens, res_tokens, error
           FROM exchanges ${where} ORDER BY ts ASC, id ASC${limit > 0 ? " LIMIT ?" : ""}`,
        )
        .all(...params, ...(limit > 0 ? [limit] : [])) as unknown as ExchangeRow[]
    );
    if (rows.length === 0) return [];
    const hops = (
      this.db
        .prepare(
          `SELECT exchange_id, ord, account_id, status FROM attempts
           WHERE exchange_id IN (${rows.map(() => "?").join(",")}) ORDER BY ord ASC`,
        )
        .all(...rows.map((r) => r.id)) as unknown as AttemptRow[]
    );
    const byExchange = new Map<string, { accountId: string; status: number | string }[]>();
    for (const hop of hops) {
      const list = byExchange.get(hop.exchange_id);
      const attempt = { accountId: hop.account_id, status: numericStatus(hop.status) };
      if (list) list.push(attempt);
      else byExchange.set(hop.exchange_id, [attempt]);
    }
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      profile: r.profile ?? undefined,
      route: r.route ?? undefined,
      accountId: r.account_id,
      model: r.model ?? undefined,
      upstreamModel: r.upstream_model ?? undefined,
      status: r.status,
      ms: r.ms,
      reqTokens: r.req_tokens ?? undefined,
      resTokens: r.res_tokens ?? undefined,
      error: r.error ?? undefined,
      attempts: byExchange.get(r.id) ?? [],
    }));
  }

  async rollup(filter: TrafficFilter, grain: TrafficRollupGrain): Promise<TrafficRollupRow[]> {
    // One code path for rollup semantics everywhere: the core pure helper over
    // the same filtered rows (uncapped — a list limit must never shrink a total).
    return rollupExchanges(await this.query({ ...filter, limit: 0 }), grain);
  }

  close(): void {
    this.db.close();
  }
}

export async function openTrafficStore(
  path: string,
  opts: TrafficStoreOptions = {},
): Promise<SqliteTrafficLog> {
  await mkdir(dirname(path), { recursive: true });
  const db = await openDatabase(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return new SqliteTrafficLog(db, {
    maxDays: opts.maxDays ?? envBound("SWISSCODE_TRAFFIC_STORE_DAYS", DEFAULT_MAX_DAYS),
    maxRows: opts.maxRows ?? envBound("SWISSCODE_TRAFFIC_STORE_ROWS", DEFAULT_MAX_ROWS),
  });
}

/** Open the SQLite file through `node:sqlite`, or `bun:sqlite` under Bun. */
async function openDatabase(path: string): Promise<DatabaseSync> {
  try {
    return new (await import("node:sqlite")).DatabaseSync(path);
  } catch {
    // Not Node 22.5+ (or a runtime without `node:sqlite`, like Bun) — try
    // Bun's own sqlite build before giving up.
  }
  try {
    // A `string`-typed specifier keeps tsc green without @types/bun: a
    // literal `import("bun:sqlite")` would fail type resolution on Node.
    const specifier: string = "bun:sqlite";
    const bun = (await import(specifier)) as unknown as {
      Database: new (path: string) => {
        exec(sql: string): void;
        query(sql: string): {
          run(...params: unknown[]): unknown;
          all(...params: unknown[]): unknown[];
        };
        close(): void;
      };
    };
    // Bun speaks query/run/all where node:sqlite speaks prepare/run/all; the
    // store only touches exec/prepare→{run,all}/close, so adapt that slice.
    const inner = new bun.Database(path);
    return {
      exec: (sql: string) => {
        inner.exec(sql);
      },
      prepare: (sql: string) => {
        const stmt = inner.query(sql);
        return {
          run: (...params: unknown[]) => stmt.run(...params),
          all: (...params: unknown[]) => stmt.all(...params),
        };
      },
      close: () => {
        inner.close();
      },
    } as unknown as DatabaseSync;
  } catch {
    throw new Error(
      "The queryable traffic store needs Node 22.5 or newer (node:sqlite) or Bun (bun:sqlite). " +
        "The JSONL traffic log is unaffected.",
    );
  }
}
