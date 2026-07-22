// The only code in swisscode that writes a credential.
//
// Every test here drives it through an injected `exec`, so nothing touches the
// real Keychain. The two properties worth the most are pinned first: the secret
// never reaches argv, and the blob crosses VERBATIM — a swap that dropped
// `refreshToken` would hand the target a login that dies hours later, far from
// the command that caused it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRawCredential, swapCredential } from '../../src/adapters/claude-session/swap.ts'
import { keychainService } from '../../src/adapters/claude-session/credentials.ts'

const fresh = () => mkdtempSync(join(tmpdir(), 'swisscode-swap-'))

/** The shape Claude Code actually stores, refresh token and all. */
const BLOB = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat-ACCESS',
    refreshToken: 'sk-ant-ort-REFRESH',
    expiresAt: 4102444800000,
    subscriptionType: 'max',
  },
})

/** A fake `security` that remembers what it was asked to do. */
function fakeSecurity(items: Record<string, string> = {}) {
  const calls: { args: string[]; input?: string }[] = []
  const exec = ((file: string, args: string[], opts?: { input?: string }) => {
    calls.push({ args, ...(opts?.input === undefined ? {} : { input: opts.input }) })
    assert.equal(file, '/usr/bin/security', 'PATH must never decide which binary handles a secret')
    if (args[0] === 'find-generic-password') {
      const service = args[args.indexOf('-s') + 1]!
      const found = items[service]
      if (found === undefined) {
        const e = new Error('not found') as Error & { status: number }
        e.status = 44
        throw e
      }
      return found
    }
    if (args[0] === 'delete-generic-password') {
      const service = args[args.indexOf('-s') + 1]!
      if (!(service in items)) {
        const e = new Error('not found') as Error & { status: number }
        e.status = 44
        throw e
      }
      delete items[service]
      return ''
    }
    throw new Error(`unexpected security verb ${args[0]}`)
  }) as never
  return { exec, calls, items }
}

const env = { HOME: '/home/u', USER: 'u' }

test('THE SECRET NEVER REACHES ARGV', async () => {
  // A password in argv is readable via `ps` by every user on the machine for as
  // long as the process lives. For a token worth a subscription that window is
  // not acceptable, and this is the assertion that keeps it shut.
  const from = fresh()
  const into = fresh()
  const fake = fakeSecurity({ [keychainService(from, env)]: BLOB })

  const result = swapCredential(from, into, { env, platform: 'darwin', exec: fake.exec })
  assert.equal(result.ok, true)

  for (const call of fake.calls) {
    for (const arg of call.args) {
      assert.doesNotMatch(arg, /ACCESS|REFRESH|sk-ant/, `secret found in argv: ${arg}`)
    }
  }
})

test('THE BLOB IS NEVER TRUNCATED — the bug that made this a file write', async () => {
  // REGRESSION, and a shipped-in-a-first-draft one. `security add-generic-password
  // -w` reading from stdin truncates at 128 bytes: 500 in, 128 stored, exit 0,
  // no warning. A real credential is ~3.9 kB, so the keychain path silently
  // stored a corrupt fragment — and the unit tests passed, because a fake
  // `security` has no buffer. Only reading it back off a real machine caught it.
  const from = fresh()
  const into = fresh()
  const big = JSON.stringify({
    claudeAiOauth: { accessToken: `sk-ant-oat-${'A'.repeat(2000)}`, refreshToken: 'sk-ant-ort-REFRESH' },
  })
  assert.ok(big.length > 128, 'the fixture must exceed the limit it is testing for')
  const fake = fakeSecurity({ [keychainService(from, env)]: big })

  swapCredential(from, into, { env, platform: 'darwin', exec: fake.exec })
  const written = readFileSync(join(into, '.credentials.json'), 'utf8').trim()
  assert.equal(written.length, big.length, 'the credential was truncated')
  assert.equal(written, big)
})

test('the blob crosses VERBATIM, refresh token included', async () => {
  // The swap moves opaque bytes. Moving only the access token would produce a
  // login that authenticates now and dies at the first refresh — the worst
  // possible failure shape, because it happens far from the cause.
  const from = fresh()
  const into = fresh()
  const fake = fakeSecurity({ [keychainService(from, env)]: BLOB })

  swapCredential(from, into, { env, platform: 'darwin', exec: fake.exec })
  const written = readFileSync(join(into, '.credentials.json'), 'utf8').trim()
  assert.equal(written, BLOB)
  assert.match(written, /sk-ant-ort-REFRESH/)
})

test('a competing keychain item is REMOVED so the file is authoritative', async () => {
  // After a swap there must be exactly one stored credential for the target,
  // and it must be the one just written. A stale keychain item beside a fresh
  // file makes "which login does this directory use?" depend on a precedence
  // rule inside someone else's binary.
  const from = fresh()
  const into = fresh()
  const intoSvc = keychainService(into, env)
  const fake = fakeSecurity({ [keychainService(from, env)]: BLOB, [intoSvc]: 'STALE' })

  swapCredential(from, into, { env, platform: 'darwin', exec: fake.exec })
  const deletion = fake.calls.find((c) => c.args[0] === 'delete-generic-password')
  assert.deepEqual(deletion?.args, ['delete-generic-password', '-s', intoSvc])
  // …and it happens AFTER the file exists, never before: a failed write must
  // not leave the directory with no login at all.
  assert.ok(readFileSync(join(into, '.credentials.json'), 'utf8').includes('sk-ant-oat-ACCESS'))
})

