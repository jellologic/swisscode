// F#4 — warn on conflicting inherited environment.
//
// The profile always wins; these warnings only make the win visible. The one
// that matters most is the billing one, because a stale ANTHROPIC_API_KEY is
// the only failure in this tool that costs money while looking like success.
import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectAmbient, staleStoredModels } from '../../src/core/hygiene.ts'
import { buildEnvPlan } from '../../src/core/env.ts'
import { byId } from '../../src/adapters/providers/registry.ts'
import type { EnvWarning, PlanFacts } from '../../src/core/hygiene.ts'
import type { ProviderDescriptor } from '../../src/ports/provider.ts'
import type { Profile } from '../../src/ports/config-store.ts'
import type { EnvMap } from '../../src/ports/process.ts'
import { makeProfile } from '../support/fixtures.ts'

const gateway: ProviderDescriptor = {
  id: 'gw',
  label: 'Gateway',
  baseUrl: 'https://gw.example/api',
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  defaultModels: { opus: 'm', sonnet: 'm', haiku: 'm', fable: 'm' },
}

const codesOf = (ws: EnvWarning[]) => ws.map((w) => w.code).sort()
const find = (ws: EnvWarning[], code: string) => ws.find((w) => w.code === code)
const planFor = (
  profile: Profile | null | undefined,
  provider: ProviderDescriptor | null | undefined,
  ambient: EnvMap,
) => buildEnvPlan(profile, provider, ambient)

// the clean-environment case

test('a clean environment produces no warnings at all', () => {
  // The single most important property: this must be invisible unless there is
  // genuinely something to say.
  const plan = planFor(makeProfile({ apiKey: 'k' }), gateway, { PATH: '/usr/bin', HOME: '/home/u' })
  assert.deepEqual(plan.warnings, [])
})

test('an environment with unrelated ANTHROPIC-ish variables stays silent', () => {
  // We only warn about variables this launch actually touches. Something we do
  // not set cannot conflict with us.
  const plan = planFor(makeProfile({ apiKey: 'k' }), gateway, {
    ANTHROPIC_LOG_LEVEL: 'debug',
    CLAUDE_CODE_MAX_TURNS: '5',
  })
  assert.deepEqual(plan.warnings, [])
})

test('re-setting a variable to the value it already had is not a conflict', () => {
  const plan = planFor(makeProfile({ apiKey: 'k' }), gateway, {
    ANTHROPIC_BASE_URL: 'https://gw.example/api',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'm',
  })
  assert.deepEqual(codesOf(plan.warnings), [])
})

// billing (high)

test('a stale ANTHROPIC_API_KEY produces a high-severity billing warning', () => {
  const plan = planFor(makeProfile({ apiKey: 'k' }), gateway, { ANTHROPIC_API_KEY: 'sk-ant-STALE' })
  const w = find(plan.warnings, 'stale-anthropic-key')
  assert.ok(w, 'the highest-cost failure mode must be visible')
  assert.equal(w.severity, 'high')
  // It has to say WHY it matters, not just that something changed.
  assert.match(w.message, /billed/i)
  assert.match(w.message, /ANTHROPIC_API_KEY/)
})

test('the billing warning tells the user how to silence it', () => {
  const plan = planFor(makeProfile({ apiKey: 'k' }), gateway, { ANTHROPIC_API_KEY: 'sk-ant-STALE' })
  assert.match(find(plan.warnings, 'stale-anthropic-key')!.message, /unset ANTHROPIC_API_KEY/)
})

test('the billing warning does not leak the key itself', () => {
  // Warnings go to stderr, which lands in CI logs and pasted bug reports.
  const secret = 'sk-ant-SUPERSECRET-abcdef'
  const plan = planFor(makeProfile({ apiKey: 'k' }), gateway, { ANTHROPIC_API_KEY: secret })
  for (const w of plan.warnings) assert.ok(!w.message.includes(secret), 'a key reached a warning')
})

test('no billing warning fires when the key was not stale', () => {
  const plan = planFor(makeProfile({ apiKey: 'k' }), gateway, {})
  assert.equal(find(plan.warnings, 'stale-anthropic-key'), undefined)
})

