// User-defined provider validation.
//
// Every assertion here is the runtime twin of a test in registry.test.ts. That
// file proves things about SHIPPED descriptors, which are constants in source;
// none of it can reach a provider that arrives from config.json. Offering a
// form to type one in does not make those checks unnecessary — it moves them
// from build time to run time, and this file is where they moved to.
import test from 'node:test'
import assert from 'node:assert/strict'
import { toCustomProvider, validateCustomProvider } from '../../src/core/provider-def.ts'

const OPTS = {
  reservedIds: ['anthropic', 'openrouter', 'ollama'],
  knownCompatFlags: ['disableAdaptiveThinking', 'forceIdleTimeoutOff', 'disableNonessentialTraffic'],
  credentialEnvs: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'],
}

const valid = {
  id: 'my-gateway',
  label: 'My Gateway',
  baseUrl: 'https://gw.example.com/anthropic',
}

const check = (over: Record<string, unknown>) =>
  validateCustomProvider({ ...valid, ...over }, OPTS)

test('a minimal provider is accepted', () => {
  const v = validateCustomProvider(valid, OPTS)
  assert.equal(v.ok, true, v.errors.join('; '))
  assert.deepEqual(v.errors, [])
})

test('a base URL ending in /v1 is refused, with the reason spelled out', () => {
  // The single most common way to build a preset that 404s, and the one the
  // shipped descriptors have a dedicated test for.
  const v = check({ baseUrl: 'https://gw.example.com/v1' })
  assert.equal(v.ok, false)
  assert.match(v.errors.join(' '), /v1\/v1\/messages/)
  assert.equal(check({ baseUrl: 'https://gw.example.com/v1/' }).ok, false)
  // …but a path that merely CONTAINS v1 is fine.
  assert.equal(check({ baseUrl: 'https://gw.example.com/v1/anthropic' }).ok, true)
})

test('a hand-typed [1m] suffix is refused', () => {
  // It asserts a verified capability. An id the endpoint does not recognise
  // fails hard; one that silently ignores it is a 200K window wearing a 1M label.
  const v = check({ defaultModels: { opus: 'my-model[1m]' } })
  assert.equal(v.ok, false)
  assert.match(v.errors.join(' '), /verified capability/)
})

test('extendedContext cannot be declared at all, and is refused rather than dropped', () => {
  // Silently ignoring it would leave the user believing a capability is active.
  const v = check({ extendedContext: { supported: true, models: ['x'], window: 1_000_000 } })
  assert.equal(v.ok, false)
  assert.match(v.errors.join(' '), /contextWindows instead/)
})

test('a custom provider may not shadow a shipped one', () => {
  // "openrouter" meaning something different on one machine is exactly the
  // confusion this tool exists to remove — and a plausible way to redirect a
  // credential to a host it was not entered for.
  for (const id of OPTS.reservedIds) {
    assert.equal(check({ id }).ok, false, `${id} was allowed to shadow`)
  }
})

test('an unknown compat flag is an error, not a silent no-op', () => {
  const v = check({ compat: { turboMode: true } })
  assert.equal(v.ok, false)
  assert.match(v.errors.join(' '), /not a compat flag/)
  assert.equal(check({ compat: { forceIdleTimeoutOff: true } }).ok, true)
  assert.equal(check({ compat: { forceIdleTimeoutOff: 'yes' } }).ok, false)
})

test('an empty-string env value is refused, because that sentinel is profile-only', () => {
  // Descriptors carry an explicit env/unsetEnv split so "set to empty" and
  // "remove" stay distinguishable. registry.test.ts enforces the same rule for
  // shipped descriptors.
  const v = check({ env: { API_TIMEOUT_MS: '' } })
  assert.equal(v.ok, false)
  assert.match(v.errors.join(' '), /unsetEnv/)
  assert.equal(check({ env: { API_TIMEOUT_MS: '600000' }, unsetEnv: ['FOO'] }).ok, true)
})

test('only the two real credential spellings are accepted', () => {
  assert.equal(check({ credentialEnv: 'ANTHROPIC_AUTH_TOKEN' }).ok, true)
  assert.equal(check({ credentialEnv: 'ANTHROPIC_API_KEY' }).ok, true)
  // A spelling Claude Code does not read is a silent no-op at launch.
  assert.equal(check({ credentialEnv: 'MY_TOKEN' }).ok, false)
})

test('cleartext to a remote host warns but does not block', () => {
  // Legal and probably wrong is the user's call. Loopback is exempt, because a
  // local model server is an ordinary setup.
  const remote = check({ baseUrl: 'http://192.168.1.50:8080' })
  assert.equal(remote.ok, true, 'a warning must not block the save')
  assert.match(remote.warnings.join(' '), /cleartext/)
  assert.deepEqual(check({ baseUrl: 'http://localhost:11434' }).warnings, [])
})

test('ids follow the same grammar as profile names', () => {
  for (const id of ['Bad Id', 'UPPER', '-leading', 'has/slash', '']) {
    assert.equal(check({ id }).ok, false, `"${id}" was accepted`)
  }
  for (const id of ['ok', 'my-gw2', 'a.b_c']) {
    assert.equal(check({ id }).ok, true, `"${id}" was refused`)
  }
})

test('toCustomProvider stores only known fields', () => {
  // An unrecognised key written into config.json could be read as meaningful
  // by a future swisscode, so what was typed and what is stored must match.
  const out = toCustomProvider({
    ...valid,
    evil: 'payload',
    compat: { forceIdleTimeoutOff: true, bogus: 'nope' },
    defaultModels: { opus: 'm', notATier: 'x' },
    unsetEnv: ['A', 42],
  })
  assert.ok(!('evil' in out))
  assert.deepEqual(out.compat, { forceIdleTimeoutOff: true })
  assert.deepEqual(out.defaultModels, { opus: 'm' })
  assert.deepEqual(out.unsetEnv, ['A'])
})
