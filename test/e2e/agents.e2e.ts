// All three coding CLIs, selected and launched for real.
//
// This proves two things a plan test states but cannot demonstrate: that
// swisscode consults the RIGHT `SWISSCODE_*_BIN` for the selected agent (each
// resolves a differently-named recorder), and that the billing guard — the
// stale `ANTHROPIC_API_KEY` never surviving into the child — holds across all
// three agent families, not only Claude Code.
//
// The dialects genuinely differ: Claude Code reads `ANTHROPIC_*` environment
// variables, while Kilo and OpenCode carry a whole provider config as a single
// JSON blob (`KILO_CONFIG_CONTENT` / `OPENCODE_CONFIG_CONTENT`) with the
// credential inside it. Both are asserted against the real child here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { launch, makeConfig, resolvedAgent } from './harness.ts'

function configForAgent(agent: string) {
  return makeConfig({
    providerAccounts: { or: { provider: 'openrouter', apiKey: 'sk-agent-KEY' } },
    agentProfiles: { main: { agent, models: { opus: 'the-model' } } },
    profiles: { p: { agentProfile: 'main', accounts: ['or'] } },
  })
}

test('claude-code resolves its own binary and speaks the ANTHROPIC_* dialect', () => {
  const r = launch({ config: configForAgent('claude-code'), argv: ['hi'] })
  assert.ok(r.capture, r.stderr)
  const c = r.capture
  assert.equal(resolvedAgent(c), 'recorder-claude')
  assert.equal(c.env.ANTHROPIC_AUTH_TOKEN, 'sk-agent-KEY')
  assert.equal(c.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api')
  // It does not leak the other agents' config vocabulary.
  assert.ok(!('KILO_CONFIG_CONTENT' in c.env))
  assert.ok(!('OPENCODE_CONFIG_CONTENT' in c.env))
})

for (const { agent, recorder, configVar } of [
  { agent: 'kilo', recorder: 'recorder-kilo', configVar: 'KILO_CONFIG_CONTENT' },
  { agent: 'opencode', recorder: 'recorder-opencode', configVar: 'OPENCODE_CONFIG_CONTENT' },
]) {
  test(`${agent} resolves its own binary and carries a config blob, not ANTHROPIC_* env`, () => {
    const r = launch({ config: configForAgent(agent), argv: ['hi'] })
    assert.ok(r.capture, r.stderr)
    const c = r.capture

    // The right override variable was consulted, proven by the resolved name.
    assert.equal(resolvedAgent(c), recorder)

    // The provider config is a JSON blob with the credential inside it — this
    // agent never uses ANTHROPIC_AUTH_TOKEN.
    const config = JSON.parse(c.env[configVar] ?? '{}')
    assert.ok(config.provider, `${agent} config blob has no provider`)
    assert.match(JSON.stringify(config), /sk-agent-KEY/, `${agent} credential missing from config`)
    assert.ok(!('ANTHROPIC_AUTH_TOKEN' in c.env), `${agent} should not set ANTHROPIC_AUTH_TOKEN`)

    // THE BILLING GUARD, across agent families: the stale ANTHROPIC_API_KEY and
    // ANTHROPIC_BASE_URL from the environment must not survive, or @ai-sdk/anthropic
    // would fall back to billing the wrong account.
    assert.ok(!('ANTHROPIC_API_KEY' in c.env), `${agent}: stale ANTHROPIC_API_KEY survived`)
    assert.ok(!('ANTHROPIC_BASE_URL' in c.env), `${agent}: stale ANTHROPIC_BASE_URL survived`)
  })
}

test('every agent sets the recursion guard in the child', () => {
  for (const agent of ['claude-code', 'kilo', 'opencode']) {
    const r = launch({ config: configForAgent(agent) })
    assert.ok(r.capture, `${agent}: ${r.stderr}`)
    assert.equal(r.capture.env.SWISSCODE, '1', `${agent} did not set SWISSCODE=1`)
  }
})
