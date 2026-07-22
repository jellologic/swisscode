// The provider usage capability.
//
// Every payload here matches OpenRouter's documented `GET /v1/key` shape. The
// tests are mostly about what happens when a figure is ABSENT, because a
// missing number and a zero are different facts and this one ranks accounts by
// remaining money.
import test from 'node:test'
import assert from 'node:assert/strict'
import { keyUrl, parseKeyResponse } from '../../src/adapters/usage/openrouter.ts'
import { registry } from '../../src/adapters/providers/registry.ts'

test('the usage URL composes from the provider base URL', () => {
  // Composed rather than hard-coded so the two cannot drift; the provider base
  // URL is a bare host because Claude Code appends /v1/messages itself.
  const openrouter = registry.byId('openrouter')!
  assert.equal(keyUrl(openrouter.baseUrl!), 'https://openrouter.ai/api/v1/key')
  assert.equal(keyUrl('https://x.example/api/'), 'https://x.example/api/v1/key')
})

test('a full payload becomes a usage record', () => {
  const u = parseKeyResponse(
    { data: { limit: 100, limit_remaining: 42.5, usage: 57.5, usage_daily: 3 } },
    1000,
  )
  assert.ok(u)
  assert.equal(u.remaining, 42.5)
  assert.equal(u.limit, 100)
  assert.equal(u.used, 57.5)
  assert.equal(u.checkedAt, 1000)
})

test('a null limit survives as null, never as zero', () => {
  // OpenRouter uses null for "no limit". Coercing it to 0 would make an
  // UNCAPPED key rank LAST under the usage strategy — exactly backwards.
  const u = parseKeyResponse({ data: { limit: null, limit_remaining: null, usage: 12 } }, 1)
  assert.ok(u)
  assert.equal(u.limit, null)
  assert.equal(u.remaining, null)
  assert.equal(u.used, 12)
})

test('a payload with nothing usable is null, not a row of nulls', () => {
  // "This provider does not publish usage" and "this account has no limit" are
  // different answers, and only one of them is worth rendering.
  assert.equal(parseKeyResponse({ data: {} }, 1), null)
  assert.equal(parseKeyResponse({ data: { label: 'my key' } }, 1), null)
})

test('an unexpected shape is null rather than a throw', () => {
  for (const body of [null, undefined, 'nope', [], { notData: 1 }, { data: 'string' }]) {
    assert.equal(parseKeyResponse(body, 1), null)
  }
})

test('non-finite numbers are refused', () => {
  // NaN would sort unpredictably against real balances.
  const u = parseKeyResponse({ data: { limit_remaining: Number.NaN, usage: Infinity } }, 1)
  assert.equal(u, null)
})

test('only providers with a VERIFIED endpoint declare one', () => {
  // The standard REJECTED_PROVIDERS and the Ollama work were held to: a
  // speculative entry here would route real money by a number nobody checked.
  const withUsage = registry.all().filter((p) => p.usageId)
  assert.deepEqual(withUsage.map((p) => p.id), ['openrouter'])
  // …and the id must name an adapter that exists.
  assert.equal(withUsage[0]!.usageId, 'openrouter')
})
