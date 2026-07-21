// F#3 — per-provider gateway compatibility flags.
//
// The point of routing these through a named boolean instead of letting
// descriptors write env vars directly is that a misspelled variable name is a
// silent no-op that looks like it works. A misspelled FLAG name is catchable,
// and test/registry.test.js catches it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildEnvPlan, COMPAT_ENV } from '../../src/core/env.ts'
import type { ClaudeCodeCompatFlags, ProviderDescriptor } from '../../src/ports/provider.ts'
import type { Profile } from '../../src/ports/config-store.ts'
import type { EnvMap } from '../../src/ports/process.ts'

const gateway: ProviderDescriptor = {
  id: 'gw',
  label: 'Gateway',
  baseUrl: 'https://gw.example/api',
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  defaultModels: { opus: 'm', sonnet: 'm', haiku: 'm', fable: 'm' },
}

/**
 * A profile fixture. Deliberately looser than `Profile` in exactly two ways,
 * and a test in this file depends on each:
 *
 *  - `Partial`, because these fixtures omit `provider`. buildEnvPlan never
 *    reads it, and filling it in would change the input under test.
 *  - `compat` widened to accept UNKNOWN flag names, because two tests exist
 *    precisely to prove that an unrecognised flag ('turboMode') and the
 *    deliberately-absent one ('disableNonessentialTraffic') write nothing at
 *    all. Typing this as ClaudeCodeCompatFlags would make those two fail to
 *    compile, and the only way to satisfy the compiler would be to delete the
 *    cases they exist to cover.
 *
 * Every other field stays checked against Profile, so a typo'd `apiKey` or a
 * misspelled `env` is still an error here.
 */
type ProfileFixture = Partial<Omit<Profile, 'compat'>> & {
  compat?: Record<string, boolean | undefined>
}

const withCompat = (compat: ClaudeCodeCompatFlags): ProviderDescriptor => ({ ...gateway, compat })
const planOf = (
  profile: ProfileFixture | null | undefined,
  provider: ProviderDescriptor | null | undefined,
  ambient: EnvMap = {},
) => buildEnvPlan(profile as Profile | null | undefined, provider, ambient)

test('each flag maps to the variable that fixes its documented symptom', () => {
  // The mapping IS the feature. If one of these is wrong the flag does nothing
  // and the user reads a symptom that never goes away.
  assert.deepEqual(COMPAT_ENV.disableExperimentalBetas, ['CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS', '1'])
  assert.deepEqual(COMPAT_ENV.disableAdaptiveThinking, ['CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING', '1'])
  assert.deepEqual(COMPAT_ENV.skipFastModeOrgCheck, ['CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK', '1'])
  assert.deepEqual(COMPAT_ENV.enableToolSearch, ['ENABLE_TOOL_SEARCH', '1'])
  assert.deepEqual(COMPAT_ENV.forceIdleTimeoutOff, ['API_FORCE_IDLE_TIMEOUT', '0'])
  assert.deepEqual(COMPAT_ENV.dropAttributionHeader, ['CLAUDE_CODE_ATTRIBUTION_HEADER', '0'])
})

test('API_FORCE_IDLE_TIMEOUT is 0, not 1', () => {
  // Two of the six flags turn something OFF by writing "0". Writing "1" would
  // enable exactly what the user asked to disable.
  // `!` because COMPAT_ENV is declared Record<string, ...> in core/env.ts, so
  // every lookup is nullable. The deepEqual assertions in the test above
  // already pin that both keys exist and what they contain; this one is about
  // the VALUE being '0' rather than '1', and must stay that narrow.
  assert.equal(COMPAT_ENV.forceIdleTimeoutOff![1], '0')
  assert.equal(COMPAT_ENV.dropAttributionHeader![1], '0')
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
  for (const [flag, [envVar, value]] of Object.entries(COMPAT_ENV)) {
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

test('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is unreachable from any flag', () => {
  // It also disables gateway model discovery, so it is deliberately absent from
  // the vocabulary rather than shipped off-by-default.
  const vars = Object.values(COMPAT_ENV).map(([k]) => k)
  assert.ok(!vars.includes('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
  const plan = planOf({ apiKey: 'k', compat: { disableNonessentialTraffic: true } }, gateway)
  assert.equal(plan.set.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined)
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
