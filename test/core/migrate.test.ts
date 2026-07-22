import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUPPORTED_VERSION,
  emptyState,
  fromV1,
  isV1,
  migrate,
  normalize,
  validateProfileName,
} from '../../src/core/migrate.ts'
import { makeProfile } from '../support/fixtures.ts'

/** Exactly the shape swisscode 0.1.0 writes. */
const V1_FULL = {
  provider: 'zai',
  apiKey: 'zai-secret',
  models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2' },
  skipPermissions: true,
}

test('detects the 0.1.0 shape by structure, with no version field', () => {
  assert.ok(isV1(V1_FULL))
  assert.ok(!isV1({ version: 2, profiles: {} }))
  assert.ok(!isV1({ nothing: true }))
})

test('migrates a real 0.1.0 config into a named profile', () => {
  const { state, migratedFrom, corrupt, readOnly } = migrate(V1_FULL)
  assert.equal(migratedFrom, 1)
  assert.equal(corrupt, false)
  assert.equal(readOnly, false)
  assert.equal(state.version, SUPPORTED_VERSION)
  assert.equal(state.defaultProfile, 'zai')
  // v1 now chains through v2 into the three-way split, in one read.
  assert.deepEqual(state.providerAccounts.zai, { provider: 'zai', apiKey: 'zai-secret' })
  assert.deepEqual(state.agentProfiles.zai, {
    models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2' },
    skipPermissions: true,
  })
  assert.deepEqual(state.profiles.zai, {
    agentProfile: 'zai',
    accounts: ['zai'],
    strategy: 'single',
  })
  assert.deepEqual(state.bindings, {})
})

test('migration is shape-only: it repairs nothing', () => {
  // The [1m] fix reaches existing users at env-build time. Rewriting stored
  // model strings is `config doctor`'s job, invoked by a human.
  const { state } = migrate(V1_FULL)
  assert.equal(state.agentProfiles.zai!.models!.opus, 'glm-5.2')
  assert.equal(state.agentProfiles.zai!.models!.fable, undefined)
})

test('migration is lossless: unknown v1 keys ride along on the profile', () => {
  const { state } = migrate({ ...V1_FULL, somethingNew: { a: 1 }, note: 'hi' })
  // Read through Record<string, unknown>: rule M1 is that keys the SCHEMA does
  // not know survive migration verbatim, so by construction they cannot be
  // reachable through `Profile`. Giving Profile an index signature would make
  // this line compile and would simultaneously stop every other Profile
  // fixture in the suite from catching a misspelled field.
  // They ride on the AGENT PROFILE now: the split files a v2 profile's
  // non-credential fields there, and an unrecognized key is by definition not a
  // credential.
  const migrated = state.agentProfiles.zai as unknown as Record<string, unknown>
  assert.deepEqual(migrated.somethingNew, { a: 1 })
  assert.equal(migrated.note, 'hi')
})

test('migration is idempotent', () => {
  const once = migrate(V1_FULL).state
  const twice = migrate(once)
  assert.deepEqual(twice.state, once)
  assert.equal(twice.migratedFrom, null, 'a v2 state is not migrated again')
})

test('migration is deterministic: no timestamps, no ordering dependence', () => {
  const a = JSON.stringify(migrate(V1_FULL).state)
  const b = JSON.stringify(migrate({ ...V1_FULL }).state)
  assert.equal(a, b)
})

test('a minimal v1 config still produces a usable profile', () => {
  const { state } = migrate({ provider: 'anthropic' })
  assert.equal(state.defaultProfile, 'anthropic')
  assert.deepEqual(state.providerAccounts.anthropic, { provider: 'anthropic' })
  assert.deepEqual(state.agentProfiles.anthropic, {})
  assert.deepEqual(state.profiles.anthropic, {
    agentProfile: 'anthropic',
    accounts: ['anthropic'],
    strategy: 'single',
  })
})

test('a provider id that is not a legal profile name becomes "default"', () => {
  const { state } = migrate({ provider: '-weird name-' })
  assert.equal(state.defaultProfile, 'default')
  assert.equal(state.providerAccounts.default!.provider, '-weird name-')
})

test('a v1 custom-endpoint config keeps its baseUrl and env', () => {
  const { state } = migrate({
    provider: 'custom',
    baseUrl: 'https://local.example',
    apiKey: 'k',
    env: { API_TIMEOUT_MS: '600000' },
    models: { opus: 'm', sonnet: 'm', haiku: 'm' },
  })
  assert.equal(state.providerAccounts.custom!.baseUrl, 'https://local.example')
  assert.deepEqual(state.agentProfiles.custom!.env, { API_TIMEOUT_MS: '600000' })
})

test('models are picked down to the four tiers, values untouched', () => {
  const { state } = migrate({ provider: 'zai', models: { opus: 'a', bogus: 'b' } } as never)
  assert.deepEqual(state.agentProfiles.zai!.models, { opus: 'a' })
})