test('first-party Anthropic replacing its own key warns differently', () => {
  // Not a billing accident — the user chose this account. Worth stating, not
  // worth the money-losing language.
  const plan = planFor(makeProfile({ apiKey: 'profile-key' }), byId('anthropic'), {
    ANTHROPIC_API_KEY: 'shell-key',
  })
  assert.equal(find(plan.warnings, 'stale-anthropic-key'), undefined)
  const w = find(plan.warnings, 'ambient-anthropic-key')
  assert.ok(w)
  assert.equal(w.severity, 'high')
})

// base URL (high)

test('an inherited base URL that gets overridden is reported with both values', () => {
  const plan = planFor(makeProfile({ apiKey: 'k' }), gateway, { ANTHROPIC_BASE_URL: 'https://stale.example' })
  const w = find(plan.warnings, 'ambient-base-url')
  assert.ok(w)
  assert.equal(w.severity, 'high')
  assert.match(w.message, /stale\.example/)
  assert.match(w.message, /gw\.example/)
})

test('an inherited base URL that gets CLEARED is reported too', () => {
  // The Anthropic-direct case. Silently clearing it is how someone spends an
  // afternoon wondering why their gateway is not being used.
  const plan = planFor(makeProfile({ apiKey: 'k' }), byId('anthropic'), {
    ANTHROPIC_BASE_URL: 'https://stale.example',
  })
  const w = find(plan.warnings, 'ambient-base-url')
  assert.ok(w)
  assert.match(w.message, /cleared/i)
})

// tier models (medium)

test('inherited tier models are reported in one line, not four', () => {
  const plan = planFor(makeProfile({ apiKey: 'k' }), gateway, {
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'stale-opus',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'stale-sonnet',
  })
  const tier = plan.warnings.filter((w) => w.code === 'ambient-tier-model')
  assert.equal(tier.length, 1)
  assert.equal(tier[0]!.severity, 'medium')
  assert.match(tier[0]!.message, /OPUS/)
  assert.match(tier[0]!.message, /SONNET/)
})

test('a tier being cleared rather than replaced says so', () => {
  const plan = planFor(makeProfile({ apiKey: 'k' }), byId('anthropic'), {
    ANTHROPIC_DEFAULT_FABLE_MODEL: 'stale-fable',
  })
  assert.match(find(plan.warnings, 'ambient-tier-model')!.message, /cleared/)
})

// the [1m] tripwire (medium)

test('a tier pinned to a model without the wider window is flagged', () => {
  // "One unsuffixed tier silently runs at the standard window" made visible.
  const plan = planFor(
    makeProfile({ apiKey: 'k', models: { opus: 'glm-4-air' } }),
    byId('zai'),
    {},
  )
  const w = find(plan.warnings, 'unsuffixed-tier')
  assert.ok(w, 'a tier running narrow must not be silent')
  assert.equal(w.severity, 'medium')
  assert.match(w.message, /glm-4-air/)
  assert.match(w.message, /glm-5\.2/)
})

test('the fully-suffixed default z.ai profile triggers no tripwire', () => {
  const plan = planFor(makeProfile({ apiKey: 'k' }), byId('zai'), {})
  assert.equal(find(plan.warnings, 'unsuffixed-tier'), undefined)
})

test('a provider with no extended context never triggers the tripwire', () => {
  const plan = planFor(makeProfile({ apiKey: 'k' }), gateway, {})
  assert.equal(find(plan.warnings, 'unsuffixed-tier'), undefined)
})

