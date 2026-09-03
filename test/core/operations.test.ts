// The proof that configuration editing no longer needs a front end.
//
// This file imports nothing from adapters/ or web/. If a terminal editor comes
// back, this is the surface it will drive — and the fact that a whole lifecycle
// is expressible here is what makes that a thin adapter rather than a rewrite.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  deleteAccount,
  deleteProfile,
  deleteProvider,
  deleteSetup,
  putAccount,
  putProfile,
  putProvider,
  putSettings,
  putSetup,
  setDefaultProfile,
} from '../../src/core/operations.ts'
import { emptyState } from '../../src/core/migrate.ts'
import type { State } from '../../src/ports/config-store.ts'

/** Unwrap a success, failing loudly with the refusal reason if it is not one. */
function ok(result: ReturnType<typeof putAccount>): State {
  assert.ok(result.ok, result.ok ? '' : `refused: ${result.reason}`)
  return result.state
}

test('a whole profile lifecycle runs through core operations alone', () => {
  let state = emptyState()

  state = ok(putAccount(state, 'work', { provider: 'zai', apiKey: 'zai-secret' }))
  assert.equal(state.providerAccounts.work?.provider, 'zai')

  state = ok(putSetup(state, 'main', { models: { opus: 'glm-5.2' }, skipPermissions: true }))
  assert.equal(state.setups.main?.models?.opus, 'glm-5.2')

  state = ok(putProfile(state, 'day', { setup: 'main', accounts: ['work'] }))
  assert.deepEqual(state.profiles.day, { setup: 'main', accounts: ['work'] })
  // The first profile becomes the default: a lone profile that is not the
  // default is a state a launch would refuse to start from.
  assert.equal(state.defaultProfile, 'day')

  state = ok(putProfile(state, 'day', { setup: 'main', accounts: ['work'], label: 'Daily' }))
  assert.equal(state.profiles.day?.label, 'Daily')

  state = ok(putProfile(state, 'night', { setup: 'main', accounts: ['work'] }))
  state = ok(setDefaultProfile(state, 'night'))
  assert.equal(state.defaultProfile, 'night')

  state = ok(deleteProfile(state, 'night'))
  assert.equal(state.defaultProfile, null, 'deleting the default clears it rather than guessing')
  assert.ok(state.profiles.day, 'the other profile survives')
})

test('a profile cannot reference a setup or account that does not exist', () => {
  const state = ok(putAccount(emptyState(), 'work', { provider: 'zai', apiKey: 'k' }))

  const noSetup = putProfile(state, 'p', { setup: 'nope', accounts: ['work'] })
  assert.equal(noSetup.ok, false)
  assert.match(noSetup.ok === false ? noSetup.reason : '', /no setup named "nope"/)

  const withSetup = ok(putSetup(state, 'main', {}))
  const noAccount = putProfile(withSetup, 'p', { setup: 'main', accounts: ['ghost'] })
  assert.equal(noAccount.ok, false)
  assert.match(noAccount.ok === false ? noAccount.reason : '', /no provider account named "ghost"/)
})

test('a refusal distinguishes a bad request from a name that is not there', () => {
  const state = emptyState()
  const gone = deleteProfile(state, 'nope')
  assert.equal(gone.ok, false)
  assert.equal(gone.ok === false ? gone.kind : '', 'missing', 'maps to 404')

  const bad = putAccount(state, 'x', { notAProvider: true })
  assert.equal(bad.ok, false)
  assert.equal(bad.ok === false ? bad.kind : '', 'invalid', 'maps to 400')
})

test('an empty apiKey does not erase a stored one, but an explicit null does', () => {
  // The single most destructive mistake an editor could make: a form the user
  // never touched submitting '' and silently wiping a credential.
  let state = ok(putAccount(emptyState(), 'a', { provider: 'zai', apiKey: 'secret' }))

  state = ok(putAccount(state, 'a', { provider: 'zai', apiKey: '' }))
  assert.equal(state.providerAccounts.a?.apiKey, 'secret', 'blank left the key alone')

  state = ok(putAccount(state, 'a', { provider: 'zai', apiKey: null }))
  assert.equal(state.providerAccounts.a?.apiKey, undefined, 'explicit null cleared it')
})

