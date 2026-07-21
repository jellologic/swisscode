// The whole launch pipeline with fake adapters: parseArgv -> resolveProfile ->
// overrides -> buildEnvPlan -> the argv and env handed to claude.
//
// This is where the per-run-override guarantees are pinned: nothing here may
// write, and no --cc-* token may survive into the child's argv.
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseArgv } from '../src/core/args.js'
import { LaunchError, planLaunch, bannerFor } from '../src/composition/launch-root.js'
import { registry } from '../src/adapters/providers/registry.js'

const STATE = () => ({
  version: 2,
  profiles: {
    z: {
      provider: 'zai',
      apiKey: 'zai-secret',
      models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2', fable: 'glm-5.2' },
      skipPermissions: true,
    },
    or: { provider: 'openrouter', apiKey: 'or-secret' },
    keyless: { provider: 'openrouter' },
  },
  defaultProfile: 'z',
  bindings: { '/work/or-project': 'or' },
  settings: {},
})

function harness({ state = STATE(), cwd = '/somewhere', env = {} } = {}) {
  const saves = []
  const store = {
    load: () => ({ state, corrupt: false, readOnly: false, migrated: false, warnings: [] }),
    save: (s) => {
      saves.push(s)
      return '/tmp/config.json'
    },
    path: () => '/tmp/config.json',
  }
  const proc = {
    env: () => ({ ...env }),
    cwd: () => cwd,
    resolveBinary: () => '/usr/local/bin/claude',
    replace: () => {
      throw new Error('planLaunch must not launch')
    },
  }
  return { saves, store, proc, registry }
}

/** argv in, plan out — the real path, not a reconstruction of it. */
function plan(argv, opts = {}) {
  const h = harness(opts)
  const parsed = parseArgv(argv)
  assert.equal(parsed.error, null, `parse error: ${parsed.error}`)
  const result = planLaunch({
    store: h.store,
    registry: h.registry,
    proc: h.proc,
    passthrough: parsed.passthrough,
    skipOverride: parsed.skipOverride,
    positional: parsed.positional,
    profileFlag: parsed.profileFlag,
    overrides: parsed.overrides,
  })
  return { ...result, saves: h.saves }
}

// ---------------------------------------------------------------------------
// The invariant.
// ---------------------------------------------------------------------------

test('NO override invocation ever writes to the config store', () => {
  const matrix = [
    [],
    ['or'],
    ['--cc-profile', 'or'],
    ['--cc-model', 'kimi-k3'],
    ['--cc-model', 'opus=a', '--cc-model', 'haiku=b'],
    ['--cc-base-url', 'https://local'],
    ['--cc-env', 'FOO=bar'],
    ['--cc-env', 'API_TIMEOUT_MS='],
    ['--cc-provider', 'openrouter'],
    ['or', '--cc-model', 'x', '--cc-env', 'A=1', '--yolo'],
  ]
  for (const argv of matrix) {
    const r = plan(argv)
    assert.equal(r.saves.length, 0, `${argv.join(' ')} wrote to the store`)
  }
})

test('overrides do not mutate the stored profile object either', () => {
  // structuredClone in applyOverrides is what makes this true; a shallow copy
  // would leave the next read of `state` carrying this run's overrides.
  const state = STATE()
  const before = JSON.stringify(state)
  plan(['--cc-model', 'kimi-k3', '--cc-env', 'A=1'], { state })
  assert.equal(JSON.stringify(state), before)
})

// ---------------------------------------------------------------------------
// Stripping.
// ---------------------------------------------------------------------------

test('no --cc-* token ever reaches the child argv', () => {
  const r = plan(['--cc-profile', 'or', '--cc-model', 'x', '--cc-env', 'A=1', '--resume'])
  assert.deepEqual(r.args, ['--resume'])
})

test('a matched positional profile name is consumed', () => {
  const r = plan(['or', '--resume'])
  assert.equal(r.selection.name, 'or')
  assert.deepEqual(r.args, ['--resume'], 'the profile name must not become a prompt')
})

test('an unmatched positional stays in the argv as prompt text', () => {
  const r = plan(['refactor', 'the', 'parser'])
  assert.equal(r.selection.name, 'z')
  assert.deepEqual(r.args, ['--dangerously-skip-permissions', 'refactor', 'the', 'parser'])
})

test('--cc-* after -- reaches claude untouched', () => {
  const r = plan(['--', '--cc-profile', 'or'])
  assert.equal(r.selection.name, 'z', 'the flag after -- selects nothing')
  assert.deepEqual(r.args, ['--dangerously-skip-permissions', '--', '--cc-profile', 'or'])
})

// ---------------------------------------------------------------------------
// Overrides reaching the environment.
// ---------------------------------------------------------------------------

test('a bare --cc-model sets all four tier variables', () => {
  const r = plan(['--cc-model', 'kimi-k3'])
  for (const v of ['OPUS', 'SONNET', 'HAIKU', 'FABLE']) {
    assert.equal(r.plan.set[`ANTHROPIC_DEFAULT_${v}_MODEL`], 'kimi-k3', v)
  }
})

