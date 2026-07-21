import test from 'node:test'
import assert from 'node:assert/strict'
import { SUFFIX, bareModelId, withExtendedContext } from '../../src/core/context.ts'

const supported = { supported: true, models: ['glm-5.2', 'kimi-k3'], window: 1_000_000 }
const unsupported = { supported: false, models: [] }

test('appends the suffix only to models that genuinely support it', () => {
  assert.equal(withExtendedContext('glm-5.2', supported), 'glm-5.2[1m]')
  assert.equal(withExtendedContext('kimi-k3', supported), 'kimi-k3[1m]')
  assert.equal(withExtendedContext('glm-4-air', supported), 'glm-4-air')
})

test('is idempotent', () => {
  const once = withExtendedContext('glm-5.2', supported)
  assert.equal(withExtendedContext(once, supported), once)
  assert.equal(withExtendedContext(withExtendedContext(once, supported), supported), once)
})

test('strips a suffix the provider cannot honour', () => {
  // Sending an id the endpoint does not know is a hard failure; dropping the
  // suffix is merely a narrower window.
  assert.equal(withExtendedContext('glm-5.2[1m]', unsupported), 'glm-5.2')
  assert.equal(withExtendedContext('glm-5.2[1m]', undefined), 'glm-5.2')
  assert.equal(withExtendedContext('deepseek-chat[1m]', supported), 'deepseek-chat')
})

test('passes empty and absent values through untouched', () => {
  // '' has to survive: it is the caller's UNSET sentinel.
  assert.equal(withExtendedContext('', supported), '')
  assert.equal(withExtendedContext(undefined, supported), undefined)
  assert.equal(withExtendedContext(null, supported), null)
})

test('bareModelId round-trips', () => {
  assert.equal(bareModelId(`glm-5.2${SUFFIX}`), 'glm-5.2')
  assert.equal(bareModelId('glm-5.2'), 'glm-5.2')
})
