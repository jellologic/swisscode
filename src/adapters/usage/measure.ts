// Measuring every account once, in the one order that respects the Keychain.
//
// Shared by `config accounts usage` and `config doctor`. The loop below looks
// trivial enough to copy into both, which is exactly why it is not: the
// decisions in it — sequential rather than parallel, key accounts reported
// rather than failed, identity read once — are invisible in the shape of the
// code and would drift apart silently between two copies.
//
// CONFIGURATION-TIME ONLY, like everything under adapters/usage.
// `test/architecture.test.ts` keeps this directory off the launch path by name.

import { readSessionIdentity } from '../claude-session/identity.ts'
import type { SessionIdentity } from '../claude-session/identity.ts'
import { fetchSubscriptionUsage } from './anthropic-subscription.ts'
import type { SubscriptionUsage } from './anthropic-subscription.ts'

/** Where subscription usage lives. Not a provider baseUrl — this endpoint is
 * Anthropic's own, and a profile pointed at a proxy still has its subscription
 * window measured here rather than wherever it sends inference. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'

/** The little a measurement needs to know about an account. */
export type MeasurableAccount = { name: string; configDir?: string }

export type AccountMeasurement = {
  name: string
  /** null for a key-mode account: it bills per token and has no window at all */
  configDir: string | null
  identity: SessionIdentity | null
  usage: SubscriptionUsage | null
}

export type MeasureOptions = {
  baseUrl?: string
  /** injected in tests, so measuring costs no network and no Keychain */
  fetchUsage?: typeof fetchSubscriptionUsage
  readIdentity?: (dir: string) => SessionIdentity | null
}

/**
 * Measure each account's remaining subscription capacity.
 *
 * Returns one entry per account IN THE ORDER GIVEN, including the ones that
 * could not be measured — a caller rendering a list needs to say "this one
 * failed" as much as it needs the figures, and dropping the failures here would
 * make that impossible to distinguish from an account that no longer exists.
 */
export async function measureAccounts(
  accounts: readonly MeasurableAccount[],
  {
    baseUrl = ANTHROPIC_BASE_URL,
    fetchUsage = fetchSubscriptionUsage,
    readIdentity = (dir) => readSessionIdentity(dir),
  }: MeasureOptions = {},
): Promise<AccountMeasurement[]> {
  const results: AccountMeasurement[] = []
  // SEQUENTIAL, and not an oversight. Each subscription read can raise a
  // Keychain prompt, and three stacked unlock dialogs is a worse experience
  // than waiting for three round trips.
  for (const account of accounts) {
    if (!account.configDir) {
      results.push({ name: account.name, configDir: null, identity: null, usage: null })
      continue
    }
    const identity = readIdentity(account.configDir)
    const usage = await fetchUsage({ baseUrl, credential: '', sessionDir: account.configDir })
    results.push({ name: account.name, configDir: account.configDir, identity, usage })
  }
  return results
}

/**
 * The account→remaining map the `usage` strategy selects on.
 *
 * An account that could not be measured is ABSENT rather than zero. Selection
 * reads a missing entry as "unknown" and falls back saying so, where a zero
 * would read as "exhausted" and route work away from an account that may be
 * completely free — the wrong answer, arrived at confidently.
 */
export function remainingMap(
  measurements: readonly AccountMeasurement[],
): Record<string, number> {
  const remaining: Record<string, number> = {}
  for (const m of measurements) {
    if (m.usage && m.usage.remaining !== null) remaining[m.name] = m.usage.remaining
  }
  return remaining
}