test('--cc-env honours the empty-string-means-unset contract', () => {
  const r = plan(['--cc-env', 'FOO=bar', '--cc-env', 'ANTHROPIC_BASE_URL='])
  assert.equal(r.plan.set.FOO, 'bar')
  assert.ok(r.plan.unset.includes('ANTHROPIC_BASE_URL'))
  assert.equal(r.plan.set.ANTHROPIC_BASE_URL, undefined)
})

test('--cc-base-url replaces the provider endpoint for this run only', () => {
  const r = plan(['--cc-base-url', 'http://127.0.0.1:8080'])
  assert.equal(r.plan.set.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8080')
  assert.equal(r.saves.length, 0)
})

test('a directory binding still applies when no profile is named', () => {
  const r = plan(['--resume'], { cwd: '/work/or-project/src' })
  assert.equal(r.selection.name, 'or')
  assert.equal(r.selection.source, 'binding')
  assert.equal(r.plan.set.ANTHROPIC_AUTH_TOKEN, 'or-secret')
})

test('an explicitly named profile beats the binding for that directory', () => {
  const r = plan(['z'], { cwd: '/work/or-project/src' })
  assert.equal(r.selection.name, 'z')
  assert.equal(r.selection.source, 'positional')
})

// ---------------------------------------------------------------------------
// --cc-provider: never send a credential to a host it was not entered for.
// ---------------------------------------------------------------------------

test('--cc-provider borrows the credential from a profile for that provider', () => {
  const r = plan(['--cc-provider', 'openrouter'])
  assert.equal(r.plan.set.ANTHROPIC_AUTH_TOKEN, 'or-secret')
  assert.equal(r.plan.set.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api')
  assert.equal(r.borrowedFrom, 'or')
})

test('--cc-provider drops model ids chosen for the old provider', () => {
  // glm-5.2 posted to OpenRouter is a guaranteed 404 wearing the costume of a
  // working config, for exactly the reason the key is not forwarded either.
  const r = plan(['--cc-provider', 'openrouter'])
  assert.equal(r.plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'openrouter/fusion')
  assert.ok(!JSON.stringify(r.plan.set).includes('glm-5.2'))
})

test('--cc-model still wins over the retargeted defaults', () => {
  const r = plan(['--cc-provider', 'openrouter', '--cc-model', 'anthropic/claude-opus-4.8'])
  assert.equal(r.plan.set.ANTHROPIC_DEFAULT_OPUS_MODEL, 'anthropic/claude-opus-4.8')
})

test('--cc-provider refuses rather than POSTing one host a key meant for another', () => {
  const state = STATE()
  delete state.profiles.or
  delete state.profiles.keyless
  assert.throws(
    () => plan(['--cc-provider', 'openrouter'], { state }),
    (err) => err instanceof LaunchError && /no credential/.test(err.message),
  )
})

test('--cc-provider accepts a credential already in the ambient environment', () => {
  const state = STATE()
  delete state.profiles.or
  delete state.profiles.keyless
  const r = plan(['--cc-provider', 'openrouter'], {
    state,
    env: { ANTHROPIC_AUTH_TOKEN: 'from-shell' },
  })
  assert.equal(r.plan.set.ANTHROPIC_AUTH_TOKEN, 'from-shell')
})

test('an unknown --cc-provider lists the valid ids', () => {
  assert.throws(
    () => plan(['--cc-provider', 'bogus']),
    (err) => /not a known provider/.test(err.message) && /openrouter/.test(err.message),
  )
})

// ---------------------------------------------------------------------------
// Errors and the banner.
// ---------------------------------------------------------------------------

test('a conflicting positional and flag exits 2 rather than guessing', () => {
  assert.throws(
    () => plan(['or', '--cc-profile', 'z']),
    (err) => err instanceof LaunchError && err.exitCode === 2 && /conflicting/.test(err.message),
  )
})

test('an unknown --cc-profile exits 2', () => {
  assert.throws(
    () => plan(['--cc-profile', 'nope']),
    (err) => err instanceof LaunchError && err.exitCode === 2,
  )
})

test('the banner is silent for the plain default-profile launch', () => {
  // The common case stays quiet, which is what keeps the line meaningful.
  assert.equal(bannerFor(plan(['--resume'])), null)
})

test('the banner fires whenever the profile was not the plain default', () => {
  assert.match(bannerFor(plan(['or'])), /profile "or"/)
  assert.match(bannerFor(plan(['--cc-profile', 'or'])), /--cc-profile/)
  assert.match(bannerFor(plan(['--resume'], { cwd: '/work/or-project' })), /binding: \/work\/or-project/)
  assert.match(bannerFor(plan(['--cc-model', 'x'])), /overridden for this run/)
  assert.match(bannerFor(plan(['--cc-provider', 'openrouter'])), /credential from profile "or"/)
})

test('the banner never contains the credential', () => {
  for (const argv of [['or'], ['--cc-provider', 'openrouter'], ['--cc-model', 'x']]) {
    const line = bannerFor(plan(argv)) ?? ''
    assert.ok(!line.includes('zai-secret'), argv.join(' '))
    assert.ok(!line.includes('or-secret'), argv.join(' '))
  }
})

test('--safe and --yolo still override the profile preference', () => {
  assert.deepEqual(plan(['--safe', '-p', 'x']).args, ['-p', 'x'])
  assert.deepEqual(plan(['or', '--yolo']).args, ['--dangerously-skip-permissions'])
})
