// Resolution: a profile -> the one account + agent profile a launch uses.
//
// This is the step that decides WHICH ACCOUNT PAYS, so it gets exhaustive
// coverage of both the happy path and every way it can degrade. Degrading is
// the interesting half: two of the three strategies can silently fall back, and
// silence about billing is the failure this codebase is arranged around.
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveProfileRefs, selectAccount } from '../../src/core/resolve.ts'
import type { CursorPort } from '../../src/core/resolve.ts'
import type { State } from '../../src/ports/config-store.ts'

const state = (over: Partial<State> = {}): State =>
  ({
    version: 3,
    providerAccounts: {
      work: { provider: 'openrouter', apiKey: 'or-key' },
      backup: { provider: 'zai', apiKey: 'zai-key' },
      third: { provider: 'anthropic' },
    },
    agentProfiles: {
      main: { agent: 'kilo', models: { opus: 'm' }, skipPermissions: true },
    },
    profiles: {
      p: { agentProfile: 'main', accounts: ['work'] },
    },
    defaultProfile: 'p',
    bindings: {},
    settings: {},
    ...over,
  }) as unknown as State

/** An in-memory cursor, so rotation is observable without touching a disk. */
function cursorStore(initial: Record<string, number> = {}): CursorPort & { seen: number[] } {
  const store = { ...initial }
  const seen: number[] = []
  return {
    seen,
    read: (name) => (name in store ? store[name]! : null),
    advance: (name, next) => {
      store[name] = next
      seen.push(next)
    },
  }
}

// the happy path

test('resolution flattens the account and the agent profile together', () => {
  const r = resolveProfileRefs(state(), 'p')
  assert.ok(r.ok)
  // From the account…
  assert.equal(r.resolved.provider, 'openrouter')
  assert.equal(r.resolved.apiKey, 'or-key')
  // …and from the agent profile.
  assert.equal(r.resolved.agent, 'kilo')
  assert.equal(r.resolved.skipPermissions, true)
  assert.deepEqual(r.resolved.models, { opus: 'm' })
  // Both names travel with it, so a caller can REPORT which account paid.
  assert.equal(r.resolved.accountName, 'work')
  assert.equal(r.resolved.agentProfileName, 'main')
})

test('one agent profile can back several profiles', () => {
  // The point of the split: a shared setup is expressed by reference, not by
  // duplicating models and permissions into every profile that wants them.
  const s = state({
    profiles: {
      a: { agentProfile: 'main', accounts: ['work'] },
      b: { agentProfile: 'main', accounts: ['backup'] },
    },
  } as Partial<State>)
  const a = resolveProfileRefs(s, 'a')
  const b = resolveProfileRefs(s, 'b')
  assert.ok(a.ok && b.ok)
  assert.equal(a.resolved.provider, 'openrouter')
  assert.equal(b.resolved.provider, 'zai')
  assert.deepEqual(a.resolved.models, b.resolved.models, 'the shared setup really is shared')
})

// every reference failure names the fix

test('a missing agent profile is refused with the repair named', () => {
  const s = state({ profiles: { p: { agentProfile: 'gone', accounts: ['work'] } } } as Partial<State>)
  const r = resolveProfileRefs(s, 'p')
  assert.equal(r.ok, false)
  assert.match(r.reason, /agent profile "gone"/)
  assert.match(r.reason, /swisscode config p/, 'the message must say what to run')
})

test('a profile with no accounts is refused rather than defaulted', () => {
  // Picking "some other account" would be choosing who to bill.
  const s = state({ profiles: { p: { agentProfile: 'main', accounts: [] } } } as Partial<State>)
  const r = resolveProfileRefs(s, 'p')
  assert.equal(r.ok, false)
  assert.match(r.reason, /no provider account/)
})

test('a dangling account is skipped with a warning, not fatal', () => {
  // A profile with three accounts and one stale reference should still launch
  // on the other two.
  const s = state({
    profiles: { p: { agentProfile: 'main', accounts: ['gone', 'backup'] } },
  } as Partial<State>)
  const r = resolveProfileRefs(s, 'p')
  assert.ok(r.ok)
  assert.equal(r.resolved.accountName, 'backup')
  assert.match(r.warnings.join(' '), /"gone".*no longer exists/)
})

