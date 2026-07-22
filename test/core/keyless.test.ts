// A provider whose endpoint requires the credential FIELD but does not check
// its value — a local Ollama being the shipped case.
//
// Verified against Ollama 0.32.0 before this was written: POST /v1/messages
// with no auth header, with `x-api-key: totally-wrong`, and with an
// Authorization bearer token all return byte-identical responses. The token is
// not authentication there; it is a field that has to be populated.
//
// The alternative was telling every user to type a fake key into the wizard and
// storing that fiction in config.json next to real secrets, where nothing
// downstream could tell the two apart.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildIntent } from '../../src/core/intent.ts'
import { buildEnvPlan } from '../../src/adapters/agents/claude-code/env.ts'
import { ollama } from '../../src/adapters/providers/ollama.ts'
import { ollamaCloud } from '../../src/adapters/providers/ollama-cloud.ts'
import { makeProfile } from '../support/fixtures.ts'
import type { ProviderDescriptor } from '../../src/ports/provider.ts'

test('a keyless profile sends the provider placeholder', () => {
  const plan = buildEnvPlan(makeProfile({ provider: 'ollama' }), ollama, {})
  assert.equal(plan.set.ANTHROPIC_AUTH_TOKEN, 'ollama')
  assert.ok(!plan.unset.includes('ANTHROPIC_AUTH_TOKEN'), 'the variable must be populated')
})

test('a real key still wins over the placeholder', () => {
  const plan = buildEnvPlan(makeProfile({ provider: 'ollama', apiKey: 'mine' }), ollama, {})
  assert.equal(plan.set.ANTHROPIC_AUTH_TOKEN, 'mine')
})

test('apiKeyFromEnv wins too, and an unset variable falls back rather than blanking', () => {
  const withVar = buildEnvPlan(
    makeProfile({ provider: 'ollama', apiKeyFromEnv: 'MY_TOKEN' }),
    ollama,
    { MY_TOKEN: 'from-env' },
  )
  assert.equal(withVar.set.ANTHROPIC_AUTH_TOKEN, 'from-env')

  // resolveCredential returns '' when the named variable is absent. Falling
  // back to the placeholder is right for a keyless endpoint: the alternative
  // is a launch that fails on a field the server never reads.
  const without = buildEnvPlan(
    makeProfile({ provider: 'ollama', apiKeyFromEnv: 'MY_TOKEN' }),
    ollama,
    {},
  )
  assert.equal(without.set.ANTHROPIC_AUTH_TOKEN, 'ollama')
})

test('the placeholder reaches every agent, not just Claude Code', () => {
  // Kilo and OpenCode read the neutral intent, so the fallback has to live
  // there as well as in the Claude Code lowering.
  const intent = buildIntent(makeProfile({ provider: 'ollama' }), ollama, {})
  assert.equal(intent.credential, 'ollama')
})

test('a provider that needs a real key does NOT get a placeholder', () => {
  // The whole point of the field being opt-in. ollama.com authenticates for
  // real, so "no key" must stay an error the user sees now rather than a
  // placeholder that 401s somewhere further downstream.
  //
  // Read through the PORT type on purpose. `satisfies` keeps the descriptor's
  // literal type, under which the property provably does not exist and
  // `ollamaCloud.defaultCredential` is a compile error rather than a check —
  // which would leave nothing to fail if someone later added one. Widening to
  // the shape every consumer sees turns it back into a real assertion.
  const cloud: ProviderDescriptor = ollamaCloud
  assert.equal(cloud.defaultCredential, undefined)

  const plan = buildEnvPlan(makeProfile({ provider: 'ollama-cloud' }), ollamaCloud, {})
  assert.ok(
    plan.unset.includes('ANTHROPIC_AUTH_TOKEN'),
    'a keyless cloud profile must clear the variable, not invent a token',
  )
  const intent = buildIntent(makeProfile({ provider: 'ollama-cloud' }), ollamaCloud, {})
  assert.equal(intent.credential, '')
})

test('the placeholder is not treated as a secret worth demanding', () => {
  // credentialOptional is what stops the wizard blocking on a key the endpoint
  // ignores; defaultCredential is what fills the field anyway. A provider that
  // set one without the other would either nag for nothing or send an empty
  // token — so the shipped pairing is asserted rather than assumed.
  assert.equal(ollama.credentialOptional, true)
  assert.equal(ollama.defaultCredential, 'ollama')
})

test('a local endpoint is exempt from the cleartext-credential warning', async () => {
  // http:// is correct here and must not nag. The exemption is loopback-only,
  // so a remote Ollama over http still warns.
  const { isInsecureRemoteBaseUrl } = await import('../../src/core/url-safety.ts')
  assert.equal(isInsecureRemoteBaseUrl(ollama.baseUrl), false)
  assert.equal(isInsecureRemoteBaseUrl('http://192.168.1.50:11434'), true)
  assert.equal(isInsecureRemoteBaseUrl(ollamaCloud.baseUrl), false)
})

test('a local launch sets no auto-compact window, because none is measured', () => {
  // Ollama's window is whatever the server was started with (OLLAMA_CONTEXT_LENGTH,
  // or a Modelfile num_ctx that overrides it) — not a property of the model id.
  // Guessing one that is too large means the conversation overflows instead of
  // compacting, so the correct output is nothing at all.
  const plan = buildEnvPlan(
    makeProfile({ provider: 'ollama', models: { opus: 'qwen3-coder:30b' } }),
    ollama,
    {},
  )
  assert.equal(plan.set.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined)
})
