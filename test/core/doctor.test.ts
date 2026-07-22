import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  interpretMessagesProbe,
  interpretToolProbe,
  probeSpec,
  redact,
  redactDeep,
  remainingBudget,
  renderText,
  staticChecks,
  summarize,
} from '../../src/adapters/agents/claude-code/doctor.ts'
import { buildEnvPlan } from '../../src/adapters/agents/claude-code/env.ts'
import { zai } from '../../src/adapters/providers/zai.ts'
import { anthropic } from '../../src/adapters/providers/anthropic.ts'
import type { StaticChecksInput } from '../../src/adapters/agents/claude-code/doctor.ts'
import type { DoctorCheck } from '../../src/ports/doctor.ts'
import type { ProbeResult } from '../../src/ports/doctor.ts'
import type { LoadResult, State } from '../../src/ports/config-store.ts'
import type { ProfileSelection } from '../../src/core/profile.ts'
import type { ResolvedProfile } from '../../src/ports/config-store.ts'
import type { ProviderDescriptor } from '../../src/ports/provider.ts'
import { makeDescriptor, makeProfile, makeSelection, makeProfileRefs } from '../support/fixtures.ts'

/**
 * The knobs `run()` below turns. Every field mirrors one of StaticChecksInput's
 * (plus `ambient`, which run() feeds to buildEnvPlan rather than passing on),
 * and every one is optional because each test overrides exactly the one thing
 * it is about and inherits the rest.
 */
type RunOver = Partial<Omit<StaticChecksInput, 'loaded'>> & {
  loaded?: LoadResult
  ambient?: Record<string, string>
}

const SECRET = 'zai-super-secret-key'

const profile = makeProfile({
  provider: 'zai',
  apiKey: SECRET,
  models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2', fable: 'glm-5.2' },
})

const loaded = (over: Partial<Omit<LoadResult, 'state'>> & { state?: Partial<State> } = {}): LoadResult =>
  ({
  state: {
    version: 2,    agentProfiles: {},
    profiles: { z: profile },
    defaultProfile: 'z',
    bindings: {},
    settings: {},
    ...over.state,
  },
  corrupt: false,
  readOnly: false,
  warnings: [],
  ...over,
  }) as LoadResult

// `makeSelection.profile` is the STORED profile (references); the resolved view
// is what `run()` passes to staticChecks separately.
const selection = makeSelection({
  name: 'z',
  source: 'default',
  profile: makeProfileRefs({ agentProfile: 'z', accounts: ['z'] }),
  overrides: {},
  warnings: [],
  error: null,
})

function run(over: RunOver = {}) {
  const l = over.loaded ?? loaded()
  const p = 'profile' in over ? over.profile : profile
  const provider = 'provider' in over ? over.provider : zai
  const plan = p ? buildEnvPlan(p, provider, over.ambient ?? {}) : null
  return staticChecks({
    loaded: l,
    selection: over.selection ?? selection,
    profile: p as ResolvedProfile | null,
    provider: provider as ProviderDescriptor | null,
    plan,
    modes: over.modes ?? { dir: 0o700, file: 0o600 },
    binary: over.binary ?? { path: '/usr/local/bin/claude', error: null },
    deadBindingPaths: over.deadBindingPaths ?? [],
  })
}

const byId = (checks: DoctorCheck[], id: string) => checks.find((c) => c.id === id)

// The rule that matters most: the key never appears in output. Not masked, not
// truncated, not length-hinted.

test('the credential never appears in any check, in any form', () => {
  const checks = run({ ambient: { ANTHROPIC_API_KEY: 'sk-ant-stale' } })
  const rendered = renderText({ checks, summary: summarize(checks), notes: [] })
  assert.ok(!rendered.includes(SECRET), 'the key leaked into the rendered report')
  assert.ok(!rendered.includes(SECRET.slice(0, 8)), 'a prefix of the key leaked')
  assert.ok(!rendered.includes(SECRET.slice(-8)), 'a suffix of the key leaked')
})

test('the credential check reports origin, never value', () => {
  const c = byId(run(), 'credential')
  assert.equal(c!.status, 'ok')
  assert.match(c!.detail, /ANTHROPIC_AUTH_TOKEN set from config\.json/)
  assert.ok(!c!.detail.includes(SECRET))
})

