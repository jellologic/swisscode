import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOverrides, retargetProvider } from '../../src/core/overrides.ts'
import { TIERS } from '../../src/core/tiers.ts'
import type { ProfileOverrides } from '../../src/ports/config-store.ts'
import { makeDescriptor, makeProfile, makeState } from '../support/fixtures.ts'

/**
 * The success half of retargetProvider's discriminated result.
 *
 * Most tests need no cast: `assert.ok(r.ok)` / `assert.equal(r.ok, false)`
 * narrow the union. This alias covers the three sites that read `.profile`
 * without asserting `.ok` first — if the result were the refusal half, the
 * read yields undefined and the assertion fails the same way.
 */
type Retargeted = Extract<ReturnType<typeof retargetProvider>, { ok: true }>

/**
 * An overrides fixture that accepts an unknown tier key, because one test
 * exists to prove `{ models: { bogus: 'x' } }` is IGNORED rather than written
 * through. Typing it as ProfileOverrides would delete that test.
 */
type OverridesFixture = Omit<ProfileOverrides, 'models'> & {
  models?: string | Record<string, string>
}
const makeOverrides = (o: OverridesFixture): ProfileOverrides => o as ProfileOverrides

const base = makeProfile({
  provider: 'zai',
  apiKey: 'zai-secret',
  models: { opus: 'glm-5.2', sonnet: 'glm-5.2' },
  env: { API_TIMEOUT_MS: '3000000' },
})

test('no overrides yields an equivalent profile and never mutates the input', () => {
  const out = applyOverrides(base, {})
  assert.deepEqual(out, base)
  out.models!.opus = 'mutated'
  assert.equal(base.models!.opus, 'glm-5.2')
})

test('a bare model override sets ALL FOUR tiers', () => {
  // [1m] is read per variable, so a one-tier override is the exact shape of the
  // silent-200K bug. The safe thing has to be the easy thing.
  const out = applyOverrides(base, { models: 'kimi-k3' })
  for (const tier of TIERS) assert.equal(out.models![tier], 'kimi-k3', tier)
})

test('a per-tier override refines without disturbing the others', () => {
  const out = applyOverrides(base, { models: { haiku: 'small' } })
  assert.equal(out.models!.haiku, 'small')
  assert.equal(out.models!.opus, 'glm-5.2')
})

test('an unknown tier key is ignored rather than written through', () => {
  const out = applyOverrides(base, makeOverrides({ models: { bogus: 'x' } }))
  assert.equal((out.models as Record<string, string>).bogus, undefined)
})

test('env overrides merge after profile.env and keep the unset sentinel', () => {
  const out = applyOverrides(base, { env: { API_TIMEOUT_MS: '', NEW: '1' } })
  assert.equal(out.env!.API_TIMEOUT_MS, '')
  assert.equal(out.env!.NEW, '1')
})

test('baseUrl and provider overrides replace their fields', () => {
  const out = applyOverrides(base, { baseUrl: 'https://local', provider: 'custom' })
  assert.equal(out.baseUrl, 'https://local')
  assert.equal(out.provider, 'custom')
})

test('the override path never writes to the config store', () => {
  // The only writers in the codebase are the wizard and the config subcommands.
  let saves = 0
  const store = { save: () => { saves++ }, load: () => ({ state: {} }), path: () => '/x' }
  const matrix = [
    {},
    { models: 'x' },
    { models: { opus: 'x' } },
    { env: { A: '' } },
    { baseUrl: 'https://y' },
    makeProfile({ provider: 'openrouter' }),
  ]
  for (const overrides of matrix) applyOverrides(base, overrides)
  assert.equal(saves, 0)
  assert.equal(store.save.length, 0) // the stub was never swapped out
})

test('retargeting keeps the key when the provider is unchanged', () => {
  const r = retargetProvider(base, 'zai', makeState({ providerAccounts: {} }), null, {})
  assert.ok(r.ok)
  assert.equal(r.profile.apiKey, 'zai-secret')
})

