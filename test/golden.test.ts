// Characterization tests: the exact environment every shipped provider hands
// to Claude Code, against one fixed, deliberately polluted ambient env.
//
// These maps ARE the contract. A later phase that changes one must change it
// here too, in a diff a human reads on purpose.
//
// Diff against swisscode 0.1.0, all of it intentional (A#1 / A#2 / four tiers):
//
//   every third-party provider  ANTHROPIC_API_KEY now UNSET, not inherited.
//                               0.1.0 did this for openrouter only, so a stale
//                               key in the shell silently billed Anthropic on
//                               z.ai and custom launches.
//   anthropic                   ANTHROPIC_BASE_URL now UNSET. 0.1.0 guarded the
//                               write with `if (baseUrl)`, so "Anthropic
//                               (direct)" inherited whatever gateway URL was in
//                               the shell.
//   every provider              all four tier variables are always written or
//                               cleared. 0.1.0 wrote three of them and only
//                               when non-empty, so stale tier models and
//                               ANTHROPIC_DEFAULT_FABLE_MODEL survived.
//
// Correctness phase, one further intentional change:
//
//   zai                         every tier carries [1m] and the launch sets
//                               CLAUDE_CODE_AUTO_COMPACT_WINDOW. Bare glm-5.2
//                               ran all four tiers at the standard window.
//                               No other provider changes: none of the rest
//                               documents an extended window, and adding the
//                               suffix speculatively is the failure this phase
//                               is meant to prevent, not a second fix.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEnvPlan } from '../src/adapters/agents/claude-code/env.ts'
import { PROVIDERS, byId } from '../src/adapters/providers/registry.ts'

const AMBIENT = Object.freeze({
  PATH: '/usr/bin',
  HOME: '/home/u',
  ANTHROPIC_API_KEY: 'sk-ant-STALE',
  ANTHROPIC_BASE_URL: 'https://stale.gateway.example',
  ANTHROPIC_DEFAULT_SONNET_MODEL: 'stale-sonnet',
  ANTHROPIC_DEFAULT_FABLE_MODEL: 'stale-fable',
  CLAUDE_CODE_SUBAGENT_MODEL: 'stale-subagent',
})

const TIER_VARS = [
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
]

/**
 * One provider's expected plan. Declared so GOLDEN is indexable by a plain
 * provider id — `GOLDEN[provider.id]` is a lookup that is ALLOWED to miss, and
 * the `assert.ok(expected, ...)` below is the test that it does not. Leaving
 * GOLDEN as an inferred object literal would have made that lookup a compile
 * error and the assertion unreachable.
 */
type GoldenPlan = { set: Record<string, string>; unset: string[] }

