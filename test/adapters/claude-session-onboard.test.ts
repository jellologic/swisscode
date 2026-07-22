// `config accounts login` — adopting a subscription.
//
// The thing under test is mostly REFUSAL. Creating a directory is trivial; the
// value is in what it declines to do quietly — retarget an existing login,
// mix a key with a session, or hand the agent a polluted environment that would
// make `/login` appear to do nothing.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountLogin, validateAccountName } from '../../src/adapters/claude-session/onboard.ts'
import { registry as agentRegistry } from '../../src/adapters/agents/registry.ts'
import type { State } from '../../src/ports/config-store.ts'

function harness(state: Partial<State> = {}, envOver: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'swisscode-onboard-'))
  const out: string[] = []
  const err: string[] = []
  const saved: State[] = []
  const replaced: { bin: string; argv: string[]; env: Record<string, string> }[] = []

  const store = {
    load: () => ({
      state: { version: 3, profiles: {}, bindings: {}, ...state } as State,
      warnings: [],
      readOnly: false,
    }),
    save: (s: State) => {
      saved.push(s)
    },
  }
  const proc = {
    env: () => ({ HOME: root, XDG_CONFIG_HOME: join(root, 'config'), ...envOver }),
    cwd: () => root,
    resolveBinary: () => '/usr/local/bin/claude',
    replace: (bin: string, argv: string[], env: Record<string, string>) => {
      replaced.push({ bin, argv, env })
    },
  }
  const run = (args: Parameters<typeof accountLogin>[0]) => accountLogin(args)
  return { root, out, err, saved, replaced, store, proc, run }
}

const base = (h: ReturnType<typeof harness>) => ({
  store: h.store as never,
  agents: agentRegistry,
  proc: h.proc as never,
  out: (l: string) => h.out.push(l),
  err: (l: string) => h.err.push(l),
})

test('a name that would escape the accounts directory is refused, not sanitised', () => {
  // A rejected name costs a second to fix. A sanitised one puts a login
  // somewhere the user did not ask for and cannot find.
  for (const bad of ['../evil', 'a/b', '.hidden', '', 'x/../../y']) {
    assert.equal(validateAccountName(bad).ok, false, `${JSON.stringify(bad)} should be refused`)
  }
  for (const good of ['personal', 'work-2', 'a.b_c', 'x1']) {
    assert.equal(validateAccountName(good).ok, true, `${good} should be allowed`)
  }
})

test('it creates the session directory at 0700 and records the account', () => {
  const h = harness()
  const code = h.run({ ...base(h), name: 'personal' })
  assert.equal(code, 0)

  const dir = join(h.root, 'config', 'swisscode', 'accounts', 'personal')
  assert.equal(statSync(dir).mode & 0o777, 0o700, 'a directory about to hold a login must be 0700')
  assert.equal(h.saved.at(-1)?.providerAccounts?.personal?.configDir, dir)
  assert.equal(h.saved.at(-1)?.providerAccounts?.personal?.provider, 'anthropic')
  assert.equal(h.saved.at(-1)?.providerAccounts?.personal?.apiKey, undefined)
})

