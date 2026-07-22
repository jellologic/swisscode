// Subscription usage: parsing, ranking, and refusing to guess.
//
// The payload below is the REAL one, captured from
// GET https://api.anthropic.com/api/oauth/usage on a live Max 20x account, with
// only the figures adjusted per test. Every field name here was measured — one
// of them (`is_enabled`) was wrong in the first draft, and a wrong field name
// fails silently forever, which is why the fixture is real rather than invented.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicSubscriptionUsage,
  remainingFrom,
  type SubscriptionUsage,
} from '../../src/adapters/usage/anthropic-subscription.ts'

const REAL_PAYLOAD = {
  five_hour: {
    utilization: 37,
    resets_at: '2026-07-22T15:10:00.342470+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  seven_day: {
    utilization: 73,
    resets_at: '2026-07-25T17:00:00.425040+00:00',
    limit_dollars: null,
    used_dollars: null,
    remaining_dollars: null,
  },
  // Both null on the live account — a real state, not an oversight.
  seven_day_opus: null,
  seven_day_sonnet: null,
  extra_usage: {
    is_enabled: false,
    monthly_limit: null,
    used_credits: null,
    utilization: null,
    currency: null,
    decimal_places: null,
    disabled_reason: null,
  },
  limits: [
    { kind: 'session', group: 'session', percent: 37, severity: 'normal', is_active: false },
  ],
}

/** Stand in for the network without touching it. */
function withFetch<T>(handler: (url: string, init: RequestInit) => Response, run: () => T): T {
  const original = globalThis.fetch
  globalThis.fetch = ((url: string, init: RequestInit) =>
    Promise.resolve(handler(url, init))) as typeof fetch
  try {
    return run()
  } finally {
    globalThis.fetch = original
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const fetchUsage = (body: unknown, status = 200) =>
  withFetch(
    () => json(body, status),
    () =>
      anthropicSubscriptionUsage.fetch({
        baseUrl: 'https://api.anthropic.com',
        credential: 'tok',
      }),
  )

test('ranking takes the WORSE window, never the average', () => {
  // The failure this prevents: an account 10% into its 5-hour window and 95%
  // into its weekly one averages to 52% and looks healthy, when it has almost
  // nothing left. The limits bite independently.
  assert.equal(remainingFrom({ utilization: 10, resetsAt: null }, { utilization: 95, resetsAt: null }), 5)
  assert.equal(remainingFrom({ utilization: 37, resetsAt: null }, { utilization: 73, resetsAt: null }), 27)
})

test('an account that publishes nothing is UNKNOWN, not full', () => {
  // Returning 100 here would make a silent account out-rank one that honestly
  // reported 5% used — routing real money by the absence of information.
  assert.equal(remainingFrom({ utilization: null, resetsAt: null }, { utilization: null, resetsAt: null }), null)
})

test('utilisation over 100 floors at zero rather than going negative', () => {
  assert.equal(remainingFrom({ utilization: 130, resetsAt: null }, { utilization: 0, resetsAt: null }), 0)
})

test('the real payload parses, with both windows and the reset times', async () => {
  const u = (await fetchUsage(REAL_PAYLOAD)) as SubscriptionUsage | null
  assert.ok(u)
  assert.equal(u.remaining, 27) // 100 - max(37, 73)
  assert.equal(u.limit, 100)
  assert.equal(u.used, 73)
  assert.equal(u.fiveHour.utilization, 37)
  assert.equal(u.sevenDay.utilization, 73)
  assert.equal(u.sevenDay.resetsAt, '2026-07-25T17:00:00.425040+00:00')
})

test('extra usage reads `is_enabled` — the name that is actually in the payload', () => {
  // A wrong field name here fails SILENTLY and forever: it yields null, which
  // is indistinguishable from an endpoint that did not publish the field.
  assert.equal(Object.keys(REAL_PAYLOAD.extra_usage).includes('is_enabled'), true)
  assert.equal(Object.keys(REAL_PAYLOAD.extra_usage).includes('enabled'), false)
})

test('extra usage parses to a real boolean, not null', async () => {
  const off = (await fetchUsage(REAL_PAYLOAD)) as SubscriptionUsage
  assert.equal(off.extraUsage, false)
  const on = (await fetchUsage({
    ...REAL_PAYLOAD,
    extra_usage: { ...REAL_PAYLOAD.extra_usage, is_enabled: true },
  })) as SubscriptionUsage
  assert.equal(on.extraUsage, true)
})

test('null per-model windows stay null — never zero, never unlimited', async () => {
  const u = (await fetchUsage(REAL_PAYLOAD)) as SubscriptionUsage
  assert.equal(u.sevenDayOpus.utilization, null)
  assert.equal(u.sevenDaySonnet.utilization, null)
})

test('a per-model window does NOT drag the ranking down', async () => {
  // An exhausted Opus window must not disqualify an account for a profile that
  // runs Sonnet. It is reported; it is not ranked on.
  const u = (await fetchUsage({
    ...REAL_PAYLOAD,
    seven_day_opus: { utilization: 99, resets_at: null },
  })) as SubscriptionUsage
  assert.equal(u.remaining, 27, 'ranking still comes from the two universal windows')
  assert.equal(u.sevenDayOpus.utilization, 99, 'but it is still reported')
})

test('an HTTP error is a null finding, never a throw', async () => {
  for (const status of [401, 403, 429, 500]) {
    assert.equal(await fetchUsage(REAL_PAYLOAD, status), null, `HTTP ${status} should read as null`)
  }
})

test('a changed payload shape degrades to null instead of inventing a figure', async () => {
  assert.equal(await fetchUsage({}), null)
  assert.equal(await fetchUsage({ five_hour: 'nonsense', seven_day: null }), null)
  assert.equal(await fetchUsage(null), null)
})

test('a network failure is a null finding', async () => {
  const result = await withFetch(
    () => {
      throw new Error('ECONNREFUSED')
    },
    () =>
      anthropicSubscriptionUsage.fetch({ baseUrl: 'https://api.anthropic.com', credential: 'tok' }),
  )
  assert.equal(result, null)
})

test('it sends the OAuth beta header, without which the endpoint refuses', async () => {
  let seen: RequestInit | undefined
  await withFetch(
    (_url, init) => {
      seen = init
      return json(REAL_PAYLOAD)
    },
    () =>
      anthropicSubscriptionUsage.fetch({ baseUrl: 'https://api.anthropic.com', credential: 'tok' }),
  )
  const headers = seen?.headers as Record<string, string>
  assert.equal(headers['anthropic-beta'], 'oauth-2025-04-20')
  assert.equal(headers.authorization, 'Bearer tok')
})

test('it hits the right path, tolerating a trailing slash on the base url', async () => {
  let url = ''
  await withFetch(
    (u) => {
      url = u
      return json(REAL_PAYLOAD)
    },
    () =>
      anthropicSubscriptionUsage.fetch({
        baseUrl: 'https://api.anthropic.com/',
        credential: 'tok',
      }),
  )
  assert.equal(url, 'https://api.anthropic.com/api/oauth/usage')
})

test('with no credential and no session it asks nothing at all', async () => {
  let called = false
  const result = await withFetch(
    () => {
      called = true
      return json(REAL_PAYLOAD)
    },
    () => anthropicSubscriptionUsage.fetch({ baseUrl: 'https://api.anthropic.com', credential: '' }),
  )
  assert.equal(result, null)
  assert.equal(called, false, 'no token means no request, not an anonymous one')
})
