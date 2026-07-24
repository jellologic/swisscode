// The end-to-end counterpart of test/golden.test.ts.
//
// golden asserts that `buildEnvPlan` PRODUCES the right environment — an
// in-memory object. This asserts that the environment REACHES THE CHILD: it
// runs the real `bin/swisscode.js`, which resolves the recorder and execve's
// into it, and reads back the actual OS-level process environment. The two
// cover different halves of the same claim. golden proves the plan is correct;
// this proves the handoff is faithful, which nothing else tests — `ci.yml` says
// so in as many words.
//
// The headline assertion is the one a plan-level test cannot make: for every
// third-party provider, the deliberately-stale `ANTHROPIC_API_KEY` in AMBIENT is
// ABSENT from the launched child. Present-in-`plan.unset` is not the same as
// gone-from-the-process; only a real launch shows the difference.
import test from 'node:test'
import assert from 'node:assert/strict'
import { launch, makeConfig, resolvedAgent } from './harness.ts'
import { PROVIDERS, byId } from '../../src/adapters/providers/registry.ts'

/** A key-mode account for a provider, plus a claude-code profile pinning a model. */
function configFor(providerId: string) {
  const provider = byId(providerId)!
  const account: { provider: string; apiKey: string; baseUrl?: string } = {
    provider: providerId,
    apiKey: 'sk-e2e-KEY',
  }
  // `custom` has no baseUrl of its own; an account must supply one.
  if (provider.askBaseUrl) account.baseUrl = 'https://custom.example'
  return makeConfig({
    providerAccounts: { acct: account },
    agentProfiles: { main: { agent: 'claude-code', models: { opus: 'test-opus' } } },
    profiles: { p: { agentProfile: 'main', accounts: ['acct'] } },
  })
}

// Every shipped provider, launched for real through Claude Code.
for (const provider of PROVIDERS) {
  test(`${provider.id}: the plan reaches the child, and stale env does not`, () => {
    const r = launch({ config: configFor(provider.id), argv: [`prompt for ${provider.id}`] })
    assert.equal(r.exitCode, 0, r.stderr)
    const c = r.capture
    assert.ok(c, `${provider.id} handed off but recorded nothing`)

    // swisscode resolved the CLAUDE override specifically — not kilo, not opencode.
    assert.equal(resolvedAgent(c), 'recorder-claude')
    // The recursion guard was set in the child, proving buildEnv ran.
    assert.equal(c.env.SWISSCODE, '1')
    // The prompt was forwarded verbatim, swisscode's own flags stripped.
    assert.deepEqual(c.argv, [`prompt for ${provider.id}`])

    const credentialEnv = provider.credentialEnv
    // The key landed in the variable this provider authenticates with.
    assert.equal(c.env[credentialEnv], 'sk-e2e-KEY', `${provider.id} credential env`)

    if (credentialEnv !== 'ANTHROPIC_API_KEY') {
      // THE LOAD-BEARING ASSERTION. Every third-party provider authenticates via
      // ANTHROPIC_AUTH_TOKEN, so the stale ANTHROPIC_API_KEY must be gone from
      // the process — not merely listed in plan.unset. This is the billing
      // guard, observed at the OS level for the first time.
      assert.ok(
        !('ANTHROPIC_API_KEY' in c.env),
        `${provider.id}: stale ANTHROPIC_API_KEY survived into the child`,
      )
    } else {
      // anthropic-direct uses ANTHROPIC_API_KEY, so the stale value is
      // OVERWRITTEN with the account key rather than removed.
      assert.equal(c.env.ANTHROPIC_API_KEY, 'sk-e2e-KEY')
    }

    if (provider.baseUrl === null && !provider.askBaseUrl) {
      // anthropic-direct: the stale gateway URL is cleared, not overridden.
      assert.ok(
        !('ANTHROPIC_BASE_URL' in c.env),
        `${provider.id}: a stale ANTHROPIC_BASE_URL survived`,
      )
    } else {
      const expected = provider.baseUrl ?? 'https://custom.example'
      assert.equal(c.env.ANTHROPIC_BASE_URL, expected, `${provider.id} base URL`)
    }

    // The pinned model reached its tier variable (z.ai appends [1m], hence
    // `includes` rather than an exact match — the suffix is golden's concern).
    assert.match(c.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? '', /test-opus/)
  })
}

test('the ambient PATH survives — the child still finds node for the shebang', () => {
  // A launch that scrubbed PATH would break the recorder's own `#!/usr/bin/env
  // node`, so this passing at all is part of the proof; assert it explicitly so
  // a future env-plan change that drops PATH fails here loudly rather than as a
  // mysterious "recorder did not run".
  const r = launch({ config: makeConfig() })
  assert.ok(r.capture)
  assert.ok(r.capture.env.PATH && r.capture.env.PATH.length > 0)
})

test('a profile pinning all four tiers writes all four into the child', () => {
  const r = launch({
    config: makeConfig({
      agentProfiles: {
        main: {
          agent: 'claude-code',
          models: { opus: 'm-opus', sonnet: 'm-sonnet', haiku: 'm-haiku', fable: 'm-fable' },
        },
      },
    }),
  })
  assert.ok(r.capture)
  const e = r.capture.env
  assert.equal(e.ANTHROPIC_DEFAULT_OPUS_MODEL, 'm-opus')
  assert.equal(e.ANTHROPIC_DEFAULT_SONNET_MODEL, 'm-sonnet')
  assert.equal(e.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'm-haiku')
  assert.equal(e.ANTHROPIC_DEFAULT_FABLE_MODEL, 'm-fable')
})
