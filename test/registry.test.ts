// Conformance rules that hold for every provider descriptor, present and
// future. Adding a provider means adding a data module; these are the
// invariants that stop the next one shipping the bug the last one shipped.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PROVIDERS, REJECTED_PROVIDERS, byId } from '../src/adapters/providers/registry.ts'
import { CATALOG_IDS } from '../src/adapters/catalog/registry.ts'
import { SUFFIX } from '../src/adapters/agents/claude-code/context.ts'
import { buildEnvPlan, COMPAT_ENV } from '../src/adapters/agents/claude-code/env.ts'
import { TIER_ENV_VARS } from '../src/adapters/agents/claude-code/tiers.ts'
import { TIERS } from '../src/core/tiers.ts'

const CREDENTIAL_ENVS = ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']

test('provider ids are unique', () => {
  const ids = PROVIDERS.map((p) => p.id)
  assert.deepEqual([...new Set(ids)], ids)
})

for (const p of PROVIDERS) {
  test(`descriptor ${p.id}: required fields`, () => {
    assert.equal(typeof p.id, 'string')
    assert.ok(p.label, 'every provider needs a human-readable label')
    assert.ok(CREDENTIAL_ENVS.includes(p.credentialEnv), `bad credentialEnv: ${p.credentialEnv}`)
    assert.ok(p.baseUrl === null || typeof p.baseUrl === 'string')
    assert.equal(typeof p.defaultModels, 'object')
  })

  test(`descriptor ${p.id}: no hand-typed [1m]`, () => {
    // The suffix is derived from extendedContext, per variable, or it gets
    // forgotten on exactly one tier.
    for (const [tier, id] of Object.entries(p.defaultModels)) {
      assert.ok(!String(id).includes(SUFFIX), `${p.id}.${tier} contains a literal ${SUFFIX}`)
    }
  })

  test(`descriptor ${p.id}: env uses no empty-string sentinel`, () => {
    // '' means UNSET for user-supplied maps, but inside the registry it was
    // invisible and unassertable. Descriptors say unsetEnv instead.
    for (const [k, v] of Object.entries(p.env ?? {})) {
      assert.notEqual(v, '', `${p.id}.env.${k} uses '' — use unsetEnv: ['${k}'] instead`)
      assert.equal(typeof v, 'string', `${p.id}.env.${k} must be a string`)
    }
    for (const k of p.unsetEnv ?? []) assert.equal(typeof k, 'string')
  })

  test(`descriptor ${p.id}: defaultModels only names real tiers`, () => {
    for (const tier of Object.keys(p.defaultModels)) {
      // TIERS is readonly Tier[], so .includes() will not accept a plain
      // string. Widening the RECEIVER (not the argument) is what keeps this
      // assertion doing its job: the whole point is to ask whether an
      // arbitrary string is a real tier, which is a question that only exists
      // if the string is allowed to not be one.
      assert.ok((TIERS as readonly string[]).includes(tier), `${p.id} declares unknown tier "${tier}"`)
    }
  })

  test(`descriptor ${p.id}: extendedContext agrees with defaultModels`, () => {
    const ec = p.extendedContext
    if (!ec) return
    assert.equal(typeof ec.supported, 'boolean')
    assert.ok(Array.isArray(ec.models))
    // Claiming 1M for an id the provider never serves is how a suffix ends up
    // on the wrong model; claiming it for none is a dead flag.
    if (ec.supported) {
      assert.ok(ec.models.length > 0, `${p.id} claims extended context with no models`)
      const defaults = new Set(Object.values(p.defaultModels))
      for (const m of ec.models) {
        assert.ok(!m.includes(SUFFIX), `${p.id} extendedContext lists a suffixed id`)
        if (defaults.size > 0) {
          assert.ok(
            defaults.has(m),
            `${p.id} claims 1M for "${m}", which is not one of its default models`,
          )
        }
      }
    }
  })

  test(`descriptor ${p.id}: catalogId resolves to a registered catalog`, () => {
    if (!p.catalogId) return
    assert.ok(CATALOG_IDS.includes(p.catalogId), `${p.id} names unknown catalog ${p.catalogId}`)
  })

  test(`descriptor ${p.id}: a third-party endpoint always clears ANTHROPIC_API_KEY`, () => {
    if (p.baseUrl === null || p.credentialEnv === 'ANTHROPIC_API_KEY') return
    const plan = buildEnvPlan({ provider: p.id, apiKey: 'k' }, p, {
      ANTHROPIC_API_KEY: 'sk-ant-STALE',
    })
    assert.ok(plan.unset.includes('ANTHROPIC_API_KEY'), `${p.id} would bill the wrong account`)
  })

  test(`descriptor ${p.id}: base URL carries no /v1 suffix`, () => {
    if (!p.baseUrl) return
    // Claude Code appends its own path. A base URL ending in /v1 produces
    // /v1/v1/messages and a 404 — the documented ModelScope and SiliconFlow
    // trap.
    assert.ok(!/\/v1\/?$/.test(p.baseUrl), `${p.id} baseUrl ends in /v1`)
    assert.ok(!p.baseUrl.endsWith('/'), `${p.id} baseUrl has a trailing slash`)
  })

  test(`descriptor ${p.id}: every tier gets [1m] or none does`, () => {
    // THE PERMANENT GUARD for the bug this phase fixed. [1m] is read per
    // ANTHROPIC_DEFAULT_*_MODEL variable, so a provider that suffixes three
    // tiers and not the fourth has a tier silently running at the standard
    // window. Nothing about a descriptor's shape prevents that by itself —
    // this does, for every provider added from here on.
    const plan = buildEnvPlan({ provider: p.id, apiKey: 'k' }, p, {})
    // filter(Boolean) does not narrow in TypeScript, so the element type stays
    // `string | undefined` after it. Asserted rather than rewritten to
    // `(v) => v !== undefined`, which WOULD narrow for free but would edit the
    // program this test is pinning.
    const values = TIER_ENV_VARS.map((v) => plan.set[v]).filter(Boolean) as string[]
    if (values.length === 0) return
    const suffixed = values.filter((v) => v.endsWith(SUFFIX))
    assert.ok(
      suffixed.length === 0 || suffixed.length === values.length,
      `${p.id} suffixes ${suffixed.length} of ${values.length} tiers — the ` +
        'unsuffixed ones run at the standard window with no error.',
    )
  })

  test(`descriptor ${p.id}: an extended-context provider suffixes its defaults`, () => {
    // The inverse: declaring extendedContext and then not having it reach the
    // environment is the same bug wearing a fixed-looking descriptor.
    if (!p.extendedContext?.supported) return
    if (Object.keys(p.defaultModels).length === 0) return
    const plan = buildEnvPlan({ provider: p.id, apiKey: 'k' }, p, {})
    for (const v of TIER_ENV_VARS) {
      const value = plan.set[v]
      if (!value) continue
      assert.ok(
        value.endsWith(SUFFIX),
        `${p.id} claims extended context but ${v}=${value} reaches Claude Code bare`,
      )
    }
  })

  test(`descriptor ${p.id}: extendedContext windows are plausible`, () => {
    const ec = p.extendedContext
    if (!ec?.supported) return
    // A window is a documented number, not a vibe. Anything below the standard
    // window is not an EXTENDED context and signals a units mistake.
    const windows = [ec.window, ...Object.values(ec.windows ?? {})].filter(
      (n) => n !== undefined,
    )
    assert.ok(windows.length > 0, `${p.id} declares extended context with no window`)
    for (const wnd of windows) {
      assert.ok(Number.isInteger(wnd) && wnd > 200_000, `${p.id} window ${wnd} is not an extended window`)
    }
  })

  test(`descriptor ${p.id}: disableExperimentalBetas + extendedContext needs a human`, () => {
    // UNVERIFIED HYPOTHESIS: disabling experimental betas may suppress the
    // context beta and cancel [1m]. Nobody has tested it against a live
    // endpoint. Rather than encode a guess either way, make the combination
    // impossible to ship by accident.
    //
    // Static reading of claude 2.1.216 suggests they are INDEPENDENT — the
    // suffix check appears to short-circuit ahead of the beta-header path and
    // to be gated only by CLAUDE_CODE_DISABLE_1M_CONTEXT. That is a reading of
    // minified code, not an observation of behaviour, so it lowers how likely
    // this tripwire is to ever fire without being grounds to remove it. Lift
    // this only against a real endpoint and a >200K conversation.
    const risky = p.compat?.disableExperimentalBetas && p.extendedContext?.supported
    assert.ok(
      !risky,
      `${p.id} combines disableExperimentalBetas with extended context. The ` +
        'interaction between them is untested — confirm against a real claude ' +
        'binary before shipping this combination.',
    )
  })
}

