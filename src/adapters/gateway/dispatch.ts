// Retry and failover policy. Pure arithmetic and predicates — the decisions,
// not the requests.
//
// Split from server.ts on the same principle as the web feature, where routing
// lives in api.ts and only server.ts touches a socket: a policy you can test
// without a network is a policy that gets tested.

/**
 * Statuses worth trying again.
 *
 * 529 is Anthropic's "overloaded" and is the reason this gateway exists — it
 * arrived 33 times in four minutes on 2026-09-03 while a healthy second
 * provider sat idle. 429 is included, but see `isTerminalRateLimit`.
 */
const RETRYABLE = Object.freeze([408, 429, 500, 502, 503, 504, 529])

export function isRetryable(status: number): boolean {
  return RETRYABLE.includes(status)
}

/**
 * A 429 that will still be a 429 in an hour.
 *
 * A spend cap and a rate limit share a status code and mean opposite things:
 * one clears in seconds, the other needs a human with a credit card. Retrying
 * the second is pure latency. The signal is weak — no header distinguishes
 * them — so this reads the message rather than guessing, and errs toward
 * retrying when unsure.
 */
export function isTerminalRateLimit(body: string): boolean {
  return /insufficient|balance|quota|credit|recharge|billing|payment/i.test(body)
}

export type RetryPolicy = {
  /** Attempts against one route before moving to the next. */
  attempts: number
  baseDelayMs: number
  maxDelayMs: number
}

export const DEFAULT_POLICY: RetryPolicy = Object.freeze({
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
})

/**
 * How long to wait before the next attempt.
 *
 * A server that tells us when to come back beats any local guess, so
 * `retry-after` wins outright — in both its numeric-seconds and HTTP-date
 * forms. Otherwise exponential backoff with jitter, so that concurrent
 * requests do not all retry on the same tick and rebuild the thundering herd
 * the backoff exists to prevent.
 */
export function retryDelay(
  attempt: number,
  retryAfter: string | null,
  policy: RetryPolicy = DEFAULT_POLICY,
  random: () => number = Math.random,
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, policy.maxDelayMs)
    }
    const at = Date.parse(retryAfter)
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), policy.maxDelayMs)
  }
  const backoff = policy.baseDelayMs * 2 ** attempt
  return Math.min(backoff + random() * policy.baseDelayMs, policy.maxDelayMs)
}

/** Condense an upstream error body to one line worth logging. */
export function summarize(body: string): string {
  try {
    const error = (JSON.parse(body) as { error?: { type?: string; message?: string } }).error
    if (error) {
      const line = `${error.type ?? 'error'}: ${error.message ?? ''}`.trim()
      if (line !== 'error:') return line
    }
  } catch {
    // Not JSON. The raw excerpt below is more useful than a parse complaint.
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 300) || '(empty body)'
}
