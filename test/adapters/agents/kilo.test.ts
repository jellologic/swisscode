import test from 'node:test'
import assert from 'node:assert/strict'
import { kilo, KILO_CONFIG_ENV, KILO_ALLOW_ALL } from '../../../src/adapters/agents/kilo/index.ts'
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
  const t = kilo.translate(input)
  const raw = t.plan.set[KILO_CONFIG_ENV]
  return { t, config: raw ? JSON.parse(raw) : null }
}

test('kilo lowers the intent into an inline config via KILO_CONFIG_CONTENT', () => {
  const { t, config } = run(intent())
  const p = config.provider.swisscode
  assert.equal(p.npm, '@ai-sdk/anthropic')
  assert.equal(p.options.baseURL, 'https://api.z.ai/api/anthropic')
  assert.equal(p.options.apiKey, 'KEY')
  assert.equal(config.model, 'swisscode/glm-5.2')
  assert.ok('glm-5.2' in p.models)
  assert.deepEqual(t.plan.unset, [])
})

test('permissions are auto-approved through the config, not a flag', () => {
  assert.equal(run(intent()).config.permission, undefined)
  const yolo = run(intent({ skipPermissions: true }))
  assert.deepEqual(yolo.config.permission, KILO_ALLOW_ALL)
  // Kilo's top-level --auto is unconfirmed, so args stay pure passthrough.
  assert.deepEqual(yolo.t.args, [])
})

test('kilo uses a single model slot and warns about pinned tiers it drops', () => {
  const { config, t } = run(intent({ models: { opus: 'a', sonnet: 'b', haiku: 'c', fable: 'a' } }))
  assert.equal(config.model, 'swisscode/a')
  const collapse = t.warnings.find((w) => w.code === 'tier-collapsed')
  assert.ok(collapse)
  assert.match(collapse!.message, /sonnet=b/)
  assert.match(collapse!.message, /haiku=c/)
})

test('an omitted credential and base URL are simply left out of the config', () => {
  const { config } = run(intent({ baseUrl: null, credential: '' }))
  assert.equal(config.provider.swisscode.options.baseURL, undefined)
  assert.equal(config.provider.swisscode.options.apiKey, undefined)
})

test('capabilities describe a single model slot', () => {
  assert.equal(kilo.capabilities.models, 'single')
  assert.equal(kilo.binary.name, 'kilo')
  assert.equal(kilo.binary.overrideEnv, 'SWISSCODE_KILO_BIN')
})
