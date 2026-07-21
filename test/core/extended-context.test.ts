// F#14 — the live bug: the z.ai preset shipped bare `glm-5.2` and every tier
// ran at the standard window.
//
// These tests run against the REAL shipped descriptor, not a fixture. A fixture
// would prove the mechanism works and say nothing about whether the provider
// people actually use is configured correctly, which is precisely the gap the
// bug lived in.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SUFFIX, supportsExtendedContext } from '../../src/core/context.ts'
import { buildEnvPlan } from '../../src/core/env.ts'
import { byId, PROVIDERS } from '../../src/adapters/providers/registry.ts'
import { TIER_ENV_VARS } from '../../src/core/tiers.ts'

const zai = byId('zai')

test('REGRESSION: z.ai puts [1m] on all four tier variables', () => {
  const plan = buildEnvPlan({ provider: 'zai', apiKey: 'k' }, zai, {})
  for (const v of TIER_ENV_VARS) {
    assert.equal(plan.set[v], 'glm-5.2[1m]', `${v} must carry the suffix`)
  }
})

test('REGRESSION: no tier variable ever reaches Claude Code as bare glm-5.2', () => {
  // The precise shape of the shipped bug.
  const plan = buildEnvPlan({ provider: 'zai', apiKey: 'k' }, zai, {})
  const bare = TIER_ENV_VARS.filter((v) => plan.set[v] === 'glm-5.2')
  assert.deepEqual(bare, [], 'these tiers silently run at the standard window')
})

test('an existing config storing bare glm-5.2 is fixed at launch, not on disk', () => {
  // Migration is shape-only and deliberately repairs nothing. The suffix has to
  // reach existing users some other way, and that way is normalization at the
  // boundary — so a config.json written by 0.1.0 gains the fix with no rewrite.
  const stored = { provider: 'zai', apiKey: 'k', models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2', fable: 'glm-5.2' } }
  const plan = buildEnvPlan(stored, zai, {})
  for (const v of TIER_ENV_VARS) assert.equal(plan.set[v], 'glm-5.2[1m]')
  // The stored object is untouched: normalization happens on the way out.
  assert.equal(stored.models.opus, 'glm-5.2')
})

test('a hand-written [1m] is not doubled', () => {
  const stored = { provider: 'zai', apiKey: 'k', models: { opus: 'glm-5.2[1m]' } }
  const plan = buildEnvPlan(stored, zai, {})
  assert.equal(plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.2[1m]')
  assert.ok(!plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL.includes('[1m][1m]'))
})

test('a model the provider does not serve at 1M stays bare', () => {
  // Applying the suffix "where the model genuinely supports 1M" cuts both ways:
  // a user who pins an older GLM must not get a suffix the endpoint will not
  // honour just because the provider supports the wider window for something.
  const plan = buildEnvPlan(
    { provider: 'zai', apiKey: 'k', models: { opus: 'glm-4-air' } },
    zai,
    {},
  )
  assert.equal(plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-4-air')
  assert.equal(plan.set.ANTHROPIC_DEFAULT_SONNET_MODEL, 'glm-5.2[1m]')
})

test('a suffix is stripped for a provider that does not declare the capability', () => {
  // Sending an id the endpoint does not know is a hard failure; a narrower
  // window is merely disappointing.
  const plan = buildEnvPlan(
    { provider: 'siliconflow', apiKey: 'k', models: { opus: 'Pro/zai-org/GLM-4.6[1m]' } },
    byId('siliconflow'),
    {},
  )
  assert.equal(plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'Pro/zai-org/GLM-4.6')
})

test('only providers with a documented extended window declare one', () => {
  // Guards against the opposite failure: adding [1m] speculatively. Qwen,
  // DashScope and DeepSeek document no 1M window and must not acquire one by
  // someone copying the z.ai descriptor.
  const claiming = PROVIDERS.filter((p) => p.extendedContext?.supported).map((p) => p.id)
  assert.deepEqual(claiming, ['zai'], 'a provider gained an extended-context claim — is it documented?')
})

test('supportsExtendedContext is exact, not a prefix or substring match', () => {
  const ec = { supported: true, models: ['glm-5.2'], window: 1_000_000 }
  assert.equal(supportsExtendedContext('glm-5.2', ec), true)
  assert.equal(supportsExtendedContext(`glm-5.2${SUFFIX}`, ec), true)
  // A longer id that merely starts with a supported one is a DIFFERENT model.
  assert.equal(supportsExtendedContext('glm-5.2-flash', ec), false)
  assert.equal(supportsExtendedContext('glm-5', ec), false)
  assert.equal(supportsExtendedContext('glm-5.2', { supported: false, models: ['glm-5.2'] }), false)
})
