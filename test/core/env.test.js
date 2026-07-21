import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEnvPlan, materializeEnv } from '../../src/core/env.js'
import { TIER_ENV, TIERS } from '../../src/core/tiers.js'

const gateway = {
  id: 'gw',
  label: 'Gateway',
  baseUrl: 'https://gw.example/api',
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  defaultModels: { opus: 'big', sonnet: 'big', haiku: 'small', fable: 'small' },
}

const firstParty = {
  id: 'anthropic',
  label: 'Anthropic',
  baseUrl: null,
  credentialEnv: 'ANTHROPIC_API_KEY',
  credentialOptional: true,
  defaultModels: {},
}

const wide = {
  ...gateway,
  extendedContext: { supported: true, models: ['big'], window: 1_000_000 },
}

const POLLUTED = {
  PATH: '/usr/bin',
  ANTHROPIC_API_KEY: 'sk-ant-STALE',
  ANTHROPIC_BASE_URL: 'https://stale.example',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'stale-sonnet',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'stale-fable',
}

test('a stale ANTHROPIC_API_KEY is removed for every third-party provider', () => {
  // This is the highest-cost failure mode in the tool: the stale key makes
  // Claude Code fall back to Anthropic and bill the wrong account.
  const plan = buildEnvPlan({ provider: 'gw', apiKey: 'gw-key' }, gateway, POLLUTED)
  assert.ok(plan.unset.includes('ANTHROPIC_API_KEY'))
  assert.equal(plan.set.ANTHROPIC_API_KEY, undefined)
  assert.equal(plan.set.ANTHROPIC_AUTH_TOKEN, 'gw-key')
})

test('the billing guard is structural, not per-provider data', () => {
  // Any descriptor with a base URL and a non-API-key credential gets it,
  // including one invented here that no registry knows about.
  const invented = { id: 'x', baseUrl: 'https://x.example', credentialEnv: 'ANTHROPIC_AUTH_TOKEN', defaultModels: {} }
  const plan = buildEnvPlan({ apiKey: 'k' }, invented, POLLUTED)
  assert.ok(plan.unset.includes('ANTHROPIC_API_KEY'))
})

test('a provider that legitimately uses ANTHROPIC_API_KEY keeps it', () => {
  const proxied = { ...firstParty, baseUrl: 'https://proxy.example' }
  const plan = buildEnvPlan({ apiKey: 'sk-ant-real' }, proxied, POLLUTED)
  assert.equal(plan.set.ANTHROPIC_API_KEY, 'sk-ant-real')
  assert.ok(!plan.unset.includes('ANTHROPIC_API_KEY'))
})

test('Anthropic direct clears a gateway URL left in the shell', () => {
  const plan = buildEnvPlan({ provider: 'anthropic' }, firstParty, POLLUTED)
  assert.ok(plan.unset.includes('ANTHROPIC_BASE_URL'))
  assert.equal(plan.set.ANTHROPIC_BASE_URL, undefined)
})

test('Anthropic direct clears stale tier variables rather than inheriting them', () => {
  const plan = buildEnvPlan({ provider: 'anthropic' }, firstParty, POLLUTED)
  for (const tier of TIERS) assert.ok(plan.unset.includes(TIER_ENV[tier]), tier)
})

test('all four tiers are written, including fable', () => {
  const plan = buildEnvPlan({ apiKey: 'k' }, gateway, {})
  assert.equal(plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'big')
  assert.equal(plan.set.ANTHROPIC_DEFAULT_SONNET_MODEL, 'big')
  assert.equal(plan.set.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'small')
  assert.equal(plan.set.ANTHROPIC_DEFAULT_FABLE_MODEL, 'small')
})

test('tier resolution: absent inherits, empty unsets, pinned wins', () => {
  const plan = buildEnvPlan(
    { apiKey: 'k', models: { opus: 'pinned', sonnet: '' } },
    gateway,
    {},
  )
  assert.equal(plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'pinned') // pinned
  assert.ok(plan.unset.includes('ANTHROPIC_DEFAULT_SONNET_MODEL')) // '' == unset
  assert.equal(plan.set.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'small') // absent, inherited
  assert.equal(plan.set.ANTHROPIC_DEFAULT_FABLE_MODEL, 'small') // absent, inherited
})

test('a provider with no default for a tier unsets that tier', () => {
  const partial = { ...gateway, defaultModels: { opus: 'big' } }
  const plan = buildEnvPlan({ apiKey: 'k' }, partial, POLLUTED)
  assert.equal(plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'big')
  assert.ok(plan.unset.includes('ANTHROPIC_DEFAULT_FABLE_MODEL'))
})

test('[1m] is derived per variable, so no tier can be left behind', () => {
  const plan = buildEnvPlan({ apiKey: 'k' }, wide, {})
  assert.equal(plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'big[1m]')
  assert.equal(plan.set.ANTHROPIC_DEFAULT_SONNET_MODEL, 'big[1m]')
  // 'small' is not in extendedContext.models, so it must NOT be suffixed.
  assert.equal(plan.set.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'small')
  assert.equal(plan.set.ANTHROPIC_DEFAULT_FABLE_MODEL, 'small')
})