test('it hands the agent a CLEAN environment, or /login would appear to do nothing', () => {
  // With either credential variable set, the agent authenticates as whoever
  // that key belongs to and the login flow never runs — the user sees a
  // working session and assumes it worked.
  const h = harness({}, { ANTHROPIC_API_KEY: 'sk-ant-stale', ANTHROPIC_AUTH_TOKEN: 'stale' })
  h.run({ ...base(h), name: 'personal' })

  const launched = h.replaced.at(-1)
  assert.ok(launched)
  assert.equal(launched.bin, '/usr/local/bin/claude')
  assert.equal(
    launched.env.CLAUDE_CONFIG_DIR,
    join(h.root, 'config', 'swisscode', 'accounts', 'personal'),
  )
  assert.equal(launched.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(launched.env.ANTHROPIC_AUTH_TOKEN, undefined)
})

test('it refuses to retarget an existing account at a different directory', () => {
  // Silently repointing would abandon a working login with no way back to it.
  const h = harness({
    providerAccounts: { personal: { provider: 'anthropic', configDir: '/existing/place' } },
  })
  const code = h.run({ ...base(h), name: 'personal' })
  assert.equal(code, 2)
  assert.equal(h.saved.length, 0, 'nothing may be written on refusal')
  assert.match(h.err.join('\n'), /already uses \/existing\/place/)
})

test('logging in again at the SAME directory is allowed — tokens do expire', () => {
  const root = mkdtempSync(join(tmpdir(), 'swisscode-relogin-'))
  const existing = join(root, 'place')
  const h = harness({
    providerAccounts: { personal: { provider: 'anthropic', configDir: existing } },
  })
  const code = h.run({ ...base(h), name: 'personal', dir: existing })
  assert.equal(code, 0)
  assert.equal(h.replaced.length, 1)
})

test('it refuses to give a key-mode account a session as well', () => {
  const h = harness({ providerAccounts: { personal: { provider: 'anthropic', apiKey: 'sk-x' } } })
  const code = h.run({ ...base(h), name: 'personal' })
  assert.equal(code, 2)
  assert.equal(h.saved.length, 0)
  assert.match(h.err.join('\n'), /key or a subscription login, never both/)
})

test('a relative --dir is resolved against the cwd, since this process execves away', () => {
  const h = harness()
  h.run({ ...base(h), name: 'personal', dir: 'sub/dir' })
  assert.equal(h.saved.at(-1)?.providerAccounts?.personal?.configDir, join(h.root, 'sub', 'dir'))
})

test('a read-only config refuses before creating anything', () => {
  const h = harness()
  const store = { ...h.store, load: () => ({ ...h.store.load(), readOnly: true }) }
  const code = h.run({ ...base(h), store: store as never, name: 'personal' })
  assert.equal(code, 2)
  assert.equal(h.replaced.length, 0, 'nothing may be launched when the account cannot be recorded')
})

test('a missing binary still records the account, and says how to finish by hand', () => {
  // The account is the durable half. Losing it because the CLI is not on PATH
  // would make the user redo the part that succeeded.
  const h = harness()
  const proc = {
    ...h.proc,
    resolveBinary: () => {
      throw new Error('claude was not found on PATH')
    },
  }
  const code = h.run({ ...base(h), proc: proc as never, name: 'personal' })
  assert.equal(code, 2)
  assert.equal(h.saved.length, 1, 'the account is still recorded')
  assert.match(h.err.join('\n'), /CLAUDE_CONFIG_DIR=/)
})

test('it reports when the adopted directory is already logged in', () => {
  const h = harness()
  const dir = join(h.root, 'adopted')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'a@b.c', organizationRateLimitTier: 'default_claude_max_5x' },
    }),
  )
  h.run({ ...base(h), name: 'adopted', dir })
  assert.match(h.out.join('\n'), /already logged in as a@b\.c {2}· {2}Max 5x/)
})

test('an adopted world-readable directory earns a warning rather than a silent chmod', () => {
  const h = harness()
  const dir = join(h.root, 'loose')
  mkdirSync(dir, { recursive: true, mode: 0o755 })
  h.run({ ...base(h), name: 'loose', dir })
  assert.match(h.err.join('\n'), /readable by other users/)
  // …and it still proceeds: narrowing someone else's directory under their feet
  // is not this command's call to make.
  assert.equal(h.replaced.length, 1)
})

test('the recorded config is exactly one account and nothing else', () => {
  const h = harness({ profiles: { p: { agentProfile: 'a', accounts: [] } } } as Partial<State>)
  h.run({ ...base(h), name: 'personal' })
  const saved = h.saved.at(-1)!
  assert.deepEqual(Object.keys(saved.providerAccounts ?? {}), ['personal'])
  assert.deepEqual(Object.keys(saved.profiles ?? {}), ['p'], 'existing config is preserved')
})

test('the created directory is empty — swisscode writes no credential into it', () => {
  const h = harness()
  h.run({ ...base(h), name: 'personal' })
  const dir = join(h.root, 'config', 'swisscode', 'accounts', 'personal')
  assert.deepEqual(readdirSync(dir), [], 'the agent creates its own files; swisscode creates none')
})
