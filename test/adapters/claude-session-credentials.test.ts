// Reading a session's OAuth token.
//
// The unhashed branch is verified against the REAL Keychain item on a live
// machine: `Claude Code-credentials`, read successfully, subscriptionType
// 'max'. These tests pin the derivation and — more importantly — the refusals.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  credentialFilePath,
  keychainService,
  readSessionCredential,
} from '../../src/adapters/claude-session/credentials.ts'

const HOME = '/home/u'
const env = { HOME }
const DEFAULT_DIR = `${HOME}/.claude`
const CUSTOM_DIR = `${HOME}/.claude-work`

/** The envelope Claude Code actually stores. */
const envelope = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat-TOKEN',
      refreshToken: 'sk-ant-ort-REFRESH',
      expiresAt: 4_000_000_000_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
      ...over,
    },
  })

const fail = (status: number) => () => {
  const e = new Error('security failed') as Error & { status: number }
  e.status = status
  throw e
}

test('the DEFAULT directory uses the unhashed service name', () => {
  // Verified against the real Keychain: this exact string is the live item.
  assert.equal(keychainService(DEFAULT_DIR, env), 'Claude Code-credentials')
})

test('a custom directory hashes the path into the name, and does so stably', () => {
  const name = keychainService(CUSTOM_DIR, env)
  assert.match(name, /^Claude Code-credentials-[0-9a-f]{8}$/)
  assert.equal(name, keychainService(CUSTOM_DIR, env), 'derivation must be deterministic')
  assert.notEqual(name, keychainService(`${HOME}/.claude-other`, env))
})

test('the hash covers the string that would be WRITTEN to the variable', () => {
  // Not a re-normalised spelling of it. Normalising here but not in the env
  // lowering would produce a name that is right in every test and wrong on
  // every machine, because the agent hashes what it was actually given.
  assert.notEqual(
    keychainService(CUSTOM_DIR, env),
    keychainService(`${CUSTOM_DIR}/`, env),
    'a different string is a different keychain item, and pretending otherwise reads the wrong account',
  )
})

test('the credential file has NO home/dir asymmetry, unlike .claude.json', () => {
  assert.equal(credentialFilePath(DEFAULT_DIR), `${DEFAULT_DIR}/.credentials.json`)
  assert.equal(credentialFilePath(CUSTOM_DIR), `${CUSTOM_DIR}/.credentials.json`)
})

test('a keychain hit is parsed, and the refresh token is NOT carried', () => {
  const r = readSessionCredential(DEFAULT_DIR, {
    env,
    platform: 'darwin',
    keychain: () => envelope(),
    now: 1_000,
  })
  assert.ok(r.ok)
  assert.equal(r.credential.accessToken, 'sk-ant-oat-TOKEN')
  assert.equal(r.credential.subscriptionType, 'max')
  assert.equal(r.credential.source, 'keychain')
  assert.equal(r.expired, false)
  // Nothing in swisscode may refresh, so nothing carries a refresh token —
  // it is not in the type and must not be in the value.
  assert.equal('refreshToken' in r.credential, false)
  assert.doesNotMatch(JSON.stringify(r.credential), /REFRESH/)
})

test('an expired token is REPORTED, never refreshed', () => {
  // Refreshing needs Anthropic's own OAuth client id — the impersonation line
  // this design stays behind. The agent refreshes it itself on next use.
  const r = readSessionCredential(DEFAULT_DIR, {
    env,
    platform: 'darwin',
    keychain: () => envelope({ expiresAt: 500 }),
    now: 1_000,
  })
  assert.ok(r.ok)
  assert.equal(r.expired, true)
  assert.equal(r.credential.accessToken, 'sk-ant-oat-TOKEN', 'still identifies the account')
})

test('a dismissed prompt is DENIED, not "never logged in"', () => {
  // These send the user to fix completely different things, so conflating them
  // would send them to fix the wrong one.
  const r = readSessionCredential(DEFAULT_DIR, {
    env,
    platform: 'darwin',
    keychain: fail(1),
    readFile: () => {
      throw new Error('ENOENT')
    },
  })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'denied')
  assert.match(r.reason, /nothing is wrong with the account/)
})

test('keychain exit 44 means the item is simply absent', () => {
  const r = readSessionCredential(CUSTOM_DIR, {
    env,
    platform: 'darwin',
    keychain: fail(44),
    readFile: () => {
      throw new Error('ENOENT')
    },
  })
  assert.equal(r.ok, false)
  assert.equal(r.kind, 'absent')
  assert.match(r.reason, /accounts login/)
})

test('off macOS it reads the file, and says so', () => {
  const r = readSessionCredential(CUSTOM_DIR, {
    env,
    platform: 'linux',
    keychain: () => assert.fail('the keychain must not be consulted off macOS'),
    readFile: (p) => {
      assert.equal(p, `${CUSTOM_DIR}/.credentials.json`)
      return envelope()
    },
    now: 1_000,
  })
  assert.ok(r.ok)
  assert.equal(r.credential.source, 'file')
})

test('on macOS a missing keychain item still falls through to the file', () => {
  // Some macOS setups end up with a file too. Trying both is what works, rather
  // than what the platform table says should.
  const r = readSessionCredential(CUSTOM_DIR, {
    env,
    platform: 'darwin',
    keychain: fail(44),
    readFile: () => envelope(),
    now: 1_000,
  })
  assert.ok(r.ok)
  assert.equal(r.credential.source, 'file')
})

test('a bare (unwrapped) envelope is tolerated', () => {
  const r = readSessionCredential(CUSTOM_DIR, {
    env,
    platform: 'linux',
    readFile: () => JSON.stringify({ accessToken: 'sk-bare', expiresAt: null }),
    now: 1_000,
  })
  assert.ok(r.ok)
  assert.equal(r.credential.accessToken, 'sk-bare')
  assert.equal(r.credential.expiresAt, null)
})

test('garbage never becomes a credential', () => {
  for (const body of ['', 'not json', '{}', '{"claudeAiOauth":{}}', '{"claudeAiOauth":{"accessToken":""}}', 'null']) {
    const r = readSessionCredential(CUSTOM_DIR, {
      env,
      platform: 'linux',
      readFile: () => body,
    })
    assert.equal(r.ok, false, `${JSON.stringify(body)} must not parse as a credential`)
  }
})

test('a failure reason never contains a token', () => {
  const r = readSessionCredential(CUSTOM_DIR, {
    env,
    platform: 'darwin',
    keychain: () => envelope(),
    now: 1_000,
  })
  assert.ok(r.ok)
  // …and the negative case: nothing on the failure branch echoes input.
  const bad = readSessionCredential(CUSTOM_DIR, {
    env,
    platform: 'linux',
    readFile: () => envelope({ accessToken: '' }),
  })
  assert.equal(bad.ok, false)
  assert.doesNotMatch(bad.reason, /sk-ant|TOKEN|REFRESH/)
})
