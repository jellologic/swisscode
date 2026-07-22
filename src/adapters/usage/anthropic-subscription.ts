// How much of a Claude subscription is left.
//
// This is the adapter that makes `/usage` unnecessary: the same figure, for
// EVERY account at once, without switching into each one to look.
//
// CONFIGURATION-TIME ONLY, like every usage adapter — `test/architecture.test.ts`
// keeps `adapters/usage` off the launch path by name. `usage` selection reads
// the cached snapshot this writes; it never reaches the network itself.

import { readSessionCredential } from '../claude-session/credentials.ts'
import type { ProviderUsage, ProviderUsagePort, SubscriptionWindow } from '../../ports/provider-usage.ts'

/**
 * The endpoint, and the header that makes it answer.
 *
 * UNDOCUMENTED. It is what the official client calls, and the beta header is
 * not optional — without it the request is refused. Stated plainly here rather
 * than buried, because an undocumented endpoint can change and the failure
 * should read as "Anthropic changed something", not as "your account is
 * broken". Every parse below degrades to null for exactly that reason.
 */
const USAGE_PATH = '/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'

/** The windows a subscription is actually limited by. */
export type SubscriptionUsage = ProviderUsage & {
  fiveHour: SubscriptionWindow
  sevenDay: SubscriptionWindow
  /**
   * Per-model weekly windows, REPORTED BUT NOT RANKED ON.
   *
   * Both were null on the live Max 20x account this was written against, so
   * they are not universally populated — which is itself the reason they are
   * kept: a null window must stay null rather than being read as "unlimited"
   * or as zero.
   *
   * They stay out of `remaining` because an exhausted Opus window should not
   * disqualify an account for a profile that runs Sonnet. Ranking that
   * accurately means knowing which model the launch will use, which is a
   * profile-level fact this adapter does not have and should not guess at.
   */
  sevenDayOpus: SubscriptionWindow
  sevenDaySonnet: SubscriptionWindow
  /** true when the account may spend past the window rather than being cut off */
  extraUsage: boolean | null
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

/** One `{utilization, resets_at}` block, tolerant of an absent one. */
function window(raw: unknown): SubscriptionWindow {
  if (!raw || typeof raw !== 'object') return { utilization: null, resetsAt: null }
  const o = raw as Record<string, unknown>
  return { utilization: num(o.utilization), resetsAt: text(o.resets_at) }
}

/**
 * Rank on the window that is FURTHEST ALONG, not on an average of the two.
 *
 * The limits bite independently: an account at 10% of its 5-hour window and 95%
 * of its weekly one has almost nothing left, and averaging to 52% would send
 * work straight at it. Taking the worse window is the only reading that matches
 * how it actually fails.
 */
export function remainingFrom(fiveHour: SubscriptionWindow, sevenDay: SubscriptionWindow): number | null {
  const worst = Math.max(fiveHour.utilization ?? -1, sevenDay.utilization ?? -1)
  // Neither window published a figure: unknown, NOT full. An account that
  // reports nothing must not out-rank one that honestly reported 5% used.
  if (worst < 0) return null
  return Math.max(0, 100 - worst)
}

export const anthropicSubscriptionUsage: ProviderUsagePort = {
  id: 'anthropic-subscription',

  async fetch({ baseUrl, credential, sessionDir = null, timeoutMs = 8000 }) {
    // A session account's token is read HERE, at the moment it is needed, and
    // never held anywhere else. A key-mode Anthropic account has no
    // subscription window at all — it bills per token — so it is not this
    // adapter's business.
    let token = ''
    if (sessionDir) {
      const found = readSessionCredential(sessionDir)
      if (!found.ok) return null
      // An EXPIRED token is reported as unknown rather than refreshed. Asking
      // with it would return 401, which is indistinguishable from a revoked
      // account; the honest answer is "we cannot say right now".
      if (found.expired) return null
      token = found.credential.accessToken
    } else {
      token = credential
    }
    if (!token) return null

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}${USAGE_PATH}`, {
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': OAUTH_BETA,
          accept: 'application/json',
        },
        signal: controller.signal,
      })
      if (!response.ok) return null
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object') return null

      const o = body as Record<string, unknown>
      const fiveHour = window(o.five_hour)
      const sevenDay = window(o.seven_day)
      const remaining = remainingFrom(fiveHour, sevenDay)
      // The port's contract: null when the endpoint ANSWERED but published
      // nothing usable. Returning a fully-null object instead would look like a
      // successful measurement to every caller that checks for null — and would
      // get written into the snapshot as a real reading of "unknown", which is
      // not something a cache should carry.
      if (remaining === null) return null

      const usage: SubscriptionUsage = {
        remaining,
        // A subscription window has no credit balance. `limit` is the
        // percentage scale the figure lives on, and `used` its complement —
        // stated rather than left null so the generic display has something
        // true to show.
        // Unreachable as null now — the early return above guarantees a figure.
        limit: 100,
        used: 100 - remaining,
        unit: 'percent of window remaining',
        checkedAt: Date.now(),
        fiveHour,
        sevenDay,
        sevenDayOpus: window(o.seven_day_opus),
        sevenDaySonnet: window(o.seven_day_sonnet),
        // `is_enabled`, MEASURED — not `enabled`, which is what the field
        // looked like it should be called and what the first draft read. The
        // difference is silent: the wrong name yields `null` forever, so the
        // feature would simply never have reported extra usage for anyone.
        extraUsage:
          typeof (o.extra_usage as Record<string, unknown> | undefined)?.is_enabled === 'boolean'
            ? ((o.extra_usage as Record<string, unknown>).is_enabled as boolean)
            : null,
      }
      return usage
    } catch {
      // Down, rate-limited, timed out, or changed shape. A finding to report,
      // never an exception to unwind a configuration screen with.
      return null
    } finally {
      clearTimeout(timer)
    }
  },
}
