// F#3 — per-provider gateway compatibility flags.
//
// The point of routing these through a named boolean instead of letting
// descriptors write env vars directly is that a misspelled variable name is a
// silent no-op that looks like it works. A misspelled FLAG name is catchable,
// and test/registry.test.ts catches it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEnvPlan, COMPAT_ENV } from '../../src/adapters/agents/claude-code/env.ts'
import type { ClaudeCodeCompatFlags } from '../../src/ports/claude-code.ts'
import type { ProviderDescriptor } from '../../src/ports/provider.ts'
import type { ResolvedProfile } from '../../src/ports/config-store.ts'
import type { EnvMap } from '../../src/ports/process.ts'

const gateway: ProviderDescriptor = {
  id: 'gw',
  label: 'Gateway',
  baseUrl: 'https://gw.example/api',
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  defaultModels: { opus: 'm', sonnet: 'm', haiku: 'm', fable: 'm' },
}

/**
 * A profile fixture. Deliberately looser than `ResolvedProfile` in exactly two ways,
 * and a test in this file depends on each:
 *
 *  - `Partial`, because these fixtures omit `provider`. buildEnvPlan never
 *    reads it, and filling it in would change the input under test.
 *  - `compat` widened to accept UNKNOWN flag names, because a test exists
 *    precisely to prove that an unrecognised flag ('turboMode') writes nothing
 *    at all. Typing this as ClaudeCodeCompatFlags would make that one fail to
 *    compile, and the only way to satisfy the compiler would be to delete the
 *    case it exists to cover.
 *
 * Every other field stays checked against ResolvedProfile, so a typo'd `apiKey` or a
 * misspelled `env` is still an error here.
 */
type ProfileFixture = Partial<Omit<ResolvedProfile, 'compat'>> & {
  compat?: Record<string, boolean | undefined>
}

const withCompat = (compat: ClaudeCodeCompatFlags): ProviderDescriptor => ({ ...gateway, compat })
const planOf = (
  profile: ProfileFixture | null | undefined,
  provider: ProviderDescriptor | null | undefined,
  ambient: EnvMap = {},
) => buildEnvPlan(profile as ResolvedProfile | null | undefined, provider, ambient)

test('each flag maps to the variable that fixes its documented symptom', () => {
  // The mapping IS the feature. If one of these is wrong the flag does nothing
  // and the user reads a symptom that never goes away.
  const mapping = Object.fromEntries(
    Object.entries(COMPAT_ENV).map(([flag, { env, value }]) => [flag, [env, value]]),
  )
  assert.deepEqual(mapping.disableExperimentalBetas, ['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', '1'])
  assert.deepEqual(mapping.disableAdaptiveThinking, ['CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', '1'])
  assert.deepEqual(mapping.skipFastModeOrgCheck, ['CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK', '1'])
  assert.deepEqual(mapping.enableToolSearch, ['ENABLE_TOOL_SEARCH', '1'])
  assert.deepEqual(mapping.forceIdleTimeoutOff, ['API_FORCE_IDLE_TIMEOUT', '0'])
  assert.deepEqual(mapping.dropAttributionHeader, ['CLAUDE_CODE_ATTRIBUTION_HEADER', '0'])
  assert.deepEqual(mapping.disableNonessentialTraffic, [
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    '1',
  ])
})

test('API_FORCE_IDLE_TIMEOUT is 0, not 1', () => {
  // Two of the six flags turn something OFF by writing "0". Writing "1" would
  // enable exactly what the user asked to disable.
  // `!` because COMPAT_ENV is declared Record<string, ...> in core/env.ts, so
  // every lookup is nullable. The deepEqual assertions in the test above
  // already pin that both keys exist and what they contain; this one is about
  // the VALUE being '0' rather than '1', and must stay that narrow.
  assert.equal(COMPAT_ENV.forceIdleTimeoutOff!.value, '0')
  assert.equal(COMPAT_ENV.dropAttributionHeader!.value, '0')
})

test('a provider default is applied', () => {
  const plan = planOf({ apiKey: 'k' }, withCompat({ skipFastModeOrgCheck: true }))
  assert.equal(plan.set.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, '1')
})

test('a descriptor false means "not needed", so nothing is written', () => {
  // Descriptors describe a gateway's quirks. They have no business clearing a
  // variable the user set deliberately.
  const plan = planOf({ apiKey: 'k' }, withCompat({ enableToolSearch: false }), {
    ENABLE_TOOL_SEARCH: '1',
  })
  assert.equal(plan.set.ENABLE_TOOL_SEARCH, undefined)
  assert.ok(!plan.unset.includes('ENABLE_TOOL_SEARCH'))
})

test('a profile can turn a provider default ON', () => {
  const plan = planOf({ apiKey: 'k', compat: { disableAdaptiveThinking: true } }, gateway)
  assert.equal(plan.set.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING, '1')
})

test('a profile can turn a provider default OFF, and it actually goes away', () => {
  const plan = planOf(
    { apiKey: 'k', compat: { skipFastModeOrgCheck: false } },
    withCompat({ skipFastModeOrgCheck: true }),
  )
  assert.equal(plan.set.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, undefined)
  assert.ok(plan.unset.includes('CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK'))
})

