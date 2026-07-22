// F#2 — the auto-compact window, set from measured data only.
//
// The rule that matters most here is the one about NOT acting: a guessed window
// is worse than no window. Too large and auto-compaction never fires, so the
// conversation overflows instead of summarising; too small and it fires
// constantly. Both are silent.
import test from 'node:test'
import assert from 'node:assert/strict'
import { autoCompactWindow, contextWindowFor } from '../../src/adapters/agents/claude-code/context.ts'
import { buildEnvPlan } from '../../src/adapters/agents/claude-code/env.ts'
import { byId } from '../../src/adapters/providers/registry.ts'
import type { ProviderDescriptor } from '../../src/ports/provider.ts'
import { makeProfile } from '../support/fixtures.ts'

const VAR = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'

const gateway: ProviderDescriptor = {
  id: 'gw',
  label: 'Gateway',
  baseUrl: 'https://gw.example/api',
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  defaultModels: { opus: 'big', sonnet: 'big', haiku: 'big', fable: 'big' },
}

const firstParty: ProviderDescriptor = {
  id: 'anthropic',
  label: 'Anthropic',
  baseUrl: null,
  credentialEnv: 'ANTHROPIC_API_KEY',
  credentialOptional: true,
  defaultModels: {},
}

const ec = { supported: true, models: ['big'], window: 1_000_000 }

// pure layer

test('contextWindowFor prefers a catalog-measured window over a documented one', () => {
  // The catalog describes the endpoint actually being called; the descriptor
  // describes the model family in general.
  assert.equal(contextWindowFor('big', ec, { big: 512_000 }), 512_000)
  assert.equal(contextWindowFor('big', ec, {}), 1_000_000)
})

test('contextWindowFor returns null for a model nobody has data on', () => {
  assert.equal(contextWindowFor('mystery', ec, {}), null)
  assert.equal(contextWindowFor('mystery', undefined, undefined), null)
  assert.equal(contextWindowFor('', ec, {}), null)
  assert.equal(contextWindowFor(undefined, ec, {}), null)
})

test('contextWindowFor sees through the [1m] suffix', () => {
  // The stored id and the emitted id differ by the suffix; lookups key on bare.
  assert.equal(contextWindowFor('big[1m]', ec, {}), 1_000_000)
  assert.equal(contextWindowFor('big[1m]', ec, { big: 700_000 }), 700_000)
})

test('contextWindowFor honours a per-model window override', () => {
  // kimi-k3 documents 1048576, not 1e6. A family-wide number would be wrong.
  const mixed = {
    supported: true,
    models: ['glm-5.2', 'kimi-k3'],
    window: 1_000_000,
    windows: { 'kimi-k3': 1_048_576 },
  }
  assert.equal(contextWindowFor('kimi-k3', mixed, {}), 1_048_576)
  assert.equal(contextWindowFor('glm-5.2', mixed, {}), 1_000_000)
})

test('contextWindowFor rejects nonsense captured windows', () => {
  // `unknown[]` because these values are DELIBERATELY ill-typed: the test
  // exists to prove contextWindowFor rejects a captured window that is not a
  // sane positive number. contextWindows is declared Record<string, number>,
  // so the fixture has to be cast past that declaration — the cast IS the
  // test. Typing the list as number[] would delete the '900000' and null cases.
  for (const bad of [0, -1, NaN, Infinity, '900000', null] as unknown[]) {
    assert.equal(
      contextWindowFor('mystery', ec, { mystery: bad } as Record<string, number>),
      null,
      `accepted ${bad}`,
    )
  }
})

test('autoCompactWindow takes the minimum across tiers', () => {
  // One variable has to cover four tiers, so the smallest is the only safe
  // answer: it is where the narrowest tier starts truncating.
  const windows = { a: 1_000_000, b: 200_000 }
  assert.equal(autoCompactWindow({ opus: 'a', sonnet: 'b' }, null, windows), 200_000)
})

