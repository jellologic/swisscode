import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveProfile } from '../../src/core/profile.ts'
import { makeState } from '../support/fixtures.ts'

// `assert.match(sel.error!, …)` throughout this file.
//
// `ProfileSelection.error` is `string | null` and assert.match takes a string.
// The `!` is a COMPILE-TIME claim and nothing else: it erases, so at runtime
// these calls are byte-for-byte what they were. If `error` were ever null the
// call throws ERR_INVALID_ARG_TYPE and the test fails — exactly as it did
// before. Nothing here is softened to `if (error) assert.match(...)`, which
// WOULD weaken it by turning a null into a silent pass.

const state = {
  version: 2,
  providerAccounts: { z: { provider: 'zai' }, or: { provider: 'openrouter' } },
  agentProfiles: { z: {}, or: {} },
  profiles: {
    z: { agentProfile: 'z', accounts: ['z'] },
    or: { agentProfile: 'or', accounts: ['or'] },
  },
  defaultProfile: 'z',
  bindings: { '/work/or-project': 'or' },
  settings: {},
}

test('a directory binding beats the default profile', () => {
  const sel = resolveProfile(state, { cwd: '/work/or-project/src' })
  assert.equal(sel.name, 'or')
  assert.equal(sel.source, 'binding')
  assert.equal(sel.bindingKey, '/work/or-project')
})

test('outside any binding, the default profile wins', () => {
  const sel = resolveProfile(state, { cwd: '/somewhere/else' })
  assert.equal(sel.name, 'z')
  assert.equal(sel.source, 'default')
})

test('a missing cwd skips the binding tier without failing', () => {
  // A deleted working directory must never prevent a launch.
  const sel = resolveProfile(state, { cwd: null })
  assert.equal(sel.name, 'z')
  assert.equal(sel.source, 'default')
})

test('a binding pointing at a deleted profile warns and falls through', () => {
  const stale = { ...state, bindings: { '/work/or-project': 'deleted' } }
  const sel = resolveProfile(stale, { cwd: '/work/or-project' })
  assert.equal(sel.name, 'z')
  assert.equal(sel.source, 'default')
  assert.ok(sel.warnings.some((w) => w.includes('deleted')))
})

test('no profiles at all resolves to nothing, which means the wizard', () => {
  const sel = resolveProfile(makeState({ profiles: {}, defaultProfile: null }), { cwd: '/x' })
  assert.equal(sel.profile, null)
  assert.equal(sel.source, null)
  assert.equal(sel.ambiguous, false)
})

test('exactly one profile and no default is not ambiguous', () => {
  const sel = resolveProfile(
    makeState({ providerAccounts: { solo: { provider: 'zai' } }, agentProfiles: { solo: {} }, profiles: { solo: { agentProfile: 'solo', accounts: ['solo'] } }, defaultProfile: 'solo' }),
    { cwd: '/x' },
  )
  assert.equal(sel.name, 'solo')
})

test('several profiles and no default is ambiguous, never a guess', () => {
  const sel = resolveProfile({ ...state, defaultProfile: null }, { cwd: '/x' })
  assert.equal(sel.profile, null)
  assert.equal(sel.ambiguous, true, 'must not pick alphabetically')
})

test('binding overrides ride along with the selection', () => {
  const withOverrides = {
    ...state,
    bindings: { '/work/or-project': { profile: 'or', overrides: { baseUrl: 'https://x' } } },
  }
  const sel = resolveProfile(withOverrides, { cwd: '/work/or-project' })
  assert.deepEqual(sel.overrides, { baseUrl: 'https://x' })
})

// Tier 1: an explicitly named profile. The two selectors are the SAME tier,
// not a precedence chain — see R-CONFLICT.

test('a positional name beats a binding and the default', () => {
  const sel = resolveProfile(state, { cwd: '/work/or-project', positional: 'z' })
  assert.equal(sel.name, 'z')
  assert.equal(sel.source, 'positional')
  assert.equal(sel.consumedPositional, true, 'the token must not also reach claude')
})

test('--cc-profile beats a binding and the default', () => {
  const sel = resolveProfile(state, { cwd: '/work/or-project', profileFlag: 'z' })
  assert.equal(sel.name, 'z')
  assert.equal(sel.source, 'flag')
  assert.equal(sel.consumedPositional, false)
})

test('R-ASYMMETRY: an unknown positional falls through, an unknown flag does not', () => {
  // The positional was probably the first word of a prompt. The flag is an
  // unambiguous assertion of intent, and silently ignoring it is how a launch
  // gets billed to the wrong account.
  const loose = resolveProfile(state, { cwd: '/x', positional: 'fix' })
  assert.equal(loose.name, 'z')
  assert.equal(loose.source, 'default')
  assert.equal(loose.consumedPositional, false, 'the word must still reach claude')
  assert.equal(loose.error, null)

  const strict = resolveProfile(state, { cwd: '/x', profileFlag: 'fix' })
  assert.equal(strict.profile, null)
  assert.match(strict.error!, /--cc-profile "fix" is not a profile/)
  assert.match(strict.error!, /z, or/, 'must list what does exist')
})

test('R-CONFLICT: a positional and a flag naming different profiles is an error', () => {
  const sel = resolveProfile(state, { cwd: '/x', positional: 'z', profileFlag: 'or' })
  assert.equal(sel.profile, null)
  assert.match(sel.error!, /conflicting profiles/)
  assert.match(sel.error!, /"z"/)
  assert.match(sel.error!, /"or"/)
})

test('the same profile named twice is not a conflict', () => {
  const sel = resolveProfile(state, { cwd: '/x', positional: 'z', profileFlag: 'z' })
  assert.equal(sel.name, 'z')
  assert.equal(sel.consumedPositional, true)
  assert.equal(sel.error, null)
})

test('an unknown --cc-profile errors even when no profiles exist at all', () => {
  const sel = resolveProfile(makeState({ profiles: {} }), { profileFlag: 'anything' })
  assert.match(sel.error!, /No profiles exist yet/)
})

test('tier 1 short-circuits the binding walk entirely', () => {
  // The walk is cheap, but it must not run at all once the user has said which
  // profile they want.
  const trap = {
    ...state,
    bindings: new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('the binding map must not be consulted when tier 1 matched')
        },
        get() {
          throw new Error('the binding map must not be consulted when tier 1 matched')
        },
      },
    ),
  }
  assert.equal(resolveProfile(trap, { cwd: '/work/or-project', positional: 'z' }).name, 'z')
  assert.equal(resolveProfile(trap, { cwd: '/work/or-project', profileFlag: 'or' }).name, 'or')
})

test('a profile named after a subcommand is still selectable by flag', () => {
  // `config list` always wins positionally, but the profile is not unreachable.
  const shadowed = makeState({ providerAccounts: { list: { provider: 'zai' } }, agentProfiles: { list: {} }, profiles: { list: { agentProfile: 'list', accounts: ['list'] } }, defaultProfile: null })
  assert.equal(resolveProfile(shadowed, { profileFlag: 'list' }).name, 'list')
})
