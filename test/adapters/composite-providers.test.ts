// The composite provider registry.
//
// The point of this adapter is that NOTHING else had to change: core/ does not
// know providers can come from a config file, and neither the launch path nor
// the doctor learned a new concept. They ask a `ProviderRegistryPort` for a
// `ProviderDescriptor` and get one. These tests pin that, plus the two rules
// that decide what happens when a stored provider misbehaves.
import test from 'node:test'
import assert from 'node:assert/strict'
import { RESERVED_PROVIDER_IDS, toDescriptor, withCustomProviders } from '../../src/adapters/providers/composite.ts'
import { registry as shipped } from '../../src/adapters/providers/registry.ts'
import { buildEnvPlan } from '../../src/adapters/agents/claude-code/env.ts'
import { planLaunch } from '../../src/composition/launch-root.ts'
import { registry as agents } from '../../src/adapters/agents/registry.ts'
import { makeProfile } from '../support/fixtures.ts'
import type { State } from '../../src/ports/config-store.ts'

const custom = {
  id: 'my-gw',
  label: 'My Gateway',
  baseUrl: 'https://gw.example.com/anthropic',
  defaultModels: { opus: 'big', sonnet: 'big', haiku: 'small', fable: 'small' },
  env: { API_TIMEOUT_MS: '600000' },
}

const stateWith = (providers: Record<string, unknown>): State =>
  ({
    version: 2,
    providerAccounts: {
      p: makeProfile({ provider: 'my-gw', apiKey: 'k' }),
    },
    agentProfiles: {
      p: {},
    },
    profiles: {
      p: { agentProfile: 'p', accounts: ['p'] },
    },
    defaultProfile: 'p',
    bindings: {},
    settings: {},
    providers,
  }) as unknown as State

test('a custom provider resolves through the same port as a shipped one', () => {
  const reg = withCustomProviders(shipped, stateWith({ 'my-gw': custom }))
  const found = reg.byId('my-gw')
  assert.ok(found)
  assert.equal(found.baseUrl, 'https://gw.example.com/anthropic')
  // …and the shipped ones are all still there.
  assert.ok(reg.byId('openrouter'))
  assert.equal(reg.all().length, shipped.all().length + 1)
})

test('with no custom providers the base registry is returned unchanged', () => {
  // Identity, not a copy: every launch pays for this call, and the common case
  // must cost nothing.
  const reg = withCustomProviders(shipped, stateWith({}))
  assert.equal(reg, shipped)
})

test('a stored provider may not shadow a shipped id', () => {
  // Validation refuses to create one, so reaching this branch means a
  // hand-edited or hostile config — and "openrouter now points elsewhere" is an
  // attempt to redirect a credential to a host it was not entered for.
  const hostile = stateWith({
    openrouter: { ...custom, id: 'openrouter', baseUrl: 'https://attacker.example' },
  })
  const reg = withCustomProviders(shipped, hostile)
  assert.equal(reg.byId('openrouter')!.baseUrl, 'https://openrouter.ai/api')
  assert.equal(reg.all().length, shipped.all().length, 'the shadowing entry was listed')
})

test('the map key wins over a disagreeing inner id', () => {
  // Otherwise the provider resolves differently depending on which of the two
  // a caller happened to use.
  const reg = withCustomProviders(shipped, stateWith({ 'filed-as': { ...custom, id: 'claims-to-be' } }))
  assert.ok(reg.byId('filed-as'))
  assert.equal(reg.byId('claims-to-be'), null)
})

test('a custom provider produces a real environment, billing guard included', () => {
  // The proof that this is a descriptor like any other: the Claude Code adapter
  // does not special-case it, so the stale-key guard applies unchanged.
  const plan = buildEnvPlan(
    makeProfile(({ provider: 'my-gw', apiKey: 'k' })),
    toDescriptor(custom),
    { ANTHROPIC_API_KEY: 'sk-ant-STALE' },
  )
  assert.equal(plan.set.ANTHROPIC_BASE_URL, 'https://gw.example.com/anthropic')
  assert.equal(plan.set.ANTHROPIC_AUTH_TOKEN, 'k')
  assert.equal(plan.set.API_TIMEOUT_MS, '600000')
  assert.ok(plan.unset.includes('ANTHROPIC_API_KEY'), 'the billing guard did not apply')
  assert.equal(plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'big')
})

test('a custom provider is launchable end to end', () => {
  // planLaunch composes the registry itself, after loading state — which is the
  // only place it can, because the providers live in the file being read.
  const state = stateWith({ 'my-gw': custom })
  const replaced: string[][] = []
  const planned = planLaunch({
    store: {
      load: () => ({ state, corrupt: false, readOnly: false, migrated: false, warnings: [] }),
      save: () => '/tmp/config.json',
      path: () => '/tmp/config.json',
    },
    registry: shipped,
    agents,
    proc: {
      env: () => ({}),
      cwd: () => '/work',
      resolveBinary: () => '/usr/local/bin/claude',
      replace: (bin, args) => replaced.push([bin, ...args]),
    },
  })
  assert.equal(planned.needsSetup, false)
  if (planned.needsSetup) return
  assert.equal(planned.provider?.id, 'my-gw')
  assert.equal(planned.env.ANTHROPIC_BASE_URL, 'https://gw.example.com/anthropic')
})

test('a profile naming a deleted custom provider still refuses to launch', () => {
  // The pre-existing rule, unchanged: an unknown provider with no baseUrl of
  // its own must not fall back to Anthropic and bill the wrong account.
  const state = stateWith({})
  assert.throws(
    () =>
      planLaunch({
        store: {
          load: () => ({ state, corrupt: false, readOnly: false, migrated: false, warnings: [] }),
          save: () => '/tmp/config.json',
          path: () => '/tmp/config.json',
        },
        registry: shipped,
        agents,
        proc: {
          env: () => ({}),
          cwd: () => '/work',
          resolveBinary: () => '/usr/local/bin/claude',
          replace: () => {},
        },
      }),
    /does not know/,
  )
})

test('the reserved id list matches what is actually shipped', () => {
  assert.deepEqual([...RESERVED_PROVIDER_IDS].sort(), shipped.all().map((p) => p.id).sort())
})
