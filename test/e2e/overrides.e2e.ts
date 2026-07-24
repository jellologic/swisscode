// The `--cc-*` override surface and passthrough, launched for real.
//
// The end-to-end counterpart of test/launch-overrides.test.ts, which drives
// `planLaunch` in-process. This runs the whole binary: the override is parsed
// from real argv, applied during real resolution, lowered into the real env
// plan, and observed in the real child. It also proves the half a plan test
// cannot — that swisscode's own flags are STRIPPED and never forwarded to the
// agent as if they were prompt text.
import test from 'node:test'
import assert from 'node:assert/strict'
import { launch, makeConfig } from './harness.ts'

// A config with two accounts on two providers, so `--cc-provider` has somewhere
// to borrow a key from and `--cc-model` has a baseline to override.
function twoProviderConfig() {
  return makeConfig({
    providerAccounts: {
      or: { provider: 'openrouter', apiKey: 'sk-or' },
      z: { provider: 'zai', apiKey: 'sk-zai' },
    },
    agentProfiles: { main: { agent: 'claude-code', models: { opus: 'base-opus', sonnet: 'base-sonnet' } } },
    profiles: {
      p: { agentProfile: 'main', accounts: ['or'] },
      onz: { agentProfile: 'main', accounts: ['z'] },
    },
  })
}

test('--cc-model bare resets every tier to the one value', () => {
  const r = launch({ config: twoProviderConfig(), argv: ['--cc-model', 'override-all'] })
  assert.ok(r.capture, r.stderr)
  const e = r.capture.env
  for (const tier of ['OPUS', 'SONNET', 'HAIKU', 'FABLE']) {
    assert.equal(e[`ANTHROPIC_DEFAULT_${tier}_MODEL`], 'override-all', `${tier} not overridden`)
  }
})

test('--cc-model opus=X refines one tier and leaves the profile pin on the rest', () => {
  const r = launch({ config: twoProviderConfig(), argv: ['--cc-model', 'opus=just-opus'] })
  assert.ok(r.capture, r.stderr)
  const e = r.capture.env
  assert.equal(e.ANTHROPIC_DEFAULT_OPUS_MODEL, 'just-opus')
  // The profile pinned sonnet; a scoped opus override must not disturb it.
  assert.equal(e.ANTHROPIC_DEFAULT_SONNET_MODEL, 'base-sonnet')
})

test('--cc-base-url redirects the endpoint for this launch only', () => {
  const r = launch({ config: twoProviderConfig(), argv: ['--cc-base-url', 'https://elsewhere.example'] })
  assert.ok(r.capture, r.stderr)
  assert.equal(r.capture.env.ANTHROPIC_BASE_URL, 'https://elsewhere.example')
})

test('--cc-env sets a variable, and an empty value UNSETS one', () => {
  const r = launch({
    config: twoProviderConfig(),
    // A value swisscode would otherwise set, cleared; plus a fresh one.
    argv: ['--cc-env', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096', '--cc-env', 'ANTHROPIC_DEFAULT_OPUS_MODEL='],
  })
  assert.ok(r.capture, r.stderr)
  const e = r.capture.env
  assert.equal(e.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4096')
  // The empty override wins over the profile's own opus pin and removes it.
  assert.ok(!('ANTHROPIC_DEFAULT_OPUS_MODEL' in e), 'empty --cc-env should unset')
})

test('--cc-provider borrows another profile\'s endpoint and key', () => {
  // Switch the openrouter-default launch onto z.ai. The z.ai base URL and its
  // credential must both arrive, and openrouter\'s must not linger.
  const r = launch({ config: twoProviderConfig(), argv: ['--cc-provider', 'zai'] })
  assert.ok(r.capture, r.stderr)
  const e = r.capture.env
  assert.equal(e.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
  assert.equal(e.ANTHROPIC_AUTH_TOKEN, 'sk-zai')
})

test('a bare prompt and unknown flags are forwarded to the agent untouched', () => {
  const r = launch({
    config: makeConfig(),
    argv: ['fix the bug', '--resume', '--model', 'ignored-by-swisscode'],
  })
  assert.ok(r.capture, r.stderr)
  // Everything that is not a --cc-* / --safe / --yolo reaches the agent verbatim.
  assert.deepEqual(r.capture.argv, ['fix the bug', '--resume', '--model', 'ignored-by-swisscode'])
})

test('--cc-* flags are STRIPPED — they never reach the agent as arguments', () => {
  const r = launch({ config: twoProviderConfig(), argv: ['--cc-model', 'x', 'the prompt'] })
  assert.ok(r.capture, r.stderr)
  // The classic failure this prevents: a reserved flag forwarded to the agent,
  // where it reads as prompt text while the launch silently uses wrong settings.
  assert.deepEqual(r.capture.argv, ['the prompt'])
  assert.ok(!r.capture.argv.includes('--cc-model'))
})

test('--yolo forwards the skip-permissions flag to the agent', () => {
  const r = launch({ config: makeConfig(), argv: ['--yolo'] })
  assert.ok(r.capture, r.stderr)
  assert.ok(
    r.capture.argv.includes('--dangerously-skip-permissions'),
    `--yolo should forward the skip flag; got ${JSON.stringify(r.capture.argv)}`,
  )
})
