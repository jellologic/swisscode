// Subscription session mode, launched for real.
//
// The single most dangerous bug this whole feature can have is a
// silently-wrong-account launch, and it lives exactly at the boundary a plan
// test cannot see: whether the child process actually has `CLAUDE_CONFIG_DIR`
// set (or unset) and whether both credential variables are actually gone. This
// asserts it against the real child.
//
// The default-directory trap is the subtle one. Claude Code selects its
// keychain item on WHETHER `CLAUDE_CONFIG_DIR` is set, not its value, so an
// account pointed at the default `~/.claude` must UNSET the variable — pointing
// it at that path is a different, empty login. The corrected mechanism is
// proven here by the variable's ABSENCE from the child.
import test from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { launch, makeConfig } from './harness.ts'

function sessionConfig(configDir: string, extra: Record<string, string> = {}) {
  return makeConfig({
    providerAccounts: { s: { provider: 'anthropic', configDir, ...extra } },
    agentProfiles: { m: { agent: 'claude-code', models: { opus: 'x' } } },
    profiles: { p: { agentProfile: 'm', accounts: ['s'] } },
  })
}

test('a custom session directory sets CLAUDE_CONFIG_DIR and clears BOTH credentials', () => {
  const r = launch({ config: sessionConfig('/tmp/e2e-cc-dir') })
  assert.ok(r.capture, r.stderr)
  const e = r.capture.env
  assert.equal(e.CLAUDE_CONFIG_DIR, '/tmp/e2e-cc-dir')
  // Both, not one: a stale ANTHROPIC_AUTH_TOKEN left behind would override the
  // subscription login just as surely as a stale API key.
  assert.ok(!('ANTHROPIC_API_KEY' in e), 'stale ANTHROPIC_API_KEY survived a session launch')
  assert.ok(!('ANTHROPIC_AUTH_TOKEN' in e), 'stale ANTHROPIC_AUTH_TOKEN survived a session launch')
})

test('naming the DEFAULT ~/.claude UNSETS the variable rather than writing it', () => {
  // The trap. HOME is the harness's HOME, so the default dir is HOME/.claude.
  const r = launch({ config: sessionConfig(join(process.env.HOME ?? homedir(), '.claude')) })
  assert.ok(r.capture, r.stderr)
  assert.ok(
    !('CLAUDE_CONFIG_DIR' in r.capture.env),
    'the default directory must UNSET CLAUDE_CONFIG_DIR — writing the path is a different, empty login',
  )
})

test('a session launch resolves the claude binary, not another agent', () => {
  const r = launch({ config: sessionConfig('/tmp/e2e-cc-dir') })
  assert.ok(r.capture, r.stderr)
  assert.equal(r.capture.binary.split('/').pop(), 'recorder-claude')
})
