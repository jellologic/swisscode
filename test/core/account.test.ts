// The account questions three surfaces used to answer separately.
//
// These tests are the reason the module exists, not decoration on top of it:
// before it, the CLI, the web API, the launch path and the doctor each decided
// "does this account hold a key or a login?" for themselves, and they had
// already diverged into a wrong answer that shipped.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFLICT_REASON,
  accountsUsedBy,
  credentialSource,
  validateAccount,
} from '../../src/core/account.ts'

test('each way of holding a credential is named, including having none', () => {
  assert.equal(credentialSource({ apiKey: 'sk-x' }), 'key')
  assert.equal(credentialSource({ apiKeyFromEnv: 'MY_TOKEN' }), 'key-from-env')
  assert.equal(credentialSource({ configDir: '/home/u/.claude' }), 'session')
  assert.equal(credentialSource({}), 'none')
})

test('an env-var key outranks a stored one, matching what the launch presents', () => {
  // Not arbitrary: `apiKeyFromEnv` is the one that keeps the secret out of
  // config.json, so an account carrying both is described by the safer source.
  assert.equal(credentialSource({ apiKey: 'sk-x', apiKeyFromEnv: 'MY_TOKEN' }), 'key-from-env')
})

test('holding BOTH a key and a session directory is its own answer, not an error', () => {
  // THE BUG THIS MODULE WAS WRITTEN FOR. A shape that only modelled the three
  // valid states would have to pick one for the fourth, which is precisely the
  // silently-wrong-account behaviour the session feature exists to end.
  assert.equal(credentialSource({ apiKey: 'sk-x', configDir: '/d' }), 'conflict')
  assert.equal(credentialSource({ apiKeyFromEnv: 'T', configDir: '/d' }), 'conflict')
})

test('the redacted browser shape classifies identically to the server shape', () => {
  // The web API sends `hasKey: boolean` and never `apiKey`. If the classifier
  // did not understand that, the browser would need a fourth private copy of
  // this rule — the exact failure being fixed.
  assert.equal(credentialSource({ hasKey: true }), 'key')
  assert.equal(credentialSource({ hasKey: false }), 'none')
  assert.equal(credentialSource({ hasKey: true, configDir: '/d' }), 'conflict')
  // …and the two shapes agree with each other, which is the actual contract.
  for (const dir of [undefined, '/d']) {
    assert.equal(
      credentialSource({ apiKey: 'sk-x', ...(dir ? { configDir: dir } : {}) }),
      credentialSource({ hasKey: true, ...(dir ? { configDir: dir } : {}) }),
    )
  }
})

test('validation refuses the conflict with ONE sentence, shared by every surface', () => {
  // The three previous copies carried three different wordings. A user who hits
  // this in the browser and then in the terminal should not have to work out
  // whether it is the same problem.
  assert.equal(validateAccount({ provider: 'anthropic', apiKey: 'k', configDir: '/d' }), CONFLICT_REASON)
  assert.equal(validateAccount({ provider: 'anthropic', configDir: '/d' }), null)
  assert.equal(validateAccount({ provider: 'anthropic', apiKey: 'k' }), null)
  // A provider is still required, and that refusal comes first.
  assert.equal(validateAccount({ apiKey: 'k' }), 'provider is required')
})

test('an account with no credential at all is VALID — some providers need none', () => {
  // Ollama and anthropic-direct both authenticate without a key. Refusing this
  // would break the local-model path entirely.
  assert.equal(validateAccount({ provider: 'ollama' }), null)
})

test('the reverse index finds every profile naming an account, sorted', () => {
  const profiles = {
    work: { accounts: ['personal', 'spare'] },
    play: { accounts: ['personal'] },
    other: { accounts: ['someone-else'] },
    empty: {},
  }
  // Sorted, because two surfaces listing the same set in different orders reads
  // as a difference in meaning.
  assert.deepEqual(accountsUsedBy(profiles, 'personal'), ['play', 'work'])
  assert.deepEqual(accountsUsedBy(profiles, 'spare'), ['work'])
  assert.deepEqual(accountsUsedBy(profiles, 'unused'), [])
})

test('a missing or empty profile map is not a crash', () => {
  // Reached on a fresh config, and from the browser where the map arrives over
  // the wire and may legitimately be absent.
  assert.deepEqual(accountsUsedBy(undefined, 'x'), [])
  assert.deepEqual(accountsUsedBy(null, 'x'), [])
  assert.deepEqual(accountsUsedBy({}, 'x'), [])
})
