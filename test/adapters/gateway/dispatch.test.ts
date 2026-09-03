import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_POLICY, isRetryable, isTerminalRateLimit, retryDelay, summarize,
} from '../../../src/adapters/gateway/dispatch.ts'

test('529 overloaded is retryable — the status this gateway exists for', () => {
  assert.equal(isRetryable(529), true)
  assert.equal(isRetryable(429), true)
  assert.equal(isRetryable(503), true)
})

test('a bad request is not retried', () => {
  assert.equal(isRetryable(400), false)
  assert.equal(isRetryable(401), false)
  assert.equal(isRetryable(404), false)
})

test('a balance or quota message reads as terminal, not as a rate limit', () => {
  assert.equal(isTerminalRateLimit('Insufficient balance or no resource package. Please recharge.'), true)
  assert.equal(isTerminalRateLimit('quota exceeded for this month'), true)
  assert.equal(isTerminalRateLimit('rate limit exceeded, slow down'), false)
})

test('a numeric retry-after wins over local backoff', () => {
  assert.equal(retryDelay(0, '2', DEFAULT_POLICY), 2000)
})

test('an HTTP-date retry-after is honoured', () => {
  const when = new Date(Date.now() + 3000).toUTCString()
  const delay = retryDelay(0, when, DEFAULT_POLICY)
  assert.ok(delay > 1500 && delay <= 3000, `expected ~3000, got ${delay}`)
})

test('retry-after is clamped to the ceiling', () => {
  assert.equal(retryDelay(0, '9999', DEFAULT_POLICY), DEFAULT_POLICY.maxDelayMs)
})

test('backoff grows exponentially and stays under the ceiling', () => {
  const noJitter = () => 0
  assert.equal(retryDelay(0, null, DEFAULT_POLICY, noJitter), 500)
  assert.equal(retryDelay(1, null, DEFAULT_POLICY, noJitter), 1000)
  assert.equal(retryDelay(2, null, DEFAULT_POLICY, noJitter), 2000)
  assert.equal(retryDelay(9, null, DEFAULT_POLICY, noJitter), DEFAULT_POLICY.maxDelayMs)
})

test('jitter separates retries that would otherwise land on the same tick', () => {
  assert.equal(retryDelay(0, null, DEFAULT_POLICY, () => 0), 500)
  assert.equal(retryDelay(0, null, DEFAULT_POLICY, () => 1), 1000)
})

test('an error body is summarized to its type and message', () => {
  assert.equal(
    summarize('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
    'overloaded_error: Overloaded',
  )
})

test('a non-JSON or empty body still yields something worth logging', () => {
  assert.equal(summarize('<html>502 Bad Gateway</html>'), '<html>502 Bad Gateway</html>')
  assert.equal(summarize(''), '(empty body)')
})