test('the SOURCE login is left exactly as it was', async () => {
  // The whole point. `/login` writes one global slot that every running session
  // re-reads; this touches the target and nothing else.
  const from = fresh()
  const into = fresh()
  const fromSvc = keychainService(from, env)
  const fake = fakeSecurity({ [fromSvc]: BLOB })

  swapCredential(from, into, { env, platform: 'darwin', exec: fake.exec })
  assert.equal(fake.items[fromSvc], BLOB, 'the source login was modified')
  assert.notEqual(keychainService(into, env), fromSvc, 'two dirs must hash to two services')
  for (const call of fake.calls) {
    if (call.args[0] === 'delete-generic-password') {
      assert.notEqual(call.args[2], fromSvc, 'the source item must never be deleted')
    }
  }
})

test('swapping into the same directory is refused rather than silently rewritten', async () => {
  const dir = fresh()
  const fake = fakeSecurity({ [keychainService(dir, env)]: BLOB })
  const result = swapCredential(dir, dir, { env, platform: 'darwin', exec: fake.exec })
  assert.equal(result.ok, false)
  assert.match((result as { reason: string }).reason, /same directory/)
  assert.equal(fake.calls.length, 0, 'nothing should have been asked of the keychain')
})

test('a source with no login is refused, and nothing is written', async () => {
  const fake = fakeSecurity({})
  const into = fresh()
  const result = swapCredential(fresh(), into, { env, platform: 'darwin', exec: fake.exec })
  assert.equal(result.ok, false)
  assert.match((result as { reason: string }).reason, /no login is stored/)
  assert.equal(
    fake.calls.filter((c) => c.args[0] === 'add-generic-password').length,
    0,
    'a failed read must never lead to a write',
  )
})

test('an unwritable target is refused, and says nothing changed', async () => {
  const from = fresh()
  const fake = fakeSecurity({ [keychainService(from, env)]: BLOB })
  // A path whose parent cannot be created.
  const result = swapCredential(from, '/proc/nonexistent/swisscode-target', {
    env,
    platform: 'darwin',
    exec: fake.exec,
  })
  assert.equal(result.ok, false)
  assert.equal(
    fake.calls.filter((c) => c.args[0] === 'delete-generic-password').length,
    0,
    'a failed write must never drop the target\'s existing login',
  )
})

test('the identity block is COPIED, or the swap is only half done', async () => {
  // Without this the token is the new account's while `/status` still names the
  // old one — the same silently-wrong-account confusion this whole feature
  // exists to end, reintroduced one layer down.
  const from = fresh()
  const into = fresh()
  writeFileSync(
    join(from, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'new@acct.com' }, projects: { a: 1 } }),
  )
  writeFileSync(
    join(into, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'old@acct.com' }, projects: { b: 2 } }),
  )
  const fake = fakeSecurity({ [keychainService(from, env)]: BLOB })

  const result = swapCredential(from, into, { env, platform: 'darwin', exec: fake.exec })
  assert.equal(result.ok && result.wroteIdentity, true)
  const after = JSON.parse(readFileSync(join(into, '.claude.json'), 'utf8'))
  assert.equal(after.oauthAccount.emailAddress, 'new@acct.com')
  // …without discarding what else lived in the file. Project history, MCP
  // servers and onboarding state have nothing to do with who pays.
  assert.deepEqual(after.projects, { b: 2 }, 'the target\'s own history was overwritten')
})

test('a target that has never been used gets a directory and a file', async () => {
  const from = fresh()
  const into = join(fresh(), 'brand-new')
  writeFileSync(join(from, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }))
  const fake = fakeSecurity({ [keychainService(from, env)]: BLOB })

  const result = swapCredential(from, into, { env, platform: 'darwin', exec: fake.exec })
  assert.equal(result.ok, true)
  assert.equal(statSync(into).mode & 0o777, 0o700, 'a directory holding a login is 0700')
  assert.equal(JSON.parse(readFileSync(join(into, '.claude.json'), 'utf8')).oauthAccount.emailAddress, 'a@b.c')
})

test('off macOS the credential is a file, and it is 0600', async () => {
  const from = fresh()
  const into = fresh()
  writeFileSync(join(from, '.credentials.json'), BLOB)
  const result = swapCredential(from, into, { env, platform: 'linux' })
  assert.equal(result.ok, true)
  assert.equal((result as { source: string }).source, 'file')
  const path = join(into, '.credentials.json')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.match(readFileSync(path, 'utf8'), /sk-ant-ort-REFRESH/)
})

test('readRawCredential prefers the keychain but falls back to the file', async () => {
  const dir = fresh()
  writeFileSync(join(dir, '.credentials.json'), BLOB)
  // No keychain item: the file answers.
  const viaFile = readRawCredential(dir, { env, platform: 'darwin', exec: fakeSecurity({}).exec })
  assert.equal(viaFile?.source, 'file')

  const fake = fakeSecurity({ [keychainService(dir, env)]: '{"claudeAiOauth":{"accessToken":"KC"}}' })
  const viaKeychain = readRawCredential(dir, { env, platform: 'darwin', exec: fake.exec })
  assert.equal(viaKeychain?.source, 'keychain')
  assert.match(viaKeychain!.blob, /KC/)
})

test('an identity that cannot be copied is REPORTED, not swallowed', async () => {
  // The token still moved; the caller has to be able to say the swap was
  // partial rather than claim a clean result.
  const from = fresh()
  const into = fresh()
  mkdirSync(join(into, '.claude.json'), { recursive: true }) // a directory where a file belongs
  const fake = fakeSecurity({ [keychainService(from, env)]: BLOB })
  const result = swapCredential(from, into, { env, platform: 'darwin', exec: fake.exec })
  assert.equal(result.ok, true)
  assert.equal((result as { wroteIdentity: boolean }).wroteIdentity, false)
})
