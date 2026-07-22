// Port: what a provider can tell you about your own remaining capacity.
//
// This is the "tools the AI provider gives us" half of the `usage` selection
// strategy, and it is CONFIGURATION-TIME ONLY. The launch path may not reach
// the network — test/architecture.test.ts bans fetch and node:http there by
// name — so nothing here is ever called during a launch. The doctor and the web
// UI call it, cache what it says, and `core/resolve.ts` reads that cache.
//
// Modelled on the Ollama introspection port in ports/doctor.ts: a small
// contract, an adapter only for providers whose endpoint has been VERIFIED
// against the live service, and `null` everywhere the fact is unknown. A
// provider that publishes nothing reports nothing rather than zero.
//
// Type-only, like every port: `export {}` at runtime.

/**
 * Remaining capacity for one account.
 *
 * EVERY FIELD IS NULLABLE and none is defaulted, because providers disagree
 * about what they publish and a missing figure is not a zero. An account on a
 * plan with no cap has a real `null` limit, which is a different fact from an
 * endpoint that declines to say.
 *
 * `remaining` is what `usage` selection ranks on. When it is null the account
 * is simply not a candidate — better to skip it than to invent a number and
 * route real money by it.
 */
export type ProviderUsage = {
  /** credits or budget left, in the provider's own unit; null = unknown or uncapped */
  remaining: number | null
  /** the cap `remaining` counts down from; null = unknown or uncapped */
  limit: number | null
  /** spent so far, if published */
  used: number | null
  /**
   * What the numbers are denominated in — 'usd', 'credits', 'tokens'. Free
   * text because it is for DISPLAY only; nothing branches on it, and inventing
   * an enum would force every future provider into one of today's guesses.
   */
  unit: string | null
  /** epoch ms when this was measured, so a consumer can say how stale it is */
  checkedAt: number
}

/**
 * A snapshot across accounts, which is what gets cached and what `resolve.ts`
 * consumes. Keyed by ACCOUNT name, not provider: two accounts on the same
 * provider have separate balances, and telling them apart is the entire reason
 * this strategy exists.
 */
export type UsageSnapshot = {
  remaining: Record<string, number>
  checkedAt: number
}

/**
 * One provider's usage endpoint.
 *
 * NEVER REJECTS, for the same reason the doctor's probe does not: a provider
 * that is down, rate-limiting, or has changed its API is a finding to report,
 * not an exception to unwind a configuration screen with.
 */
export type ProviderUsagePort = {
  id: string
  /** null when the endpoint answered but published nothing usable */
  fetch: (req: {
    baseUrl: string
    credential: string
    timeoutMs?: number
  }) => Promise<ProviderUsage | null>
}

export {}