const GOLDEN: Record<string, GoldenPlan> = {
  anthropic: {
    set: { ANTHROPIC_API_KEY: 'KEY' },
    unset: ['ANTHROPIC_BASE_URL', ...TIER_VARS],
  },
  zai: {
    set: {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      API_TIMEOUT_MS: '3000000',
      ANTHROPIC_AUTH_TOKEN: 'KEY',
      // [1m] ON ALL FOUR. Claude Code reads the suffix per variable, so this
      // list being uniform is the entire fix — one bare entry here would be a
      // tier silently running at the standard window.
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.2[1m]',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'glm-5.2[1m]',
      // Derived from the documented window for the models above, not guessed:
      // z.ai is the only shipped provider that declares extendedContext, so it
      // is the only one with a known window and no catalog to ask.
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
    },
    unset: ['ANTHROPIC_API_KEY'],
  },
  openrouter: {
    set: {
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1',
      ANTHROPIC_AUTH_TOKEN: 'KEY',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'openrouter/fusion',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'openrouter/fusion',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'openrouter/fusion',
      ANTHROPIC_DEFAULT_FABLE_MODEL: 'openrouter/fusion',
      CLAUDE_CODE_SUBAGENT_MODEL: 'openrouter/fusion',
    },
    unset: ['ANTHROPIC_API_KEY'],
  },
  modelscope: {
    set: {
      // Bare host. `/v1` here would yield /v1/v1/messages.
      ANTHROPIC_BASE_URL: 'https://api-inference.modelscope.cn',
      ANTHROPIC_AUTH_TOKEN: 'KEY',
    },
    unset: ['ANTHROPIC_API_KEY', ...TIER_VARS],
  },
  siliconflow: {
    set: {
      ANTHROPIC_BASE_URL: 'https://api.siliconflow.com',
      ANTHROPIC_AUTH_TOKEN: 'KEY',
    },
    unset: ['ANTHROPIC_API_KEY', ...TIER_VARS],
  },
  ollama: {
    set: {
      // Bare host, http, loopback. The cleartext guard exempts loopback, so
      // this is the one provider that ships an http:// URL without warning.
      ANTHROPIC_BASE_URL: 'http://localhost:11434',
      // compat.forceIdleTimeoutOff — "stalls on slow or locally hosted models",
      // which is this case exactly. Note the value is '0', not '1': the flag
      // turns the timeout OFF.
      API_FORCE_IDLE_TIMEOUT: '0',
      ANTHROPIC_AUTH_TOKEN: 'KEY',
    },
    // CLAUDE_CODE_SUBAGENT_MODEL is UNSET rather than absent: subagentFollowsOpus
    // pins it to the opus tier, this provider pins no models, and the ambient
    // env carries a stale value that must not survive into a local launch.
    unset: ['ANTHROPIC_API_KEY', ...TIER_VARS, 'CLAUDE_CODE_SUBAGENT_MODEL'],
  },
  'ollama-cloud': {
    set: {
      ANTHROPIC_BASE_URL: 'https://ollama.com',
      // ANTHROPIC_AUTH_TOKEN, never ANTHROPIC_API_KEY: ollama.com accepts only
      // `Authorization: Bearer`, and this is the spelling that produces one.
      ANTHROPIC_AUTH_TOKEN: 'KEY',
    },
    unset: ['ANTHROPIC_API_KEY', ...TIER_VARS, 'CLAUDE_CODE_SUBAGENT_MODEL'],
  },
  custom: {
    set: {
      ANTHROPIC_BASE_URL: 'https://custom.example',
      ANTHROPIC_AUTH_TOKEN: 'KEY',
    },
    unset: ['ANTHROPIC_API_KEY', ...TIER_VARS],
  },
}

function planFor(id: string) {
  // `!` because every caller passes an id straight out of PROVIDERS, so the
  // lookup cannot miss. byId returning null for an unknown id is the honest
  // contract and is exercised by registry.test.ts, not here.
  const provider = byId(id)!
  const profile = {
    provider: id,
    apiKey: 'KEY',
    ...(provider.askBaseUrl ? { baseUrl: 'https://custom.example' } : {}),
  }
  return buildEnvPlan(profile, provider, AMBIENT)
}

for (const provider of PROVIDERS) {
  test(`golden env plan: ${provider.id}`, () => {
    const expected = GOLDEN[provider.id]
    assert.ok(expected, `no golden map for provider "${provider.id}" — add one`)
    const plan = planFor(provider.id)
    assert.deepEqual(plan.set, expected.set)
    assert.deepEqual([...plan.unset].sort(), [...expected.unset].sort())
  })
}

test('every shipped provider has a golden map', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id).sort(), Object.keys(GOLDEN).sort())
})

test('no launch inherits a stale ANTHROPIC_API_KEY it did not ask for', () => {
  for (const provider of PROVIDERS) {
    const plan = planFor(provider.id)
    const inherited =
      !plan.unset.includes('ANTHROPIC_API_KEY') &&
      plan.set.ANTHROPIC_API_KEY === undefined
    assert.equal(inherited, false, `${provider.id} would inherit sk-ant-STALE`)
  }
})

test('no launch inherits a stale tier model it did not ask for', () => {
  for (const provider of PROVIDERS) {
    const plan = planFor(provider.id)
    for (const v of TIER_VARS) {
      const handled = plan.unset.includes(v) || typeof plan.set[v] === 'string'
      assert.equal(handled, true, `${provider.id} leaves ${v} to the shell`)
    }
  }
})
