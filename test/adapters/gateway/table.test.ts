import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTable, modelFor, tierOf } from '../../../src/adapters/gateway/table.ts'
import { makeDescriptor } from '../../support/fixtures.ts'
import type { State } from '../../../src/ports/config-store.ts'
import type { ProviderRegistryPort, ProviderDescriptor } from '../../../src/ports/provider.ts'

const anthropic = makeDescriptor({
  id: 'anthropic',
  baseUrl: null,
  credentialEnv: 'ANTHROPIC_API_KEY',
  defaultModels: {},
})

const zai = makeDescriptor({
  id: 'zai',
  baseUrl: 'https://api.z.ai/api/anthropic',
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  defaultModels: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2', fable: 'glm-5.2' },
})

const registry = (...all: ProviderDescriptor[]): ProviderRegistryPort => ({
  all: () => all,
  byId: (id) => all.find((d) => d.id === id) ?? null,
})

/** Two profiles, so failover has somewhere to go. */
const twoProfiles = (): State =>
  ({
    version: 4,
    providerAccounts: {
      work: { provider: 'anthropic' },
      glm: { provider: 'zai', apiKey: 'zai-key' },
    },
    setups: {
      work: { models: { opus: 'claude-opus-5', sonnet: 'claude-sonnet-5' } },
      glm: {},
    },
    profiles: {
      work: { setup: 'work', accounts: ['work'], strategy: 'single' },
      glm: { setup: 'glm', accounts: ['glm'], strategy: 'single' },
    },
    defaultProfile: 'work',
    bindings: {},
    settings: {},
  }) as unknown as State

test('a route is derived per profile, primary first', () => {
  const table = buildTable(twoProfiles(), registry(anthropic, zai), ['work', 'glm'])
  assert.ok(table.ok)
  assert.deepEqual(table.routes.map((r) => r.profile), ['work', 'glm'])
})

test('a null descriptor baseUrl becomes the real Anthropic host', () => {
  // The launcher expresses "default endpoint" by leaving the variable unset.
  // A proxy has to name the host it will actually dial.
  const table = buildTable(twoProfiles(), registry(anthropic, zai), ['work'])
  assert.ok(table.ok)
  assert.equal(table.routes[0]?.baseUrl, 'https://api.anthropic.com')
})

test('the credential header follows the provider descriptor', () => {
  const table = buildTable(twoProfiles(), registry(anthropic, zai), ['work', 'glm'])
  assert.ok(table.ok)
  assert.equal(table.routes[0]?.header, 'x-api-key')
  assert.equal(table.routes[1]?.header, 'authorization')
})

test('an account with no key resolves to session mode rather than an empty key', () => {
  const table = buildTable(twoProfiles(), registry(anthropic, zai), ['work'])
  assert.ok(table.ok)
  // Empty credential is the signal that the caller's own login is forwarded.
  assert.equal(table.routes[0]?.credential, '')
  assert.equal(table.routes[0]?.provider, 'anthropic')
})

test('a credential is only ever attached to its own account’s route', () => {
  const table = buildTable(twoProfiles(), registry(anthropic, zai), ['work', 'glm'])
  assert.ok(table.ok)
  assert.equal(table.routes[1]?.credential, 'zai-key')
  // The key entered for z.ai must not appear on the Anthropic row.
  assert.equal(table.routes[0]?.credential, '')
})

test('an unknown profile fails the whole table rather than silently shrinking it', () => {
  const table = buildTable(twoProfiles(), registry(anthropic, zai), ['work', 'nope'])
  assert.equal(table.ok, false)
  assert.match(table.ok === false ? table.reason : '', /nope/)
})

test('an unregistered provider is reported, not skipped', () => {
  const table = buildTable(twoProfiles(), registry(anthropic), ['glm'])
  assert.equal(table.ok, false)
  assert.match(table.ok === false ? table.reason : '', /zai/)
})

test('building the table does not rotate a round-robin profile', () => {
  // resolveProfileRefs advances a cursor as a side effect when given one.
  // Passing one here would change which account a later launch picks, purely
  // because a gateway was started.
  const state = twoProfiles()
  state.profiles.work = { setup: 'work', accounts: ['work'], strategy: 'round-robin' }
  const before = JSON.stringify(state)
  const first = buildTable(state, registry(anthropic, zai), ['work'])
  const second = buildTable(state, registry(anthropic, zai), ['work'])
  assert.ok(first.ok && second.ok)
  assert.equal(JSON.stringify(state), before, 'state must not be mutated')
  // Rebuilding must be idempotent: if a cursor were threaded through, the
  // second build would select a different account than the first.
  assert.deepEqual(first.routes, second.routes)
})

test('tierOf finds which tier the client asked for', () => {
  const table = buildTable(twoProfiles(), registry(anthropic, zai), ['work', 'glm'])
  assert.ok(table.ok)
  const primary = table.routes[0]
  assert.ok(primary)
  assert.equal(tierOf(primary, 'claude-opus-5'), 'opus')
  assert.equal(tierOf(primary, 'claude-sonnet-5'), 'sonnet')
  assert.equal(tierOf(primary, 'something-else'), null)
})

test('failover asks the next profile for its model at the SAME tier', () => {
  const table = buildTable(twoProfiles(), registry(anthropic, zai), ['work', 'glm'])
  assert.ok(table.ok)
  const [primary, fallback] = table.routes
  assert.ok(primary && fallback)
  // An opus-tier request must not arrive at z.ai still saying claude-opus-5,
  // which is a 404 in a working request's costume.
  assert.equal(modelFor(fallback, tierOf(primary, 'claude-opus-5'), 'claude-opus-5'), 'glm-5.2')
})

test('a model matching no tier is forwarded verbatim rather than rewritten', () => {
  const table = buildTable(twoProfiles(), registry(anthropic, zai), ['work', 'glm'])
  assert.ok(table.ok)
  const fallback = table.routes[1]
  assert.ok(fallback)
  assert.equal(modelFor(fallback, null, 'some-custom-model'), 'some-custom-model')
})