test('an environment that disables 1M context is flagged loudly', () => {
  // Everything F#14 does is silently ignored while this is set, and the config
  // still reads as correct. Highest-value warning after the billing one.
  const plan = planFor(makeProfile({ apiKey: 'k' }), byId('zai'), { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' })
  const w = find(plan.warnings, 'extended-context-disabled')
  assert.ok(w)
  assert.equal(w.severity, 'high')
  assert.match(w.message, /\[1m\]/)
})

test('the 1M kill-switch is irrelevant for a provider without extended context', () => {
  const plan = planFor(makeProfile({ apiKey: 'k' }), gateway, { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' })
  assert.equal(find(plan.warnings, 'extended-context-disabled'), undefined)
})

// compat flags (info)

test('active compat flags are reported at info severity only', () => {
  // Nothing is wrong; this is for someone debugging a gateway. It must not
  // appear on a normal launch, which is why launch-root drops `info`.
  const plan = planFor(makeProfile({ apiKey: 'k', compat: { disableAdaptiveThinking: true } }), gateway, {})
  const w = find(plan.warnings, 'compat-flags-active')
  assert.ok(w)
  assert.equal(w.severity, 'info')
  assert.match(w.message, /CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING/)
})

// mechanics

test('every warning carries a severity, a code and a message', () => {
  const plan = planFor(makeProfile({ apiKey: 'k', compat: { enableToolSearch: true } }), gateway, {
    ANTHROPIC_API_KEY: 'sk-ant-STALE',
    ANTHROPIC_BASE_URL: 'https://stale.example',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'stale',
  })
  assert.ok(plan.warnings.length >= 3)
  for (const w of plan.warnings) {
    assert.ok(['high', 'medium', 'info'].includes(w.severity), `bad severity ${w.severity}`)
    assert.ok(w.code && typeof w.code === 'string')
    assert.ok(w.message && w.message.length > 20)
  }
})

test('warnings are advisory: the plan is identical with and without a dirty env', () => {
  // "Profile wins; the warning is informational." Detection must never change
  // what actually gets launched.
  const clean = planFor(makeProfile({ apiKey: 'k' }), gateway, {})
  const dirty = planFor(makeProfile({ apiKey: 'k' }), gateway, {
    ANTHROPIC_BASE_URL: 'https://stale.example',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'stale',
  })
  assert.deepEqual(dirty.set, clean.set)
  assert.deepEqual(dirty.unset.sort(), clean.unset.sort())
})

test('inspection reads the plan, never the whole environment', () => {
  // The performance contract. A huge ambient env costs nothing extra because
  // lookups are keyed by the plan's dozen variables, not iterated over env.
  const huge: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-ant-STALE' }
  for (let i = 0; i < 5000; i++) huge[`ANTHROPIC_NOISE_${i}`] = String(i)

  let reads = 0
  const counting = new Proxy(huge, {
    get(t: Record<string, string>, k: string | symbol) {
      reads++
      return t[k as string]
    },
    // A scan would have to enumerate. Make that observable.
    ownKeys() {
      throw new Error('inspectAmbient enumerated the ambient environment')
    },
  })

  const plan = buildEnvPlan(makeProfile({ apiKey: 'k' }), gateway, {})
  const warnings = inspectAmbient(plan, counting, { provider: gateway })
  assert.ok(find(warnings, 'stale-anthropic-key'))
  assert.ok(reads < 100, `inspectAmbient made ${reads} env reads; expected a bounded few`)
})

test('inspectAmbient tolerates a missing plan or environment', () => {
  assert.deepEqual(inspectAmbient({ set: {}, unset: [] }, {}, {}), [])
  assert.deepEqual(inspectAmbient({} as PlanFacts, undefined, {}), [])
})

// stored-model advice (doctor)

test('staleStoredModels reports a stored bare id that should carry the suffix', () => {
  const found = staleStoredModels(makeProfile({ models: { opus: 'glm-5.2' } }), byId('zai'))
  assert.deepEqual(found, [
    { tier: 'opus', stored: 'glm-5.2', suggested: 'glm-5.2[1m]', reason: 'missing' },
  ])
})

test('staleStoredModels reports a suffix the provider cannot honour', () => {
  const found = staleStoredModels(makeProfile({ models: { opus: 'Pro/GLM[1m]' } }), byId('siliconflow'))
  assert.deepEqual(found, [
    { tier: 'opus', stored: 'Pro/GLM[1m]', suggested: 'Pro/GLM', reason: 'unsupported' },
  ])
})

test('staleStoredModels is silent on a correct profile', () => {
  assert.deepEqual(staleStoredModels(makeProfile({ models: { opus: 'glm-5.2[1m]' } }), byId('zai')), [])
  assert.deepEqual(staleStoredModels(makeProfile({ models: {} }), byId('zai')), [])
  assert.deepEqual(staleStoredModels(makeProfile({}), byId('zai')), [])
})