test('redact removes every occurrence, including one a gateway echoed back', () => {
  const echoed = `invalid api key: Bearer ${SECRET} (request 7)`
  const out = redact(echoed, [SECRET])
  assert.ok(!out.includes(SECRET))
  assert.match(out, /<redacted>/)
  // The rest of the diagnostic survives — that is the part worth reading.
  assert.match(out, /invalid api key/)
  assert.match(out, /request 7/)
})

test('redact is not a mask: no prefix, no suffix, no length survives', () => {
  const out = redact(SECRET, [SECRET])
  assert.equal(out, '<redacted>')
  assert.ok(!out.includes(SECRET.slice(0, 4)))
  assert.notEqual(out.length, SECRET.length)
})

test('redactDeep reaches nested strings and arrays for --json', () => {
  const out = redactDeep(
    { a: [{ b: `x ${SECRET} y` }], c: 'clean', d: 5, e: null },
    [SECRET],
  )
  const o = out as { a: { b: string }[]; c: string; d: number; e: null }
  assert.equal(o.a[0]!.b, 'x <redacted> y')
  assert.equal(o.c, 'clean')
  assert.equal(o.d, 5)
  assert.equal(o.e, null)
})

test('a too-short secret is not redacted, so common words survive', () => {
  // Redacting a 3-character "key" would blank out unrelated text and make the
  // report useless.
  assert.equal(redact('the model is ok', ['ok']), 'the model is ok')
})

// Exit codes: CI consumes these.

test('exit code is 0 clean, 1 on warnings, 2 on errors', () => {
  assert.equal(summarize([{ status: 'ok' }]).exitCode, 0)
  assert.equal(summarize([{ status: 'ok' }, { status: 'skip' }]).exitCode, 0)
  assert.equal(summarize([{ status: 'ok' }, { status: 'warn' }]).exitCode, 1)
  assert.equal(summarize([{ status: 'warn' }, { status: 'error' }]).exitCode, 2)
  // An error outranks any number of warnings.
  assert.equal(summarize([{ status: 'error' }, ...Array(9).fill({ status: 'warn' })]).exitCode, 2)
})

test('a clean setup produces no warnings and no errors', () => {
  const { exitCode } = summarize(run())
  assert.equal(exitCode, 0)
})

// Individual checks.

test('a missing binary is an error with an actionable fix', () => {
  const c = byId(run({ binary: { path: null, error: 'not on PATH' } }), 'binary')
  assert.equal(c!.status, 'error')
  assert.match(c!.fix!, /SWISSCODE_CLAUDE_BIN/)
})

test('loose file permissions are an error, tighter ones are not', () => {
  // The file holds an API key, so only the too-open direction is a problem.
  assert.equal(run({ modes: { dir: 0o700, file: 0o644 } }).find((c) => c.id === 'perms-file')!.status, 'error')
  assert.equal(run({ modes: { dir: 0o755, file: 0o600 } }).find((c) => c.id === 'perms-dir')!.status, 'error')
  assert.equal(run({ modes: { dir: 0o700, file: 0o400 } }).find((c) => c.id === 'perms-file')!.status, 'warn')
  assert.equal(run({ modes: { dir: null, file: null } }).find((c) => c.id === 'perms-file')!.status, 'skip')
})

test('a config newer than this build is an error and never a silent read', () => {
  const c = byId(run({ loaded: loaded({ readOnly: true, state: { version: 99 } }) }), 'config-version')
  assert.equal(c!.status, 'error')
  assert.match(c!.fix!, /Upgrade/)
})

test('an unknown provider is fatal only when there is no baseUrl to fall back on', () => {
  const orphan = { ...profile, provider: 'gone' }
  assert.equal(byId(run({ profile: orphan, provider: null }), 'provider')!.status, 'error')
  assert.equal(
    byId(run({ profile: { ...orphan, baseUrl: 'https://x' }, provider: null }), 'provider')!.status,
    'warn',
  )
})

test('a profile that reads its key from an unset variable is an error', () => {
  const c = byId(
    run({
      profile: makeProfile({
        provider: 'zai',
        apiKeyFromEnv: 'ZAI_TOKEN',
        models: profile.models ?? {},
      }),
    }),
    'credential',
  )
  assert.equal(c!.status, 'error')
  assert.match(c!.detail, /\$ZAI_TOKEN/)
})

