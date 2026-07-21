// Composition root for `cuckoocode config doctor`.
//
// LAZY. Reached only through a dynamic import in src/cli.js, exactly like the
// UI bundle, so the launch path's static closure never grows to carry a
// diagnostic tool. test/architecture.test.js asserts that.
//
// Doctor NEVER runs automatically. It makes real inference requests, and a
// launcher that quietly bills you a token every time you start it would be a
// worse bug than anything it detects.

import { existsSync } from 'node:fs'
import { buildEnvPlan } from '../core/env.js'
import { applyOverrides } from '../core/overrides.js'
import { resolveProfile } from '../core/profile.js'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  SKIP,
  interpretMessagesProbe,
  interpretToolProbe,
  makeCheck,
  probeSpec,
  redactDeep,
  remainingBudget,
  renderText,
  staticChecks,
  summarize,
} from '../core/doctor.js'
import { bindingEntries, pruneBindings } from '../core/binding.js'
import { createProbe } from '../adapters/doctor/probe.js'

/**
 * @param {object} opts
 * @param {{store, registry, proc}} opts.deps
 * @param {boolean} [opts.offline]     skip every network probe
 * @param {boolean} [opts.fix]         apply the repairs that are unambiguous
 * @param {number}  [opts.totalTimeoutMs]
 * @param {() => number} [opts.now]
 * @param {object} [opts.probe]        injected in tests
 * @returns {Promise<{report:object, exitCode:number}>}
 */
export async function runDoctor({
  deps,
  offline = false,
  fix = false,
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  now = () => Date.now(),
  probe = null,
}) {
  const { store, registry, proc } = deps
  const ambient = proc.env()
  const loaded = store.load()
  const notes = []

  let cwd = null
  try {
    cwd = proc.cwd()
  } catch {
    notes.push('the current directory no longer exists, so directory bindings were not consulted.')
  }

  const selection = resolveProfile(loaded.state, { cwd, platform: process.platform })
  const profile = selection.profile ? applyOverrides(selection.profile, selection.overrides) : null
  const provider = profile ? registry.byId(profile.provider) : null
  const plan = profile ? buildEnvPlan(profile, provider, ambient) : null

  let binary = { path: null, error: null }
  try {
    binary = { path: proc.resolveBinary(), error: null }
  } catch (err) {
    binary = { path: null, error: err.message }
  }

  // The ONLY place in this codebase that stats a binding path. Resolution never
  // does, which is what keeps it free on every launch.
  const deadBindingPaths = bindingEntries(loaded.state)
    .filter((b) => !existsSync(b.key))
    .map((b) => b.key)

  const checks = staticChecks({
    loaded,
    selection,
    profile,
    provider,
    plan,
    modes: store.modes ? store.modes() : { dir: null, file: null },
    binary,
    cwd,
    deadBindingPaths,
  })

  // ---- live probes ---------------------------------------------------------
  const spec = plan ? probeSpec(profile, provider, plan) : null
  const secrets = spec?.credential ? [spec.credential] : []

  if (offline) {
    checks.push(makeCheck('probe', 'endpoint probe', SKIP, 'skipped (--offline)'))
  } else if (!spec?.baseUrl) {
    checks.push(
      makeCheck(
        'probe',
        'endpoint probe',
        SKIP,
        'skipped: this profile talks to Anthropic directly, where Claude Code uses your ' +
          'existing login rather than a key this probe could present',
      ),
    )
  } else if (!spec.credential && !provider?.credentialOptional) {
    checks.push(
      makeCheck('probe', 'endpoint probe', SKIP, 'skipped: no credential to authenticate with'),
    )
  } else if (spec.models.length === 0) {
    checks.push(
      makeCheck('probe', 'endpoint probe', SKIP, 'skipped: this profile pins no model ids'),
    )
  } else {
    const client = probe ?? createProbe()
    const startedAt = now()
    let deadlineHit = false

    for (const model of spec.models) {
      const budget = remainingBudget(startedAt, now(), totalTimeoutMs, probeTimeoutMs)
      if (budget <= 0) {
        deadlineHit = true
        break
      }
      const result = await client.messages({
        baseUrl: spec.baseUrl,
        credentialEnv: spec.credentialEnv,
        credential: spec.credential,
        model: model.id,
        timeoutMs: budget,
      })
      checks.push(interpretMessagesProbe({ model: model.id, result, provider }))
    }

    const reachable = checks.some((c) => c.id.startsWith('endpoint-') && c.status === 'ok')
    const toolBudget = remainingBudget(startedAt, now(), totalTimeoutMs, probeTimeoutMs)
    if (reachable && spec.toolModel && toolBudget > 0) {
      const result = await client.messages({
        baseUrl: spec.baseUrl,
        credentialEnv: spec.credentialEnv,
        credential: spec.credential,
        model: spec.toolModel,
        tools: true,
        timeoutMs: toolBudget,
      })
      checks.push(interpretToolProbe({ model: spec.toolModel, result }))
    } else if (reachable && spec.toolModel) {
      deadlineHit = true
    }

    if (deadlineHit) {
      checks.push(
        makeCheck(
          'probe-deadline',
          'endpoint probe',
          SKIP,
          `stopped after the ${totalTimeoutMs}ms total budget; some checks did not run`,
        ),
      )
    }

    if (spec.models.some((m) => m.suffixed)) {
      // Say what was NOT tested. A probe that quietly tests a different string
      // than the launch sends is worse than no probe.
      notes.push(
        'models were probed without the [1m] suffix the launch appends. The suffix is a ' +
          'Claude Code client-side signal and whether it reaches the endpoint in the model ' +
          'string has not been verified here, so probing it could report a false 404.',
      )
    }
    notes.push(
      'probes are non-streaming on purpose: at least one supported endpoint answers a bad ' +
        'token with HTTP 200 and an SSE stream that dies silently, which a streaming probe ' +
        'cannot tell apart from success.',
    )
  }

  // ---- repairs -------------------------------------------------------------
  const repairs = []
  if (fix && !loaded.readOnly) {
    const pruned = pruneBindings(loaded.state, (key) => existsSync(key))
    if (pruned.removed.length > 0) {
      try {
        store.save(pruned.state)
        for (const r of pruned.removed) repairs.push(`removed binding ${r.key} (${r.reason})`)
      } catch (err) {
        repairs.push(`could not write repairs: ${err.message}`)
      }
    }
  }

  const summary = summarize(checks)
  const report = redactDeep(
    {
      profile: selection.name,
      source: selection.source,
      provider: provider?.id ?? profile?.provider ?? null,
      endpoint: spec?.baseUrl ?? null,
      checks,
      repairs,
      notes,
      summary,
    },
    secrets,
  )

  return { report, exitCode: summary.exitCode, render: () => renderText(report) }
}
