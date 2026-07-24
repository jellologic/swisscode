// The failure paths, exercised through the real binary.
//
// A launcher's exit codes and refusals are a contract — a script wrapping
// swisscode branches on them — and nothing tested them end to end. Each case
// here asserts that swisscode exits WITHOUT handing off (no capture), with the
// documented code, and with a message that names the fix. The absence of a
// capture is itself the assertion: a refusal that still launched something
// would be the worst kind of failure.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { launch, makeConfig } from './harness.ts'

test('an unknown provider exits 2 and launches nothing', () => {
  const r = launch({
    config: makeConfig({
      providerAccounts: { a: { provider: 'nonesuch', apiKey: 'k' } },
      profiles: { p: { agentProfile: 'main', accounts: ['a'] } },
    }),
  })
  assert.equal(r.capture, null, 'a broken config must not hand off to an agent')
  assert.equal(r.exitCode, 2)
  assert.match(r.stderr, /does not know|provider/)
})

test('a SWISSCODE_*_BIN pointing at swisscode itself is refused, not recursed into', () => {
  // The alias/shim loop guard, observed end to end: pointing the override back
  // at swisscode used to execve in an infinite chain that presents as a hang.
  const r = launch({
    config: makeConfig(),
    overrideBins: { claude: join(process.cwd(), 'bin', 'swisscode.js') },
  })
  assert.equal(r.capture, null)
  assert.notEqual(r.exitCode, 0)
  assert.match(r.stderr, /points at swisscode itself/)
})

test('a SWISSCODE_*_BIN pointing at a non-existent file is refused', () => {
  const r = launch({
    config: makeConfig(),
    overrideBins: { claude: '/nonexistent/definitely-not-here' },
  })
  assert.equal(r.capture, null)
  assert.notEqual(r.exitCode, 0)
  assert.match(r.stderr, /not an executable|could not find|SWISSCODE_CLAUDE_BIN/)
})

test('a profile naming a missing account launches nothing', () => {
  const r = launch({
    config: makeConfig({
      providerAccounts: { real: { provider: 'openrouter', apiKey: 'k' } },
      profiles: { p: { agentProfile: 'main', accounts: ['ghost'] } },
    }),
  })
  assert.equal(r.capture, null)
  assert.notEqual(r.exitCode, 0)
})
