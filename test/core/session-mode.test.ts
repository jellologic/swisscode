// Session-mode accounts: authenticating with a login the agent already has.
//
// A subscription is not a key. There is no secret to carry — only a directory
// where the official OAuth flow already ran — so this mode is defined by what
// swisscode DOES NOT send: no credential of its own, and neither of the two
// variables that would override the login it just selected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildIntent } from '../../src/core/intent.ts'
import { resolveProfileRefs } from '../../src/core/resolve.ts'
import { buildEnvPlan } from '../../src/adapters/agents/claude-code/env.ts'
import { claudeCode } from '../../src/adapters/agents/claude-code/index.ts'
import { kilo } from '../../src/adapters/agents/kilo/index.ts'
import { opencode } from '../../src/adapters/agents/opencode/index.ts'
import { anthropic } from '../../src/adapters/providers/anthropic.ts'
import { makeProfile } from '../support/fixtures.ts'
import type { State } from '../../src/ports/config-store.ts'

const DIR = '/home/u/.config/swisscode/accounts/personal'

const state = (over: Record<string, unknown> = {}): State =>
  ({
    version: 3,
    providerAccounts: {
      personal: { provider: 'anthropic', configDir: DIR },
      keyed: { provider: 'anthropic', apiKey: 'sk-ant-real' },
    },
    agentProfiles: { main: {} },
    profiles: { p: { agentProfile: 'main', accounts: ['personal'] } },
    defaultProfile: 'p',
    bindings: {},
    settings: {},
    ...over,
  }) as unknown as State

test('a session account resolves to a directory, not a credential', () => {
  const r = resolveProfileRefs(state(), 'p')
  assert.ok(r.ok)
  assert.equal(r.resolved.configDir, DIR)
  assert.equal(r.resolved.apiKey, undefined)
  assert.equal(r.resolved.apiKeyFromEnv, undefined)
})

test('the neutral intent carries it WITHOUT naming any agent variable', () => {
  // core/ may not name CLAUDE_CONFIG_DIR — test/architecture.test.ts forbids it
  // in emitted code, and the v3 refactor already learned that once. The intent
  // says "session directory"; the adapter decides what that means.
  const intent = buildIntent(makeProfile({ provider: 'anthropic', configDir: DIR }), anthropic, {})
  assert.equal(intent.sessionDir, DIR)
  assert.equal(intent.credential, '', 'a session account presents no credential of its own')
})

test('a key account carries no session directory', () => {
  const intent = buildIntent(makeProfile({ provider: 'anthropic', apiKey: 'k' }), anthropic, {})
  assert.equal(intent.sessionDir, undefined)
  assert.equal(intent.credential, 'k')
})

test('Claude Code lowers it, and clears both overriding variables', () => {
  // ANTHROPIC_API_KEY overrides an OAuth login outright; a stale
  // ANTHROPIC_AUTH_TOKEN would be presented in place of the subscription this
  // account names. Either one turns "launch as personal" into "launch as
  // whatever was in the shell" — silently, and billed elsewhere.
  const plan = buildEnvPlan(makeProfile({ provider: 'anthropic', configDir: DIR }), anthropic, {
    ANTHROPIC_API_KEY: 'sk-ant-STALE',
    ANTHROPIC_AUTH_TOKEN: 'stale-oauth',
  })
  assert.equal(plan.set.CLAUDE_CONFIG_DIR, DIR)
  assert.ok(plan.unset.includes('ANTHROPIC_API_KEY'))
  assert.ok(plan.unset.includes('ANTHROPIC_AUTH_TOKEN'))
})

test('a key account still sets its credential, and no config dir', () => {
  // The regression guard for the change above: session mode must not have
  // quietly disabled the ordinary path.
  const plan = buildEnvPlan(makeProfile({ provider: 'anthropic', apiKey: 'sk-ant-real' }), anthropic, {})
  assert.equal(plan.set.ANTHROPIC_API_KEY, 'sk-ant-real')
  assert.equal(plan.set.CLAUDE_CONFIG_DIR, undefined)
})

test('only Claude Code claims the capability', () => {
  assert.equal(claudeCode.capabilities.sessionDir, true)
  assert.equal(kilo.capabilities.sessionDir, false)
  assert.equal(opencode.capabilities.sessionDir, false)
})

test('an agent that cannot use a session says so LOUDLY rather than launching', () => {
  // `high`, unlike tier-collapse: a collapsed tier still launches something
  // useful, whereas this launch cannot work at all — it would reach the
  // endpoint with no credential and fail with a message about the endpoint
  // rather than about the account.
  for (const agent of [kilo, opencode]) {
    const t = agent.translate({
      intent: buildIntent(makeProfile({ provider: 'anthropic', configDir: DIR }), anthropic, {}),
      profile: makeProfile({ provider: 'anthropic', configDir: DIR }),
      provider: anthropic,
      passthrough: [],
      ambient: {},
    })
    const w = t.warnings.find((x) => x.code === 'session-unsupported')
    assert.ok(w, `${agent.label} launched a session account with no warning`)
    assert.equal(w.severity, 'high')
    assert.match(w.message, /cannot use one/)
  }
})

test('Claude Code does NOT warn — it is the one that can', () => {
  const t = claudeCode.translate({
    intent: buildIntent(makeProfile({ provider: 'anthropic', configDir: DIR }), anthropic, {}),
    profile: makeProfile({ provider: 'anthropic', configDir: DIR }),
    provider: anthropic,
    passthrough: [],
    ambient: {},
  })
  assert.equal(t.warnings.find((x) => x.code === 'session-unsupported'), undefined)
})
