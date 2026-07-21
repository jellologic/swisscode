import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CACHE_TTL_MS,
  filterModels,
  isNormalizedModel,
  isStale,
  rank,
  sanitizeModels,
} from '../../src/core/catalog.js'

const model = (id, over = {}) => ({
  id,
  name: id,
  description: '',
  context: 200000,
  maxOutput: 64000,
  pricing: { prompt: 0.000003, completion: 0.000015, cacheRead: null },
  benchmarks: null,
  tools: true,
  reasoning: false,
  ...over,
})

const RICH = { pricing: true, benchmarks: true, toolSupportKnown: true, requiresAuth: false }
const BARE = { pricing: false, benchmarks: false, toolSupportKnown: false, requiresAuth: false }

test('a stale timestamp is anything that is not a sane past time', () => {
  const now = 1_000_000_000_000
  assert.equal(isStale(now - 1000, now), false)
  assert.equal(isStale(now - CACHE_TTL_MS - 1, now), true)
  // These used to produce `NaN > TTL` === false, pinning the cache as fresh
  // forever.
  assert.equal(isStale('garbage', now), true)
  assert.equal(isStale(undefined, now), true)
  assert.equal(isStale(null, now), true)
  assert.equal(isStale(now + 60_000, now), true, 'a future timestamp is not fresh')
})

test('cache rows are validated against the normalized shape', () => {
  assert.ok(isNormalizedModel(model('a/b')))
  // An undefined id would flow into config.json and then into
  // ANTHROPIC_DEFAULT_*_MODEL.
  assert.ok(!isNormalizedModel({ name: 'x' }))
  assert.ok(!isNormalizedModel({ id: '', name: 'x' }))
  assert.ok(!isNormalizedModel(model('a', { tools: 'yes' })))
  assert.ok(!isNormalizedModel(model('a', { context: 'lots' })))
  assert.ok(!isNormalizedModel(model('a', { pricing: { prompt: 'free', completion: 1 } })))
  assert.ok(!isNormalizedModel(null))
  assert.ok(!isNormalizedModel([]))
})

test('tri-state fields are legal as null', () => {
  assert.ok(isNormalizedModel(model('a', { tools: null, reasoning: null })))
  assert.ok(isNormalizedModel(model('a', { pricing: null, benchmarks: null })))
})

test('sanitize drops bad rows and keeps the good ones', () => {
  const out = sanitizeModels([model('good'), { id: 'bad' }, null, model('also-good')])
  assert.deepEqual(out.map((m) => m.id), ['good', 'also-good'])
  assert.deepEqual(sanitizeModels('not an array'), [])
})

test('rank puts the best coding models first and the unbenchmarked last', () => {
  const rows = [
    model('c', { benchmarks: null }),
    model('a', { benchmarks: { intelligence: null, coding: 70, agentic: null } }),
    model('b', { benchmarks: { intelligence: null, coding: 90, agentic: null } }),
  ]
  assert.deepEqual([...rows].sort(rank).map((m) => m.id), ['b', 'a', 'c'])
})

test('the tools filter hides only CONFIRMED absences', () => {
  const rows = [model('yes'), model('no', { tools: false }), model('unknown', { tools: null })]
  const out = filterModels(rows, { toolsOnly: true }, RICH)
  assert.deepEqual(out.map((m) => m.id), ['yes', 'unknown'])
})

test('the tools filter is inert when the catalog publishes no capability data', () => {
  // Defaulting it on against such a catalog would empty the list entirely.
  const rows = [model('a', { tools: null }), model('b', { tools: null })]
  assert.equal(filterModels(rows, { toolsOnly: true }, BARE).length, 2)
})

test('a model with UNKNOWN pricing never counts as free', () => {
  const rows = [
    model('free', { pricing: { prompt: 0, completion: 0, cacheRead: null } }),
    model('unpriced', { pricing: null }),
    model('paid'),
  ]
  const out = filterModels(rows, { freeOnly: true }, RICH)
  assert.deepEqual(out.map((m) => m.id), ['free'])
})

test('the free filter is inert when the catalog publishes no prices', () => {
  const rows = [model('a', { pricing: null }), model('b', { pricing: null })]
  assert.equal(filterModels(rows, { freeOnly: true }, BARE).length, 2)
})

test('search matches on id and name, all terms required', () => {
  const rows = [model('anthropic/claude-opus'), model('openrouter/fusion')]
  assert.deepEqual(
    filterModels(rows, { query: 'claude opus' }, RICH).map((m) => m.id),
    ['anthropic/claude-opus'],
  )
  assert.equal(filterModels(rows, { query: 'nothing' }, RICH).length, 0)
})
