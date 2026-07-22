import test from 'node:test'
import assert from 'node:assert/strict'
import { AGENTS, DEFAULT_AGENT_ID, byId, registry } from '../../../src/adapters/agents/registry.ts'

test('the three shipped agents are registered with unique ids', () => {
  const ids = AGENTS.map((a) => a.id)
  assert.deepEqual([...ids].sort(), ['claude-code', 'kilo', 'opencode'])
  assert.equal(new Set(ids).size, ids.length)
})

test('claude-code is the default and is first', () => {
  assert.equal(DEFAULT_AGENT_ID, 'claude-code')
  assert.equal(AGENTS[0]!.id, 'claude-code')
  assert.ok(byId(DEFAULT_AGENT_ID), 'the default id always resolves')
})

test('byId returns null for an unknown id rather than throwing', () => {
  assert.equal(byId('nope'), null)
  assert.equal(byId(null), null)
  assert.equal(byId(undefined), null)
})

test('every agent declares a binary spec and capabilities', () => {
  for (const a of registry.all()) {
    assert.ok(a.binary.name, `${a.id} has a binary name`)
    assert.match(a.binary.overrideEnv, /^SWISSCODE_/, `${a.id} override env`)
    assert.ok(Array.isArray(a.binary.fallbacks('/home/u')), `${a.id} fallbacks`)
    assert.ok(['tiers', 'primary+small', 'single'].includes(a.capabilities.models), a.id)
  }
})