for (const p of PROVIDERS) {
  test(`descriptor ${p.id}: compat flags are all real`, () => {
    // A misspelled flag is a silent no-op that looks like it works — the exact
    // failure mode this indirection exists to prevent. Every key must map.
    for (const [flag, value] of Object.entries(p.compat ?? {})) {
      assert.ok(COMPAT_ENV[flag], `${p.id} sets unknown compat flag "${flag}"`)
      assert.equal(typeof value, 'boolean', `${p.id}.compat.${flag} must be a boolean`)
    }
  })
}

test('no compat flag can reach CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', () => {
  // It also disables gateway model discovery. It must not hide behind a
  // boolean that reads like a harmless compatibility switch, and no provider
  // may set it through the descriptor `env` escape hatch either.
  const vars = Object.values(COMPAT_ENV).map(([k]) => k)
  assert.ok(!vars.includes('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'))
  for (const p of PROVIDERS) {
    assert.ok(
      !('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' in (p.env ?? {})),
      `${p.id} sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC directly`,
    )
  }
})

test('every compat flag maps to a distinct env var', () => {
  const vars = Object.values(COMPAT_ENV).map(([k]) => k)
  assert.deepEqual([...new Set(vars)], vars, 'two flags fight over one variable')
})

test('byId returns null for an unknown id rather than throwing', () => {
  assert.equal(byId('nope'), null)
  assert.equal(byId(undefined), null)
})

test('rejected providers are documented and not shipped', () => {
  const shipped = new Set(PROVIDERS.map((p) => p.id))
  for (const { id, reason } of REJECTED_PROVIDERS) {
    assert.ok(!shipped.has(id), `${id} was rejected but is in the registry`)
    assert.ok(reason && reason.length > 20, `${id} needs a real reason, not a note`)
  }
  const ids = REJECTED_PROVIDERS.map((r) => r.id)
  for (const id of ['iflow', 'volcengine', 'deepseek-direct']) {
    assert.ok(ids.includes(id), `${id} must stay on the rejected list`)
  }
})
