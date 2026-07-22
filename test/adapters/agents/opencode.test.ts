import test from 'node:test'
import assert from 'node:assert/strict'
import { opencode, OPENCODE_CONFIG_ENV, OPENCODE_AUTO_FLAG } from '../../../src/adapters/agents/opencode/index.ts'
import type { LaunchIntent, TranslateInput } from '../../../src/ports/agent.ts'

function intent(over: Partial<LaunchIntent> = {}): LaunchIntent {
  return {
    baseUrl: 'https://api.z.ai/api/anthropic',
    credential: 'KEY',
    models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2', fable: 'glm-5.2' },
    skipPermissions: false,
    extendedContext: null,
    ...over,
  }
}

function run(i: LaunchIntent, passthrough: string[] = []) {
  const input: TranslateInput = { intent: i, profile: { provider: 'zai' }, provider: null, passthrough, ambient: {} }
  const t = opencode.translate(input)
  const raw = t.plan.set[OPENCODE_CONFIG_ENV]
  return { t, config: raw ? JSON.parse(raw) : null }
}

test('opencode lowers the intent into an inline config via OPENCODE_CONFIG_CONTENT', () => {
  const { t, config } = run(intent())
  assert.ok(config, 'a config JSON is set')
  const p = config.provider.swisscode
  assert.equal(p.npm, '@ai-sdk/anthropic')
  assert.equal(p.options.baseURL, 'https://api.z.ai/api/anthropic')
  assert.equal(p.options.apiKey, 'KEY')
  assert.equal(config.model, 'swisscode/glm-5.2')
  assert.ok('glm-5.2' in p.models, 'the referenced model is declared')
})

test('a third-party baseURL clears inherited ANTHROPIC_* creds (no fallback leak)', () => {
  const withUrl = run(intent())
  assert.deepEqual(
    [...withUrl.t.plan.unset].sort(),
    ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  )
  // No custom endpoint (first-party default) → nothing to strip.
  const noUrl = run(intent({ baseUrl: null }))
  assert.deepEqual(noUrl.t.plan.unset, [])
})

test('--auto is added only when permissions are skipped, and never duplicated', () => {
  assert.ok(!run(intent(), ['-p', 'hi']).t.args.includes(OPENCODE_AUTO_FLAG))
  const yolo = run(intent({ skipPermissions: true }), ['-p', 'hi'])
  assert.deepEqual(yolo.t.args, [OPENCODE_AUTO_FLAG, '-p', 'hi'])
  const already = run(intent({ skipPermissions: true }), [OPENCODE_AUTO_FLAG])
  assert.deepEqual(already.t.args, [OPENCODE_AUTO_FLAG])
})

test('opus drives model and haiku drives small_model when they differ', () => {
  const { config } = run(intent({ models: { opus: 'big', sonnet: 'big', haiku: 'small', fable: 'big' } }))
  assert.equal(config.model, 'swisscode/big')
  assert.equal(config.small_model, 'swisscode/small')
})

test('a same-valued small tier sets no separate small_model', () => {
  const { config } = run(intent())
  assert.equal(config.small_model, undefined)
})

test('a pinned tier opencode cannot express warns rather than vanishing', () => {
  const { t } = run(intent({ models: { opus: 'a', sonnet: 'b', haiku: 'a', fable: 'a' } }))
  const collapse = t.warnings.find((w) => w.code === 'tier-collapsed')
  assert.ok(collapse, 'the distinct sonnet tier produced a warning')
  assert.match(collapse!.message, /sonnet=b/)
})

test('no warning when a dropped tier is served by the small_model slot', () => {
  // opus->model=big, haiku->small_model=small; sonnet=small is served by small_model
  // and fable=big by model, so NOTHING is actually dropped.
  const { t } = run(intent({ models: { opus: 'big', sonnet: 'small', haiku: 'small', fable: 'big' } }))
  assert.equal(t.warnings.find((w) => w.code === 'tier-collapsed'), undefined)
})

test('reaching a 1M provider without the [1m] signal warns', () => {
  const { t } = run(intent({ extendedContext: { supported: true, models: ['glm-5.2'], window: 1_000_000 } }))
  assert.ok(t.warnings.some((w) => w.code === 'extended-context-unavailable'))
})

test('capabilities describe a primary+small model shape', () => {
  assert.equal(opencode.capabilities.models, 'primary+small')
  assert.equal(opencode.capabilities.extendedContextSuffix, false)
  assert.equal(opencode.binary.name, 'opencode')
})