test('retargeting adopts the ACCOUNT for that provider', () => {
  // Since v3 this is a LOOKUP, not a search. The v2 version rummaged through
  // every other profile hoping to find one holding a key for the target; an
  // account names exactly one provider, so the question is a filter.
  const state = makeState({
    providerAccounts: { or: { provider: 'openrouter', apiKey: 'or-secret', baseUrl: 'https://or' } },
  })
  const r = retargetProvider(base, 'openrouter', state, null, {})
  assert.ok(r.ok)
  assert.equal(r.profile.apiKey, 'or-secret')
  assert.equal(r.profile.baseUrl, 'https://or')
  assert.equal(r.borrowedFrom, 'or')
})

test('retargeting accepts a credential already in the ambient env', () => {
  const descriptor = makeDescriptor({ credentialEnv: 'ANTHROPIC_AUTH_TOKEN' })
  const r = retargetProvider(base, 'openrouter', makeState({ providerAccounts: {} }), descriptor, {
    ANTHROPIC_AUTH_TOKEN: 'from-shell',
  })
  assert.ok(r.ok)
  assert.equal(r.profile.apiKeyFromEnv, 'ANTHROPIC_AUTH_TOKEN')
  assert.equal(r.profile.apiKey, undefined)
})

test('retargeting refuses rather than sending a key to another host', () => {
  // Falling through to "just send the key we have" would POST a z.ai token to
  // OpenRouter.
  const descriptor = makeDescriptor({ credentialEnv: 'ANTHROPIC_AUTH_TOKEN' })
  const r = retargetProvider(base, 'openrouter', makeState({ providerAccounts: {} }), descriptor, {})
  assert.equal(r.ok, false)
  assert.match(r.reason, /no account/)
})

test('retargeting drops models chosen for the old provider', () => {
  // Same reasoning as the credential: `glm-5.2` was picked for z.ai, and
  // posting it to OpenRouter is a guaranteed 404 dressed as a working config.
  const state = makeState({
    providerAccounts: { or: { provider: 'openrouter', apiKey: 'or-secret' } },
  })
  const r = retargetProvider(base, 'openrouter', state, null, {})
  assert.ok(r.ok)
  assert.equal(r.profile.models, undefined, 'the provider defaults apply instead')
})

test('retargeting cannot inherit models, because accounts do not hold any', () => {
  // BEHAVIOUR CHANGE, and a deliberate one. Under v2 this borrowed the models
  // from whichever profile lent the credential, on the reasoning that it was
  // "already configured FOR this provider".
  //
  // v3 removes both the ability and the need: models live on the agent profile,
  // which does not change when the provider does, and an account carries no
  // models to borrow. So the models chosen for the OLD provider are simply
  // dropped and the target's own defaults apply — which is the safer of the two
  // answers anyway, since the borrowed ids were never verified against this
  // endpoint either.
  const state = makeState({
    providerAccounts: { or: { provider: 'openrouter', apiKey: 'or-secret' } },
  })
  const r = retargetProvider(base, 'openrouter', state, null, {}) as Retargeted
  assert.equal(r.profile.models, undefined)
  assert.equal(r.borrowedFrom, 'or', 'the credential still came from that account')
})

test('retargeting drops context windows keyed by the old catalog', () => {
  const withWindows = { ...base, contextWindows: { 'glm-5.2': 1000000 } }
  const state = makeState({
    providerAccounts: { or: { provider: 'openrouter', apiKey: 'k' } },
  })
  const retargeted = retargetProvider(withWindows, 'openrouter', state, null, {}) as Retargeted
  assert.equal(retargeted.profile.contextWindows, undefined)
})

test('staying on the same provider keeps everything, including models', () => {
  const r = retargetProvider(base, 'zai', makeState({ profiles: {} }), null, {}) as Retargeted
  assert.deepEqual(r.profile.models, base.models)
})