test('an optional credential is fine when absent', () => {
  const c = byId(run({ profile: makeProfile({ provider: 'anthropic' }), provider: anthropic }), 'credential')
  assert.equal(c!.status, 'ok')
})

test('no models pinned at all is fine; some but not all is a warning', () => {
  assert.equal(byId(run({ profile: makeProfile({ provider: 'anthropic' }), provider: anthropic }), 'models')!.status, 'ok')
  const partial = makeProfile({
    provider: 'zai',
    apiKey: SECRET,
    models: { ...profile.models, fable: '' },
  })
  const c = byId(run({ profile: partial }), 'models')
  assert.equal(c!.status, 'warn')
  assert.match(c!.detail, /fable/)
  assert.match(c!.detail, /ANTHROPIC_DEFAULT_FABLE_MODEL/)
})

test('a stale ambient key surfaces as a warning, not silence', () => {
  // The launch already removes it; doctor is where the user finds out why.
  const checks = run({ ambient: { ANTHROPIC_API_KEY: 'sk-ant-someone-elses' } })
  const c = checks.find((x) => x.id === 'env-stale-anthropic-key')
  assert.equal(c!.status, 'warn')
  assert.match(c!.detail, /billed/)
})

test('a stored [1m] a provider does not support is reported, never auto-repaired', () => {
  const pinned = { ...profile, models: { ...profile.models, haiku: 'glm-4.6[1m]' } }
  const c = byId(run({ profile: pinned }), 'stored-models-unsupported')
  assert.equal(c!.status, 'warn')
  assert.equal(c!.repair, undefined, 'doctor does not rewrite a model the user pinned')
  assert.match(c!.fix!, /glm-4\.6/)
})

test('dangling bindings and dead paths are separate, prunable warnings', () => {
  const st = loaded()
  st.state.bindings = { '/a': 'gone-profile' }
  const checks = run({ loaded: st, deadBindingPaths: ['/b'] })
  assert.equal(byId(checks, 'bindings-dangling')!.status, 'warn')
  assert.equal(byId(checks, 'bindings-dead-path')!.status, 'warn')
  assert.match(byId(checks, 'bindings-dangling')!.fix!, /--prune/)
})

test('a profile shadowed by a subcommand is flagged with the way out', () => {
  const st = loaded()
  st.state.profiles = {
    ...st.state.profiles,
    doctor: makeProfileRefs({ agentProfile: 'z', accounts: ['z'] }),
  }
  const c = byId(run({ loaded: st }), 'shadowed-names')
  assert.equal(c!.status, 'warn')
  assert.match(c!.fix!, /--cc-profile/)
})

// Probe planning.

test('probeSpec deduplicates models and strips the [1m] suffix', () => {
  const plan = buildEnvPlan(profile, zai, {})
  const spec = probeSpec(profile, zai, plan)
  assert.equal(spec.baseUrl, 'https://api.z.ai/api/anthropic')
  assert.equal(spec.credential, SECRET)
  // Four tiers, one distinct model: one request, not four.
  assert.equal(spec.models.length, 1)
  assert.equal(spec.models[0]!.id, 'glm-5.2', 'the bare id is probed')
  assert.equal(spec.models[0]!.suffixed, true, 'and the report says the suffix was not tested')
  assert.equal(spec.toolModel, 'glm-5.2')
})

test('probeSpec bounds itself at four requests however many tiers differ', () => {
  const many = {
    ...profile,
    models: { opus: 'a', sonnet: 'b', haiku: 'c', fable: 'd' },
  }
  const spec = probeSpec(many, zai, buildEnvPlan(many, zai, {}))
  assert.equal(spec.models.length, 4)
})

test('probeSpec has nothing to probe for a first-party profile', () => {
  const plan = buildEnvPlan(makeProfile({ provider: 'anthropic' }), anthropic, {})
  assert.equal(probeSpec(makeProfile({ provider: 'anthropic' }), anthropic, plan).baseUrl, null)
})

// Probe interpretation. Status codes carry the finding; bodies are advisory.