test('when every account is dangling it refuses and says how many', () => {
  const s = state({
    profiles: { p: { agentProfile: 'main', accounts: ['gone', 'also-gone'] } },
  } as Partial<State>)
  const r = resolveProfileRefs(s, 'p')
  assert.equal(r.ok, false)
  assert.match(r.reason, /2 provider account/)
})

// strategies

test('single takes the first account and says nothing', () => {
  const picked = selectAccount('p', ['work', 'backup'], 'single')
  assert.equal(picked.name, 'work')
  assert.deepEqual(picked.warnings, [])
})

test('round-robin advances once per launch and wraps', () => {
  const cursor = cursorStore()
  const accounts = ['a', 'b', 'c']
  const order = [0, 1, 2, 3, 4].map(() => selectAccount('p', accounts, 'round-robin', { cursor }).name)
  assert.deepEqual(order, ['a', 'b', 'c', 'a', 'b'], 'rotation must be sequential and wrap')
  assert.deepEqual(cursor.seen, [0, 1, 2, 0, 1])
})

test('round-robin with no cursor store degrades LOUDLY', () => {
  // Silently always-first would look identical to a working rotation from the
  // outside, right up until a bill arrives.
  const picked = selectAccount('p', ['a', 'b'], 'round-robin')
  assert.equal(picked.name, 'a')
  assert.match(picked.warnings.join(' '), /no cursor store/)
  assert.match(picked.warnings.join(' '), /same account/)
})

test('a corrupt cursor restarts the rotation rather than indexing out of range', () => {
  const cursor = cursorStore({ p: 99 })
  const picked = selectAccount('p', ['a', 'b'], 'round-robin', { cursor })
  assert.ok(['a', 'b'].includes(picked.name), 'must stay inside the account list')
})

test('usage picks the account with the most remaining, and reports the age', () => {
  const picked = selectAccount('p', ['a', 'b', 'c'], 'usage', {
    usage: { remaining: { a: 10, b: 900, c: 40 }, checkedAt: 0 },
    now: 600_000,
  })
  assert.equal(picked.name, 'b')
  assert.match(picked.warnings.join(' '), /10 minute/)
  // The honesty that matters: it cannot know the CURRENT figure.
  assert.match(picked.warnings.join(' '), /as fresh as the last check/)
})

test('usage ties keep the order the user wrote', () => {
  const picked = selectAccount('p', ['a', 'b'], 'usage', {
    usage: { remaining: { a: 100, b: 100 }, checkedAt: 0 },
  })
  assert.equal(picked.name, 'a', 'the listed order is the tiebreak, not object-key order')
})

test('usage with no snapshot falls back to single AND SAYS SO', () => {
  // The launch path may not reach the network, so this is the ordinary state on
  // a machine where the doctor has never run — it must not look like a choice.
  const picked = selectAccount('p', ['a', 'b'], 'usage')
  assert.equal(picked.name, 'a')
  assert.match(picked.warnings.join(' '), /nothing has measured it yet/)
  assert.match(picked.warnings.join(' '), /config doctor/)
})

test('usage ignores accounts nothing has measured', () => {
  const picked = selectAccount('p', ['unmeasured', 'measured'], 'usage', {
    usage: { remaining: { measured: 5 }, checkedAt: 0 },
  })
  assert.equal(picked.name, 'measured')
})

test('a single-account profile short-circuits every strategy', () => {
  // No cursor is consulted and no warning is produced: with one account there
  // is nothing to choose, whatever the strategy claims.
  for (const strategy of ['single', 'round-robin', 'usage'] as const) {
    const picked = selectAccount('p', ['only'], strategy)
    assert.equal(picked.name, 'only')
    assert.deepEqual(picked.warnings, [], `${strategy} warned about a choice it did not make`)
  }
})