test('a profile false clears a value inherited from the shell', () => {
  // The whole reason a user's `false` unsets rather than skips. Skipping would
  // leave the shell's value in place and the override would have done nothing —
  // the same silent-inherit shape as the stale base-URL bug.
  const plan = planOf({ apiKey: 'k', compat: { enableToolSearch: false } }, gateway, {
    ENABLE_TOOL_SEARCH: '1',
  })
  assert.ok(plan.unset.includes('ENABLE_TOOL_SEARCH'))
})

test('a profile overrides only the key it names', () => {
  const plan = planOf(
    { apiKey: 'k', compat: { skipFastModeOrgCheck: false } },
    withCompat({ skipFastModeOrgCheck: true, disableAdaptiveThinking: true }),
  )
  assert.ok(plan.unset.includes('CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK'))
  assert.equal(plan.set.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING, '1')
})

test('every flag is independently settable from a profile', () => {
  // "User config must be able to override any of them" — all six, not the ones
  // that happen to be on a descriptor today.
  for (const [flag, { env: envVar, value }] of Object.entries(COMPAT_ENV)) {
    const on = planOf({ apiKey: 'k', compat: { [flag]: true } }, gateway)
    assert.equal(on.set[envVar], value, `${flag} could not be turned on`)
    const off = planOf({ apiKey: 'k', compat: { [flag]: false } }, gateway, { [envVar]: 'x' })
    assert.ok(off.unset.includes(envVar), `${flag} could not be turned off`)
  }
})

test('an unknown flag name is ignored rather than writing a bogus variable', () => {
  const plan = planOf({ apiKey: 'k', compat: { turboMode: true } }, gateway)
  assert.equal(plan.set.turboMode, undefined)
  assert.equal(plan.set.TURBO_MODE, undefined)
})

test('a null or undefined profile compat entry defers to the provider', () => {
  const plan = planOf(
    { apiKey: 'k', compat: { skipFastModeOrgCheck: undefined } },
    withCompat({ skipFastModeOrgCheck: true }),
  )
  assert.equal(plan.set.CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK, '1')
})

// A flag that trades something away used to be handled by a deny-list: no
// flag, and no descriptor allowed to name the variable. The objection recorded
// there was that it "must not hide behind a boolean that reads like a harmless
// compatibility switch" — which is about SILENCE, not about the variable, and
// which does not generalise to the next provider with its own rules.
//
// These four tests are that objection restated as a property of the mechanism:
// a costly flag is reachable, and cannot act quietly.

test('a flag that costs something cannot be set silently', () => {
  const plan = planOf({ apiKey: 'k', compat: { disableNonessentialTraffic: true } }, gateway)
  assert.equal(plan.set.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1', 'flag did not apply')
  const warned = plan.warnings.filter((w) => w.code === 'compat-consequence')
  assert.equal(warned.length, 1, 'enabling a costly flag produced no warning')
  assert.match(warned[0]!.message, /model discovery/, 'the warning does not name what it costs')
})

test('the profile asking for it is info; a provider imposing it is not', () => {
  // Severity encodes WHO chose. A user who typed the flag does not need it
  // repeated on every launch; a user who inherited it from a preset does.
  const chosen = planOf({ apiKey: 'k', compat: { disableNonessentialTraffic: true } }, gateway)
  assert.equal(chosen.warnings.find((w) => w.code === 'compat-consequence')?.severity, 'info')

  const imposed = planOf({ apiKey: 'k' }, withCompat({ disableNonessentialTraffic: true }))
  const w = imposed.warnings.find((x) => x.code === 'compat-consequence')
  assert.equal(w?.severity, 'medium', 'an imposed trade-off must reach stderr')
  assert.match(w!.message, /provider default/)
})

test('turning a costly flag off unsets it and says nothing', () => {
  const off = planOf(
    { apiKey: 'k', compat: { disableNonessentialTraffic: false } },
    withCompat({ disableNonessentialTraffic: true }),
    { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
  )
  assert.ok(off.unset.includes('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
  assert.equal(off.warnings.filter((w) => w.code === 'compat-consequence').length, 0)
})

test('a flag with no trade-off stays silent', () => {
  // Otherwise every launch through a gateway preset would narrate itself and
  // the warnings that matter would stop being read.
  const plan = planOf({ apiKey: 'k', compat: { disableAdaptiveThinking: true } }, gateway)
  assert.equal(plan.set.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING, '1')
  assert.equal(plan.warnings.filter((w) => w.code === 'compat-consequence').length, 0)
})

test('profile.env still outranks a compat flag', () => {
  // The escape hatch is applied last and stays the final word.
  const plan = planOf(
    { apiKey: 'k', compat: { enableToolSearch: true }, env: { ENABLE_TOOL_SEARCH: '0' } },
    gateway,
  )
  assert.equal(plan.set.ENABLE_TOOL_SEARCH, '0')
})

test('compat flags never disturb models, credentials or the base URL', () => {
  const bare = planOf({ apiKey: 'k' }, gateway)
  const flagged = planOf({ apiKey: 'k', compat: { disableAdaptiveThinking: true } }, gateway)
  for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) {
    assert.equal(flagged.set[key], bare.set[key])
  }
})