test('a hand-written [1m] in stored config is normalized at the boundary', () => {
  // Existing users get the fix at launch with no rewrite of their data.
  const plan = buildEnvPlan({ apiKey: 'k', models: { opus: 'big' } }, wide, {})
  assert.equal(plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'big[1m]')
  const stripped = buildEnvPlan({ apiKey: 'k', models: { opus: 'big[1m]' } }, gateway, {})
  assert.equal(stripped.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'big')
})

test("'' in profile.env means UNSET, not set-to-empty", () => {
  const plan = buildEnvPlan(
    { apiKey: 'k', env: { KEEP: 'yes', API_TIMEOUT_MS: '' } },
    { ...gateway, env: { API_TIMEOUT_MS: '3000000' } },
    {},
  )
  assert.equal(plan.set.KEEP, 'yes')
  assert.equal(plan.set.API_TIMEOUT_MS, undefined)
  assert.ok(plan.unset.includes('API_TIMEOUT_MS'))
})

test('profile.env is applied last and can override the billing guard', () => {
  const plan = buildEnvPlan(
    { apiKey: 'k', env: { ANTHROPIC_API_KEY: 'sk-ant-deliberate' } },
    gateway,
    POLLUTED,
  )
  assert.equal(plan.set.ANTHROPIC_API_KEY, 'sk-ant-deliberate')
  assert.ok(!plan.unset.includes('ANTHROPIC_API_KEY'))
})

test('set and unset are always disjoint', () => {
  const plan = buildEnvPlan(
    { apiKey: 'k', env: { A: '', B: 'x' } },
    { ...gateway, env: { A: '1' }, unsetEnv: ['B'] },
    POLLUTED,
  )
  for (const key of plan.unset) assert.equal(plan.set[key], undefined, key)
  assert.equal(plan.set.B, 'x') // a later write resurrects an earlier unset
  assert.ok(plan.unset.includes('A'))
})

test('an empty credential clears a stale one rather than leaving it', () => {
  const plan = buildEnvPlan({ apiKey: '' }, gateway, {
    ANTHROPIC_AUTH_TOKEN: 'leftover-from-another-project',
  })
  assert.ok(plan.unset.includes('ANTHROPIC_AUTH_TOKEN'))
})

test('apiKeyFromEnv reads the ambient env so no secret sits in the file', () => {
  const plan = buildEnvPlan({ apiKeyFromEnv: 'MY_TOKEN' }, gateway, { MY_TOKEN: 'from-shell' })
  assert.equal(plan.set.ANTHROPIC_AUTH_TOKEN, 'from-shell')
  const missing = buildEnvPlan({ apiKeyFromEnv: 'MY_TOKEN' }, gateway, {})
  assert.ok(missing.unset.includes('ANTHROPIC_AUTH_TOKEN'))
})

test('compat flags map to env vars and unset ones are never written', () => {
  const plan = buildEnvPlan(
    { apiKey: 'k' },
    { ...gateway, compat: { skipFastModeOrgCheck: true, enableToolSearch: false } },
    {},
  )
  assert.equal(plan.set.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, '1')
  assert.equal(plan.set.ENABLE_TOOL_SEARCH, undefined)
  assert.ok(!plan.unset.includes('ENABLE_TOOL_SEARCH'))
})

test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is not reachable from a compat flag', async () => {
  // It also disables gateway model discovery, so it must not hide behind a
  // boolean that reads like a harmless compatibility switch.
  const { COMPAT_ENV } = await import('../../src/core/env.js')
  const vars = Object.values(COMPAT_ENV).map(([k]) => k)
  assert.ok(!vars.includes('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
})

test('subagent pinning follows the resolved opus value', () => {
  const plan = buildEnvPlan(
    { apiKey: 'k', models: { opus: 'pinned' } },
    { ...wide, subagentFollowsOpus: true },
    {},
  )
  assert.equal(plan.set.CLAUDE_CODE_SUBAGENT_MODEL, 'pinned')
})

test('materializeEnv applies the plan and marks the child', () => {
  const plan = buildEnvPlan({ apiKey: 'k' }, gateway, POLLUTED)
  const env = materializeEnv(POLLUTED, plan)
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://gw.example/api')
  assert.ok(!('ANTHROPIC_API_KEY' in env))
  assert.equal(env.CUCKOOCODE, '1')
  // The ambient env passed in must not be mutated.
  assert.equal(POLLUTED.ANTHROPIC_API_KEY, 'sk-ant-STALE')
})

test('an unknown provider still honours the profile\'s own settings', () => {
  const plan = buildEnvPlan(
    { provider: 'gone', baseUrl: 'https://own.example', apiKey: 'k', models: { opus: 'm' } },
    null,
    POLLUTED,
  )
  assert.equal(plan.set.ANTHROPIC_BASE_URL, 'https://own.example')
  assert.equal(plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'm')
  assert.ok(plan.unset.includes('ANTHROPIC_API_KEY'))
})