test('a v2 config is MIGRATED, and says so', () => {
  // The premise of this test inverted with v3: v2 used to be the terminal
  // shape, so "unchanged" was the correct assertion. It is now a rung on the
  // ladder, and `migratedFrom` is what authorizes the store to write the
  // upgraded file and keep a backup.
  const v2 = {
    version: 2,
    profiles: { a: { provider: 'zai', apiKey: 'k', models: { opus: 'glm-5.2' } } },
    defaultProfile: 'a',
    bindings: {},
    settings: {},
  }
  const r = migrate(v2)
  assert.equal(r.migratedFrom, 2)
  assert.equal(r.state.version, SUPPORTED_VERSION)
  assert.deepEqual(r.state.providerAccounts.a, { provider: 'zai', apiKey: 'k' })
  assert.deepEqual(r.state.agentProfiles.a, { models: { opus: 'glm-5.2' } })
  assert.deepEqual(r.state.profiles.a, {
    agentProfile: 'a',
    accounts: ['a'],
    strategy: 'single',
  })
})

test('an already-v3 config is returned unchanged and is not rewritten', () => {
  // The terminal rung. A launch that merely READS must not touch the disk, and
  // `migratedFrom: null` is the only thing that keeps it from doing so.
  const v3 = {
    version: 3,
    providerAccounts: { a: { provider: 'zai' } },
    agentProfiles: { a: {} },
    profiles: { a: { agentProfile: 'a', accounts: ['a'] } },
    defaultProfile: 'a',
    bindings: {},
    settings: {},
  }
  const r = migrate(v3)
  assert.equal(r.migratedFrom, null)
  assert.deepEqual(r.state, v3)
})

test('a NEWER schema is read best-effort and locked read-only', () => {
  const r = migrate({
    version: 99,
    providerAccounts: { a: { provider: 'zai' } },
    agentProfiles: { a: {} },
    profiles: { a: { agentProfile: 'a', accounts: ['a'] } },
    defaultProfile: 'a',
    futureThing: true,
  })
  assert.equal(r.readOnly, true)
  assert.equal(r.state.version, 99, 'the version must not be downgraded')
  assert.equal(r.state.providerAccounts.a!.provider, 'zai')
})

test('an unrecognizable object is treated as absent, not merged', () => {
  for (const junk of [null, 42, 'text', [], { nothing: 'here' }]) {
    const r = migrate(junk)
    assert.equal(r.corrupt, true, JSON.stringify(junk))
    assert.deepEqual(r.state.profiles, {})
  }
})

test('normalize resolves a dangling defaultProfile only when unambiguous', () => {
  const one = normalize({ version: 2, profiles: { solo: { provider: 'zai' } }, defaultProfile: 'gone' })
  assert.equal(one.state.defaultProfile, 'solo')

  const many = normalize({
    version: 2,    agentProfiles: {},
    profiles: { a: makeProfile({ provider: 'zai' }), b: { provider: 'openrouter' } },
    defaultProfile: 'gone',
  })
  // Never guess alphabetically — that silently picks an account to bill.
  assert.equal(many.state.defaultProfile, null)
  assert.ok(many.warnings.some((w) => w.includes('gone')))
})

test('normalize drops non-absolute binding keys with a warning', () => {
  const { state, warnings } = normalize({
    version: 2,    agentProfiles: {},
    profiles: {},
    bindings: { 'relative/path': 'a', '/abs/path': 'b' },
  })
  assert.deepEqual(Object.keys(state.bindings), ['/abs/path'])
  assert.ok(warnings.some((w) => w.includes('relative/path')))
})

test('normalize coerces a malformed profiles value instead of throwing', () => {
  for (const bad of ['nope', [], null]) {
    const { state } = normalize({ version: 2, profiles: bad })
    assert.deepEqual(state.profiles, {})
  }
})

test('normalize is idempotent', () => {
  const once = normalize(fromV1(V1_FULL)).state
  assert.deepEqual(normalize(once).state, once)
})

test('emptyState is a valid, launchable-but-unconfigured state', () => {
  const s = emptyState()
  assert.equal(s.version, SUPPORTED_VERSION)
  assert.deepEqual(s.profiles, {})
  assert.equal(s.defaultProfile, null)
})

test('profile names: grammar, reserved words and the common-word guard', () => {
  assert.ok(validateProfileName('or').ok)
  assert.ok(validateProfileName('work-2.prod').ok)
  assert.ok(!validateProfileName('-lead').ok, 'must never be mistakeable for a flag')
  assert.ok(!validateProfileName('two words').ok)
  assert.ok(!validateProfileName('').ok)
  assert.ok(!validateProfileName('--').ok)
  assert.ok(!validateProfileName('config').ok, 'reserved for subcommands')
  assert.ok(!validateProfileName('doctor').ok, 'soft-reserved for future subcommands')

  // `swisscode fix the login bug` must not silently select a profile.
  assert.ok(!validateProfileName('fix').ok)
  assert.ok(validateProfileName('fix', { force: true }).ok)
})
