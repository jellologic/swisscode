// Adapter: one reading of the HTTP `Retry-After` header.
//
// Two callers act on it — the usage client (backs off a 429) and the proxy
// (cools an account down after 429/529) — and they used to parse it
// differently: `Number.parseInt` accepted "12abc" as twelve seconds while
// `Number` rejected it, so the same response produced a 12s cooldown in one
// place and "unparseable" in the other. `Number` wins: a header that is not
// exactly a delta-seconds value is not a delta-seconds value.

/**
 * Ceiling for a server-sent Retry-After. The header feeds a cooldown that
 * suppresses every later request, so an hour (or a bogus 86400) would look
 * exactly like "this account is permanently broken" to the user, with no way
 * out but deleting the cache file. 15 minutes is long enough to stop a
 * hammering loop and short enough that a wrong value self-heals.
 */
export const MAX_RETRY_AFTER_MS = 15 * 60 * 1000;

export interface ParseRetryAfterOptions {
  /** Upper bound on the returned delay. Default {@link MAX_RETRY_AFTER_MS}. */
  max?: number;
  /** Clock, for the HTTP-date form. Injectable so tests need no real time. */
  now?: () => number;
}

/**
 * Milliseconds to wait, from a `Retry-After` value in either RFC 9110 form
 * (delta-seconds or an HTTP-date). Undefined when the header is absent or is
 * neither form — the caller owns the default, because "no advice" and "wait
 * zero" are different answers.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  opts: ParseRetryAfterOptions = {},
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const max = opts.max ?? MAX_RETRY_AFTER_MS;
  const raw = value.trim();
  if (raw === "") return undefined;
  const clamp = (ms: number): number => (Number.isFinite(ms) ? Math.min(max, Math.max(0, ms)) : max);
  // Number (not parseInt): "12abc" is a malformed header, not 12 seconds.
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return clamp(seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return clamp(date - (opts.now?.() ?? Date.now()));
  return undefined;
}