test('autoCompactWindow refuses a partial answer', () => {
  // Knowing three of four windows is not three-quarters of an answer. Taking
  // the min over just the known ones would apply one model's window to another.
  const windows = { a: 1_000_000 }
  assert.equal(autoCompactWindow({ opus: 'a', sonnet: 'unknown' }, null, windows), null)
})

test('autoCompactWindow ignores tiers that are explicitly unset', () => {
  const windows = { a: 400_000 }
  assert.equal(autoCompactWindow({ opus: 'a', sonnet: '', haiku: '' }, null, windows), 400_000)
})

test('autoCompactWindow returns null when nothing is configured', () => {
  assert.equal(autoCompactWindow({}, ec, {}), null)
  assert.equal(autoCompactWindow({ opus: '', sonnet: '' }, ec, {}), null)
})

// env-plan layer

test('the window is set alongside [1m], never instead of it', () => {
  // Both mechanisms, together. The suffix widens the window; this says where to
  // start compacting inside it. Setting only this would widen nothing.
  const plan = buildEnvPlan(makeProfile({ apiKey: 'k' }), { ...gateway, extendedContext: ec }, {})
  assert.equal(plan.set[VAR], '1000000')
  assert.equal(plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'big[1m]')
})

test('a catalog-captured window reaches the environment', () => {
  const plan = buildEnvPlan(
    makeProfile({ apiKey: 'k', models: { opus: 'gpt-x', sonnet: 'gpt-x', haiku: 'gpt-x', fable: 'gpt-x' }, contextWindows: { 'gpt-x': 128_000 } }),
    gateway,
    {},
  )
  assert.equal(plan.set[VAR], '128000')
  // and it did NOT acquire a suffix it has no basis for
  assert.equal(plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'gpt-x')
})

test('an unknown model produces no window at all', () => {
  const plan = buildEnvPlan(makeProfile({ apiKey: 'k' }), gateway, {})
  assert.equal(plan.set[VAR], undefined)
  assert.ok(!plan.unset.includes(VAR))
})

test('first-party Anthropic never gets a window', () => {
  // Anthropic knows its own models' windows. The condition is structural — no
  // effective base URL — so a profile that clears the URL by hand behaves the
  // same as picking the Anthropic preset.
  const plan = buildEnvPlan(
    makeProfile({ apiKey: 'k', models: { opus: 'claude-opus-4-8' }, contextWindows: { 'claude-opus-4-8': 200_000 } }),
    firstParty,
    {},
  )
  assert.equal(plan.set[VAR], undefined)
})

test('a profile can still override the window by hand', () => {
  // profile.env is applied last and wins over everything, including this.
  const plan = buildEnvPlan(
    makeProfile({ apiKey: 'k', env: { [VAR]: '250000' } }),
    { ...gateway, extendedContext: ec },
    {},
  )
  assert.equal(plan.set[VAR], '250000')
})

test("a profile can clear the window with the '' sentinel", () => {
  const plan = buildEnvPlan(
    makeProfile({ apiKey: 'k', env: { [VAR]: '' } }),
    { ...gateway, extendedContext: ec },
    {},
  )
  assert.equal(plan.set[VAR], undefined)
  assert.ok(plan.unset.includes(VAR))
})

test('the shipped z.ai preset sets the window it documents', () => {
  const plan = buildEnvPlan({ provider: 'zai', apiKey: 'k' }, byId('zai'), {})
  assert.equal(plan.set[VAR], '1000000')
})

test('providers with no documented window set none', () => {
  for (const id of ['modelscope', 'siliconflow', 'openrouter', 'custom']) {
    const p = byId(id)
    const plan = buildEnvPlan({ provider: id, apiKey: 'k', baseUrl: 'https://x.example' }, p, {})
    assert.equal(plan.set[VAR], undefined, `${id} guessed a context window`)
  }
})