const res = (over: Partial<ProbeResult>): ProbeResult => ({
  status: null, message: null, usedTool: false, timedOut: false,
  networkError: null, timeoutMs: 8000, ...over,
})

test('200 is the only success', () => {
  assert.equal(interpretMessagesProbe({ model: 'm', result: res({ status: 200 }) }).status, 'ok')
})

test('401 and 403 are credential errors', () => {
  for (const status of [401, 403]) {
    const c = interpretMessagesProbe({ model: 'm', result: res({ status }) })
    assert.equal(c.status, 'error')
    assert.match(c.detail, /credential rejected/)
  }
})

test('a ModelScope 401 names the ms- prefix trap specifically', () => {
  // The widely-repeated advice to strip the prefix is false and breaks auth,
  // so this is the single most likely cause of a 401 there.
  const c = interpretMessagesProbe({
    model: 'm',
    result: res({ status: 401 }),
    provider: makeDescriptor({ id: 'modelscope' }),
  })
  assert.match(c.fix!, /ms- prefix/)
})

test('404 names both plausible causes, including the /v1 trap', () => {
  const c = interpretMessagesProbe({ model: 'm', result: res({ status: 404 }) })
  assert.equal(c.status, 'error')
  assert.match(c.fix!, /v1\/v1\/messages/)
})

test('400 points at the compat flags that clear the known 400s', () => {
  const c = interpretMessagesProbe({ model: 'm', result: res({ status: 400 }) })
  assert.equal(c.status, 'error')
  assert.match(c.fix!, /disableExperimentalBetas/)
  assert.match(c.fix!, /disableAdaptiveThinking/)
})

test('429 and 5xx are warnings: reachable and authenticated', () => {
  assert.equal(interpretMessagesProbe({ model: 'm', result: res({ status: 429 }) }).status, 'warn')
  assert.equal(interpretMessagesProbe({ model: 'm', result: res({ status: 503 }) }).status, 'warn')
})

test('a timeout and a network error are distinguishable', () => {
  const t = interpretMessagesProbe({ model: 'm', result: res({ timedOut: true, timeoutMs: 500 }) })
  assert.match(t.detail, /within 500ms/)
  const n = interpretMessagesProbe({ model: 'm', result: res({ networkError: 'ECONNREFUSED' }) })
  assert.match(n.detail, /ECONNREFUSED/)
})

test('tool calling: only an actual tool_use block passes', () => {
  assert.equal(interpretToolProbe({ model: 'm', result: res({ status: 200, usedTool: true }) }).status, 'ok')
  // Accepted the request but ignored a forced tool_choice: suspicious, not fatal.
  assert.equal(interpretToolProbe({ model: 'm', result: res({ status: 200 }) }).status, 'warn')
  // Rejected the schema outright: Claude Code cannot work here.
  assert.equal(interpretToolProbe({ model: 'm', result: res({ status: 400 }) }).status, 'error')
})

// The hard timeout.

test('the total budget is hard and shrinks as probes consume it', () => {
  assert.equal(remainingBudget(0, 0, 20_000, 8_000), 8_000)
  assert.equal(remainingBudget(0, 15_000, 20_000, 8_000), 5_000, 'clamped by what is left')
  assert.equal(remainingBudget(0, 20_000, 20_000, 8_000), 0, 'exhausted')
  assert.equal(remainingBudget(0, 99_000, 20_000, 8_000), 0, 'never negative')
  assert.equal(remainingBudget(0, 0, 20_000, DEFAULT_PROBE_TIMEOUT_MS), DEFAULT_PROBE_TIMEOUT_MS)
})

test('renderText marks status and prints a fix only where one is needed', () => {
  const checks: DoctorCheck[] = [
    { id: 'a', title: 'ok thing', status: 'ok', detail: 'fine', fix: 'never shown' },
    { id: 'b', title: 'bad thing', status: 'error', detail: 'broken', fix: 'do this' },
  ]
  const text = renderText({ checks, summary: summarize(checks), notes: ['a note'] })
  assert.match(text, /✓ ok thing/)
  assert.match(text, /✗ bad thing/)
  assert.ok(!text.includes('never shown'), 'a passing check must not nag')
  assert.match(text, /↳ do this/)
  assert.match(text, /note: a note/)
})
