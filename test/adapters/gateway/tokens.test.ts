import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateRequestTokens, estimateTokens } from '../../../src/adapters/gateway/tokens.ts'

test('an empty string costs nothing', () => {
  assert.equal(estimateTokens(''), 0)
})

test('a request with system, messages and tools counts all three', () => {
  const withAll = estimateRequestTokens({
    system: 'be brief',
    messages: [{ role: 'user', content: 'hello world' }],
    tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object' } }],
  })
  const withoutTools = estimateRequestTokens({
    system: 'be brief',
    messages: [{ role: 'user', content: 'hello world' }],
  })
  assert.ok(withAll > withoutTools)
})

test('block content is walked, not just plain strings', () => {
  const blocks = estimateRequestTokens({
    messages: [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'here you go' },
        { type: 'tool_use', name: 'run', input: { cmd: 'ls -la' } },
      ],
    }],
  })
  assert.ok(blocks > 0)
})

test('an image is charged a flat cost rather than counted as base64 text', () => {
  // Counting the base64 blob as prose would inflate a screenshot into tens of
  // thousands of tokens and compact the session almost immediately.
  const huge = 'A'.repeat(200_000)
  const asImage = estimateRequestTokens({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: huge } }] }],
  })
  assert.ok(asImage < 5000, `image should not scale with payload size, got ${asImage}`)
})

test('malformed input yields zero instead of throwing', () => {
  assert.equal(estimateRequestTokens(null), 0)
  assert.equal(estimateRequestTokens('not an object'), 0)
  assert.equal(estimateRequestTokens({ messages: 'not an array' }), 0)
})
