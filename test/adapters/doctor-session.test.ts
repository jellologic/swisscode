// The doctor's two session-mode jobs: say who a session directory is logged in
// as, and refresh the snapshot that `usage` selection reads.
//
// The second one closes a loop that was open in the shipped code:
// `core/resolve.ts` tells users "Run `swisscode config doctor` to refresh
// usage" when a `usage` profile has no snapshot, and until now the doctor had
// no idea what a snapshot was.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDoctor } from '../../src/composition/doctor-root.ts'
import { measureAccounts, remainingMap } from '../../src/adapters/usage/measure.ts'
import { registry } from '../../src/adapters/providers/registry.ts'
import { registry as agents } from '../../src/adapters/agents/registry.ts'
import { makeAccount, makeAgentProfile, makeProfileRefs, makeState } from '../support/fixtures.ts'
import type { SelectionStrategy, State } from '../../src/ports/config-store.ts'
import type { DoctorCheck } from '../../src/ports/doctor.ts'
import type { UsageSnapshot } from '../../src/core/resolve.ts'
import type { SubscriptionUsage } from '../../src/adapters/usage/anthropic-subscription.ts'

const fresh = () => mkdtempSync(join(tmpdir(), 'swisscode-doctor-'))

/** A measured window, shaped like the real payload but without the network. */
const usageOf = (remaining: number): SubscriptionUsage => ({
  remaining,
  limit: 100,
  used: 100 - remaining,
  unit: 'percent of window remaining',
  checkedAt: 0,
  fiveHour: { utilization: 100 - remaining, resetsAt: null },
  sevenDay: { utilization: 0, resetsAt: null },
  sevenDayOpus: { utilization: null, resetsAt: null },
  sevenDaySonnet: { utilization: null, resetsAt: null },
  extraUsage: null,
})

/** Write a `.claude.json` carrying a login, the way `/login` leaves it. */
function loginAt(dir: string, email: string): string {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({
      oauthAccount: {
        emailAddress: email,
        organizationRateLimitTier: 'default_claude_max_20x',
      },
    }),
  )
  return dir
}

type DepsOver = {
  state?: State
  usageStore?: { read: () => UsageSnapshot | null; write: (s: UsageSnapshot) => void }
}

function deps(over: DepsOver = {}) {
  const state =
    over.state ??
    makeState({
      version: 3,
      providerAccounts: { z: makeAccount({ provider: 'zai', apiKey: 'k' }) },
      agentProfiles: { z: makeAgentProfile({ models: { opus: 'glm-5.2' } }) },
      profiles: { z: makeProfileRefs({ agentProfile: 'z', accounts: ['z'] }) },
      defaultProfile: 'z',
      bindings: {},
      settings: {},
    })
  return {
    store: {
      load: () => ({ state, corrupt: false, readOnly: false, migrated: false, warnings: [] }),
      save: () => '/tmp/config.json',
      path: () => '/tmp/config.json',
      modes: () => ({ dir: 0o700, file: 0o600 }),
    },
    registry,
    agents,
    proc: {
      env: () => ({}),
      cwd: () => '/work',
      resolveBinary: () => '/usr/local/bin/claude',
      replace: () => {
        throw new Error('doctor must never launch anything')
      },
    },
    ...(over.usageStore ? { usage: over.usageStore } : {}),
  }
}

/** A state whose default profile is a session-mode Anthropic account. */
const sessionState = (configDir: string, over: { strategy?: SelectionStrategy } = {}): State =>
  makeState({
    version: 3,
    providerAccounts: { personal: makeAccount({ provider: 'anthropic', configDir }) },
    agentProfiles: { a: makeAgentProfile({ models: { opus: 'claude-opus-4-8' } }) },
    profiles: {
      a: makeProfileRefs({
        agentProfile: 'a',
        accounts: ['personal'],
        ...(over.strategy ? { strategy: over.strategy } : {}),
      }),
    },
    defaultProfile: 'a',
    bindings: {},
    settings: {},
  })

const byId = (checks: readonly DoctorCheck[], id: string) => checks.find((c) => c.id === id)

// ── the session login check ──

test('a logged-in session directory reports WHO, not just that it exists', async () => {
  const dir = loginAt(join(fresh(), 'personal'), 'a@b.c')
  const { report } = await runDoctor({ deps: deps({ state: sessionState(dir) }), offline: true })
  const check = byId(report.checks, 'session')
  assert.equal(check?.status, 'ok')
  // The email is the thing a user recognises — "which of my accounts is this?"
  assert.match(check!.detail, /a@b\.c/)
  assert.match(check!.detail, /Max 20x/)
})

