import test from 'node:test'
import assert from 'node:assert/strict'
import { formatContext, formatCost, formatPrice, formatToolSupport } from '../../src/core/format.js'

test('prices render per million tokens', () => {
  assert.equal(formatPrice(0.000003), '$3.00')
  assert.equal(formatPrice(0.0000002), '$0.20')
  assert.equal(formatPrice(0.000000002), '$0.0020', 'sub-cent needs the extra digits')
  assert.equal(formatPrice(0), 'free')
})

test('an UNKNOWN price is a dash, never $0.00 and never "free"', () => {
  // Absent pricing and a genuinely free model must stay distinguishable all
  // the way to the screen.
  assert.equal(formatPrice(null), '—')
  assert.equal(formatPrice(undefined), '—')
  assert.equal(formatPrice(Number.NaN), '—')
})

test('context lengths render compactly', () => {
  assert.equal(formatContext(1000000), '1M')
  assert.equal(formatContext(1048576), '1.0M')
  assert.equal(formatContext(200000), '200K')
  assert.equal(formatContext(512), '512')
  assert.equal(formatContext(null), '—')
})

test('cost is null when pricing is unknown', () => {
  assert.equal(formatCost(null), null)
  assert.equal(formatCost({ prompt: 0, completion: 0, cacheRead: null }), 'free')
  assert.equal(formatCost({ prompt: 0.000003, completion: 0.000015, cacheRead: null }), '$0.33')
})

test('tool support keeps unknown and confirmed-absent distinct', () => {
  assert.equal(formatToolSupport(true), 'tools')
  assert.equal(formatToolSupport(false), 'no tools')
  assert.equal(formatToolSupport(null), 'tools unknown')
})