test('a key and a session directory together are refused, not resolved by precedence', () => {
  const both = putAccount(emptyState(), 'a', {
    provider: 'anthropic', apiKey: 'k', configDir: '/tmp/session',
  })
  assert.equal(both.ok, false)
})

test('deleting an account reports the profiles left dangling rather than repairing them', () => {
  let state = ok(putAccount(emptyState(), 'work', { provider: 'zai', apiKey: 'k' }))
  state = ok(putSetup(state, 'main', {}))
  state = ok(putProfile(state, 'day', { setup: 'main', accounts: ['work'] }))

  const result = deleteAccount(state, 'work')
  assert.ok(result.ok)
  assert.deepEqual(result.meta?.affectedProfiles, ['day'])
  // Only the user knows which account should pay instead.
  assert.ok(result.state.profiles.day, 'the profile is left in place, not deleted')
})

test('deleting a setup reports the profiles that used it', () => {
  let state = ok(putAccount(emptyState(), 'work', { provider: 'zai', apiKey: 'k' }))
  state = ok(putSetup(state, 'main', {}))
  state = ok(putProfile(state, 'day', { setup: 'main', accounts: ['work'] }))

  const result = deleteSetup(state, 'main')
  assert.ok(result.ok)
  assert.deepEqual(result.meta?.affectedProfiles, ['day'])
})

test('a custom provider is validated against rules the caller supplies', () => {
  // The rules are parameters because they are Claude Code's: core/ may not name
  // a CLAUDE_CODE_ or ANTHROPIC_ variable, so the adapter that owns them passes
  // them in.
  const rules = {
    reservedIds: ['zai', 'anthropic'],
    knownCompatFlags: ['forceIdleTimeoutOff'],
    credentialEnvs: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  }
  const shadow = putProvider(emptyState(), 'zai', {
    label: 'Mine', baseUrl: 'https://example.com', credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  }, rules)
  assert.equal(shadow.ok, false, 'a custom provider must not shadow a shipped preset')

  const fine = putProvider(emptyState(), 'mine', {
    label: 'Mine', baseUrl: 'https://example.com', credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  }, rules)
  assert.ok(fine.ok)
  assert.ok(fine.state.providers?.mine)
})

test('deleting a provider reports the accounts and profiles it orphans', () => {
  const rules = { reservedIds: [], knownCompatFlags: [], credentialEnvs: ['ANTHROPIC_AUTH_TOKEN'] }
  let state = ok(putProvider(emptyState(), 'mine', {
    label: 'Mine', baseUrl: 'https://example.com', credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  }, rules))
  state = ok(putAccount(state, 'acct', { provider: 'mine', apiKey: 'k' }))
  state = ok(putSetup(state, 'main', {}))
  state = ok(putProfile(state, 'day', { setup: 'main', accounts: ['acct'] }))

  const result = deleteProvider(state, 'mine')
  assert.ok(result.ok)
  assert.deepEqual(result.meta?.orphanedAccounts, ['acct'])
  assert.deepEqual(result.meta?.orphanedProfiles, ['day'])
})

test('settings take only the keys they define', () => {
  const result = putSettings(emptyState(), { quiet: true, bindingWalkDepth: 5, bogus: 'x' })
  assert.ok(result.ok)
  assert.equal(result.state.settings.quiet, true)
  assert.equal(result.state.settings.bindingWalkDepth, 5)
  assert.ok(!('bogus' in result.state.settings))
})

test('a context window that was not measured is dropped rather than stored', () => {
  // Feeds CLAUDE_CODE_AUTO_COMPACT_WINDOW: a window set too large overflows the
  // conversation instead of compacting it.
  const result = putSetup(emptyState(), 'main', {
    contextWindows: { good: 200000, zero: 0, negative: -1, fractional: 1.5, text: 'big' },
  })
  assert.ok(result.ok)
  assert.deepEqual(result.state.setups.main?.contextWindows, { good: 200000 })
})