test('a session directory that has never been used warns, and says how to fix it', async () => {
  // The failure this catches is late and expensive: the launch succeeds, the
  // process is replaced, and the first sign of trouble is the agent's own login
  // prompt — with swisscode gone and unable to explain.
  const dir = join(fresh(), 'never-created')
  const { report } = await runDoctor({ deps: deps({ state: sessionState(dir) }), offline: true })
  const check = byId(report.checks, 'session')
  assert.equal(check?.status, 'warn')
  assert.match(check!.detail, /never been used/)
  assert.equal(check!.fix, 'swisscode config accounts login personal')
})

test('used-but-logged-out is a DIFFERENT sentence from never-used', async () => {
  // Same fix, different problem: one is onboarding you have not done, the other
  // is a login that lapsed. A user told the right one stops guessing.
  const dir = join(fresh(), 'used')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ someOtherKey: true }))
  const { report } = await runDoctor({ deps: deps({ state: sessionState(dir) }), offline: true })
  const check = byId(report.checks, 'session')
  assert.equal(check?.status, 'warn')
  assert.match(check!.detail, /has been used but carries no login/)
  assert.doesNotMatch(check!.detail, /never been used/)
})

test('a key-mode profile gets no session check at all', async () => {
  // Not an OK check saying "n/a" — an absent one. A key account has no session
  // directory to be right or wrong about.
  const { report } = await runDoctor({ deps: deps(), offline: true })
  assert.equal(byId(report.checks, 'session'), undefined)
})

test('the session check runs under --offline, because it costs no network', async () => {
  const dir = loginAt(join(fresh(), 'personal'), 'a@b.c')
  const { report } = await runDoctor({ deps: deps({ state: sessionState(dir) }), offline: true })
  assert.equal(byId(report.checks, 'session')?.status, 'ok')
})

// ── the usage snapshot ──

test('no profile selects by usage, so nothing is measured and nothing prompts', async () => {
  const dir = loginAt(join(fresh(), 'personal'), 'a@b.c')
  let asked = 0
  const { report } = await runDoctor({
    deps: deps({ state: sessionState(dir) }),
    usageFetch: async () => {
      asked++
      return usageOf(50)
    },
  })
  assert.equal(asked, 0, 'measuring for figures nothing reads costs a Keychain prompt for nothing')
  assert.equal(byId(report.checks, 'usage-snapshot')?.status, 'skip')
  assert.match(byId(report.checks, 'usage-snapshot')!.detail, /no profile selects/)
})

test('--offline skips the refresh rather than measuring', async () => {
  const dir = loginAt(join(fresh(), 'personal'), 'a@b.c')
  let asked = 0
  const { report } = await runDoctor({
    deps: deps({ state: sessionState(dir, { strategy: 'usage' }) }),
    offline: true,
    usageFetch: async () => {
      asked++
      return usageOf(50)
    },
  })
  assert.equal(asked, 0)
  assert.match(byId(report.checks, 'usage-snapshot')!.detail, /--offline/)
})

test('a usage profile gets measured and the snapshot WRITTEN', async () => {
  const dir = loginAt(join(fresh(), 'personal'), 'a@b.c')
  const written: UsageSnapshot[] = []
  const { report } = await runDoctor({
    deps: deps({
      state: sessionState(dir, { strategy: 'usage' }),
      usageStore: { read: () => null, write: (s) => void written.push(s) },
    }),
    now: () => 1234,
    usageFetch: async () => usageOf(27),
  })
  assert.deepEqual(written, [{ remaining: { personal: 27 }, checkedAt: 1234 }])
  const check = byId(report.checks, 'usage-snapshot')
  assert.equal(check?.status, 'ok')
  assert.match(check!.detail, /personal 27% left/)
})

test('only the accounts a usage profile NAMES are measured', async () => {
  // Each measurement can raise a Keychain prompt. Measuring the whole machine
  // to answer a question about one profile is a cost with no answer attached.
  const dir = loginAt(join(fresh(), 'personal'), 'a@b.c')
  const other = loginAt(join(fresh(), 'other'), 'x@y.z')
  const state = makeState({
    version: 3,
    providerAccounts: {
      personal: makeAccount({ provider: 'anthropic', configDir: dir }),
      unused: makeAccount({ provider: 'anthropic', configDir: other }),
    },
    agentProfiles: { a: makeAgentProfile({ models: { opus: 'claude-opus-4-8' } }) },
    profiles: {
      a: makeProfileRefs({ agentProfile: 'a', accounts: ['personal'], strategy: 'usage' }),
      b: makeProfileRefs({ agentProfile: 'a', accounts: ['unused'] }),
    },
    defaultProfile: 'a',
    bindings: {},
    settings: {},
  })

  const asked: (string | null | undefined)[] = []
  await runDoctor({
    deps: deps({ state, usageStore: { read: () => null, write: () => {} } }),
    usageFetch: async (req) => {
      asked.push(req.sessionDir)
      return usageOf(40)
    },
  })
  assert.deepEqual(asked, [dir], 'the non-usage profile\'s account must not be touched')
})

test('nothing measurable leaves the cached snapshot ALONE rather than clearing it', async () => {
  // A stale figure that selection will age out beats no figure at all: the
  // alternative is falling back to "first account" the moment the endpoint
  // hiccups.
  const dir = loginAt(join(fresh(), 'personal'), 'a@b.c')
  const written: UsageSnapshot[] = []
  const { report } = await runDoctor({
    deps: deps({
      state: sessionState(dir, { strategy: 'usage' }),
      usageStore: { read: () => null, write: (s) => void written.push(s) },
    }),
    usageFetch: async () => null,
  })
  assert.deepEqual(written, [], 'the snapshot was overwritten with nothing')
  const check = byId(report.checks, 'usage-snapshot')
  assert.equal(check?.status, 'warn')
  assert.match(check!.detail, /left alone/)
})

test('a partly-measured set writes what it has and NAMES what it missed', async () => {
  // A partial snapshot still selects, and it selects among the accounts that
  // answered — so an account missing from it silently stops being a candidate.
  const a = loginAt(join(fresh(), 'a'), 'a@b.c')
  const b = loginAt(join(fresh(), 'b'), 'x@y.z')
  const state = makeState({
    version: 3,
    providerAccounts: {
      one: makeAccount({ provider: 'anthropic', configDir: a }),
      two: makeAccount({ provider: 'anthropic', configDir: b }),
    },
    agentProfiles: { p: makeAgentProfile({ models: { opus: 'claude-opus-4-8' } }) },
    profiles: {
      p: makeProfileRefs({ agentProfile: 'p', accounts: ['one', 'two'], strategy: 'usage' }),
    },
    defaultProfile: 'p',
    bindings: {},
    settings: {},
  })

  const written: UsageSnapshot[] = []
  const { report } = await runDoctor({
    deps: deps({ state, usageStore: { read: () => null, write: (s) => void written.push(s) } }),
    now: () => 99,
    usageFetch: async (req) => (req.sessionDir === a ? usageOf(80) : null),
  })
  assert.deepEqual(written, [{ remaining: { one: 80 }, checkedAt: 99 }])
  assert.equal(byId(report.checks, 'usage-snapshot')?.status, 'ok')
  const missed = byId(report.checks, 'usage-unmeasured')
  assert.equal(missed?.status, 'warn')
  assert.match(missed!.detail, /two/)
})

// ── the shared measurement loop ──

test('measureAccounts returns an entry per account, failures included', async () => {
  // Dropping the failures would make "could not be measured" indistinguishable
  // from "no longer exists" for anything rendering a list.
  const result = await measureAccounts(
    [{ name: 'a', configDir: '/a' }, { name: 'b', configDir: '/b' }],
    { fetchUsage: async (req) => (req.sessionDir === '/a' ? usageOf(10) : null), readIdentity: () => null },
  )
  assert.deepEqual(result.map((r) => r.name), ['a', 'b'])
  assert.equal(result[0]!.usage?.remaining, 10)
  assert.equal(result[1]!.usage, null)
})

test('a key-mode account is never asked — it has no window to be out of', async () => {
  let asked = 0
  const result = await measureAccounts([{ name: 'k' }], {
    fetchUsage: async () => {
      asked++
      return usageOf(1)
    },
    readIdentity: () => null,
  })
  assert.equal(asked, 0)
  assert.deepEqual(result, [{ name: 'k', configDir: null, identity: null, usage: null }])
})

test('accounts are measured SEQUENTIALLY, so Keychain dialogs cannot stack', async () => {
  let inFlight = 0
  let maxInFlight = 0
  await measureAccounts(
    [{ name: 'a', configDir: '/a' }, { name: 'b', configDir: '/b' }, { name: 'c', configDir: '/c' }],
    {
      readIdentity: () => null,
      fetchUsage: async () => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        inFlight--
        return usageOf(5)
      },
    },
  )
  assert.equal(maxInFlight, 1, 'three unlock dialogs at once is worse than waiting')
})

test('an unmeasured account is ABSENT from the map, never zero', () => {
  // Zero would read as "exhausted" and route work away from an account that may
  // be entirely free. Absent reads as "unknown", which is the truth.
  const map = remainingMap([
    { name: 'good', configDir: '/a', identity: null, usage: usageOf(42) },
    { name: 'failed', configDir: '/b', identity: null, usage: null },
    { name: 'key', configDir: null, identity: null, usage: null },
  ])
  assert.deepEqual(map, { good: 42 })
})
