// Composition root for `swisscode config doctor`.
//
// LAZY. Reached only through a dynamic import in src/cli.ts, exactly like the
// UI bundle, so the launch path's static closure never grows to carry a
// diagnostic tool. test/architecture.test.ts asserts that.
//
// Doctor NEVER runs automatically. It makes real inference requests, and a
// launcher that quietly bills you a token every time you start it would be a
// worse bug than anything it detects.

import { existsSync } from 'node:fs'
import { buildEnvPlan } from '../adapters/agents/claude-code/env.ts'
import { claudeCode } from '../adapters/agents/claude-code/index.ts'
import { applyOverrides } from '../core/overrides.ts'
import { resolveProfile } from '../core/profile.ts'
import { resolveProfileRefs } from '../core/resolve.ts'
import { buildIntent } from '../core/intent.ts'
import { sanitizeUrlForDisplay, urlCredentials } from '../core/url-safety.ts'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  OK,
  SKIP,
  WARN,
  interpretMessagesProbe,
  interpretToolProbe,
  makeCheck,
  probeSpec,
  redactDeep,
  remainingBudget,
  renderText,
  staticChecks,
  summarize,
} from '../adapters/agents/claude-code/doctor.ts'
import { bindingEntries, pruneBindings } from '../core/binding.ts'
import { withCustomProviders } from '../adapters/providers/composite.ts'
import { createProbe } from '../adapters/doctor/probe.ts'
import {
  describeIdentity,
  readSessionIdentity,
  sessionDirLooksInitialised,
} from '../adapters/claude-session/identity.ts'
import { measureAccounts, remainingMap } from '../adapters/usage/measure.ts'
import { CONFLICT_REASON, credentialSource } from '../core/account.ts'
import type { MeasureOptions } from '../adapters/usage/measure.ts'
import type { LaunchDeps } from './launch-root.ts'
import { createOllamaIntrospect, interpretOllamaContext } from '../adapters/doctor/ollama.ts'
import type {
  AnthropicMessagesProbePort,
  DoctorReport,
  DoctorRun,
  OllamaIntrospectPort,
} from '../ports/doctor.ts'

export type RunDoctorOptions = {
  deps: LaunchDeps
  /** skip every network probe */
  offline?: boolean
  /** apply the repairs that are unambiguous */
  fix?: boolean
  totalTimeoutMs?: number
  probeTimeoutMs?: number
  now?: () => number
  /**
   * Injected in tests. Typed as the PORT, so a fake that forgets `messages`, or
   * whose `messages` returns the wrong shape, fails to compile at the test's
   * call site rather than at the first await.
   */
  probe?: AnthropicMessagesProbePort | null
  /** Injected in tests, like `probe`. Only consulted for an Ollama profile. */
  ollama?: OllamaIntrospectPort | null
  /**
   * Injected in tests, and REQUIRED for the suite to stay offline.
   *
   * Unlike `probe` and `ollama`, which the tests inject to observe what was
   * asked, this one exists because the usage refresh below reaches
   * api.anthropic.com by default. A doctor test with a `usage`-strategy profile
   * and no `--offline` would otherwise make a real request against whatever
   * credential the machine happens to hold.
   */
  usageFetch?: MeasureOptions['fetchUsage'] | null
}

/**
 * The return type is the port's `DoctorRun`, which pins `exitCode` to the
 * meaningful triple `0 | 1 | 2` — clean / warnings / errors — rather than
 * `number`. It is derived by `summarize`, never hand-set, so the number and the
 * human-readable report cannot disagree.
 */
export async function runDoctor({
  deps,
  offline = false,
  fix = false,
  totalTimeoutMs = DEFAULT_TOTAL_TIMEOUT_MS,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  now = () => Date.now(),
  probe = null,
  ollama = null,
  usageFetch = null,
}: RunDoctorOptions): Promise<DoctorRun> {
  const { store, registry: baseRegistry, agents, proc } = deps
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
  // The doctor resolves exactly as the launch path does, or it would diagnose a
  // configuration nobody runs. A broken reference surfaces as a check below
  // rather than as an exception here, which is the whole point of a doctor.
  const resolution = selection.name ? resolveProfileRefs(loaded.state, selection.name) : null
  const resolutionError = resolution && !resolution.ok ? resolution.reason : null
  const profile =
    resolution?.ok ? applyOverrides(resolution.resolved, selection.overrides) : null
  // Same composition as the launch path: a doctor that could not see a custom
  // provider would report "unknown provider" for a profile that launches fine.
  const registry = withCustomProviders(baseRegistry, loaded.state)
  const provider = profile ? registry.byId(profile.provider) : null
  const plan = profile ? buildEnvPlan(profile, provider, ambient) : null
  // The doctor validates the selected agent's binary; the endpoint probe below
  // is shared (every agent reaches the same Anthropic-compatible endpoint).
  const agent = agents.byId(profile?.agent ?? claudeCode.id) ?? claudeCode

  // Agent-aware diagnosis: surface what a NON-Claude-Code agent's translate()
  // would warn about (tier-collapse, extended-context) so a Kilo/OpenCode profile
  // is not handed a purely Claude-Code-shaped bill of health. The Claude Code
  // path is skipped here because its translate warnings are the hygiene warnings
  // staticChecks already reports. The shared endpoint probe below is unchanged
  // (baseUrl/credential are provider-level, common to every agent).
  const agentWarnings =
    profile && agent.id !== claudeCode.id
      ? agent.translate({
          intent: buildIntent(profile, provider, ambient),
          profile,
          provider,
          passthrough: [],
          ambient,
        }).warnings
      : []

  let binary: { path: string | null; error: string | null | undefined } = {
    path: null,
    error: null,
  }
  try {
    binary = { path: proc.resolveBinary(agent.binary), error: null }
  } catch (err) {
    // Property read preserved verbatim — see the note in the UI wizard's
    // `persist`. Neither `instanceof Error` narrowing nor a `?? null` here:
    // both would edit the program. A throw with no `.message` stores undefined
    // today, `staticChecks` already reads it as `binary.error ?? 'not found'`,
    // and the input type says so rather than tidying it.
    binary = { path: null, error: (err as { message?: string }).message }
  }

  // The ONLY place in this codebase that stats a binding path. Resolution never
  // does, which is what keeps it free on every launch.
  const deadBindingPaths = bindingEntries(loaded.state)
    .filter((b) => !existsSync(b.key))
    .map((b) => b.key)

  if (resolutionError) notes.push(resolutionError)

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

  // Agent capability warnings become doctor checks (info -> ok, else warn).
  for (const w of agentWarnings) {
    checks.push(
      makeCheck(`agent-${w.code}`, `agent (${agent.label})`, w.severity === 'info' ? OK : WARN, w.message),
    )
  }

  // An account holding BOTH a key and a session directory.
  //
  // This check exists because its absence was a wrong answer, not a missing
  // one. The web API refuses to save such an account and `accounts login`
  // refuses to create one, but a hand-edited config reached the launch path,
  // which silently preferred the session and dropped the key — while the
  // `credential` check above cheerfully reported "no ANTHROPIC_API_KEY; this
  // provider allows that" about a config that visibly contains one. The rule
  // now has a single owner in core/account.ts and this consults it.
  if (profile && credentialSource(profile) === 'conflict') {
    checks.push(
      makeCheck('credential-conflict', 'credential', WARN, CONFLICT_REASON, {
        fix: `the launch uses the session directory and ignores the key — remove one from account "${profile.accountName}"`,
      }),
    )
  }

  // A session directory nobody has logged into.
  //
  // THE FAILURE THIS CATCHES IS EXPENSIVE BECAUSE IT IS LATE. Resolution
  // succeeds, the env plan is correct, `execve` replaces the process — and the
  // first sign of trouble is the agent's own login prompt, by which point
  // swisscode no longer exists to explain itself. Nothing earlier in the launch
  // can catch it, because the launch path deliberately never opens the
  // directory it points at. So it belongs here, in the one command whose job is
  // to look.
  //
  // Costs a file read, no credential and no network, so it runs under
  // `--offline` like the rest of the static checks.
  if (profile?.configDir) {
    const dir = profile.configDir
    const identity = readSessionIdentity(dir)
    if (identity) {
      checks.push(
        makeCheck('session', 'session login', OK, `${describeIdentity(identity)}  —  ${dir}`),
      )
    } else {
      // "Never used" and "used but logged out" get different sentences because
      // they are different problems: one is onboarding you have not done, the
      // other is a login that lapsed. Both take the same fix, but a user who is
      // told the right one stops guessing.
      const used = sessionDirLooksInitialised(dir, { exists: existsSync })
      checks.push(
        makeCheck(
          'session',
          'session login',
          WARN,
          used
            ? `${dir} has been used but carries no login — nobody has completed \`/login\` there`
            : `${dir} has never been used by the agent`,
          { fix: `swisscode config accounts login ${profile.accountName}` },
        ),
      )
    }
  }

  // live probes
  const spec = plan ? probeSpec(profile, provider, plan) : null
  // Redaction also covers a credential carried as https://user:pass@host userinfo,
  // which is distinct from the header credential above.
  //
  // A provider's `defaultCredential` is deliberately NOT redacted. It is not a
  // secret — it ships in the source, the endpoint ignores it, and the port says
  // so. Treating it as one actively corrupts the report: Ollama's placeholder is
  // the literal string "ollama", so redaction rewrote the provider line to
  // `Ollama (local) (<redacted>)` and would eat any model id containing the
  // word. Redaction has to cover real secrets exactly, not every string that
  // happens to sit in a credential-shaped slot.
  const isPlaceholder = Boolean(spec?.credential) && spec?.credential === provider?.defaultCredential
  const secrets = [
    ...(spec?.credential && !isPlaceholder ? [spec.credential] : []),
    ...urlCredentials(spec?.baseUrl),
  ]

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

    if (agent.capabilities.extendedContextSuffix && spec.models.some((m) => m.suffixed)) {
      // Say what was NOT tested. A probe that quietly tests a different string
      // than the launch sends is worse than no probe. Only for agents that
      // actually append [1m] — Kilo/OpenCode launch with bare ids.
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

  // Provider-specific diagnosis: the context window a local Ollama actually
  // serves.
  //
  // Gated on the provider ID rather than generalised, and deliberately so. This
  // is not a capability every provider has a version of — it exists because
  // Ollama is the one preset whose effective context is set OUTSIDE the model
  // id, by however the server was started, and therefore cannot be derived at
  // launch or seen at runtime. Inventing a port method for "introspect a
  // provider" on a sample size of one would be a shape guessed from a single
  // example; when a second provider needs it, its second caller will show what
  // the abstraction actually is.
  //
  // Unlike the messages probe this bills nothing — /api/ps and /api/show run no
  // inference — but it is still a network call, so --offline skips it.
  if (provider?.id === 'ollama' && spec?.baseUrl) {
    if (offline) {
      checks.push(makeCheck('ollama-context', 'context window', SKIP, 'skipped (--offline)'))
    } else if (spec.models.length === 0) {
      checks.push(
        makeCheck('ollama-context', 'context window', SKIP, 'skipped: this profile pins no model ids'),
      )
    } else {
      const introspect = ollama ?? createOllamaIntrospect()
      for (const model of spec.models) {
        // `probeTimeoutMs` per call rather than a slice of the total budget.
        // The total budget exists to bound BILLABLE inference; these are
        // free local metadata reads, at most one per distinct pinned model,
        // each already capped by its own timeout.
        const ctx = await introspect.context({
          baseUrl: spec.baseUrl,
          model: model.id,
          timeoutMs: probeTimeoutMs,
        })
        const verdict = interpretOllamaContext(ctx, { model: model.id })
        checks.push(
          makeCheck(
            `ollama-context-${model.id}`,
            'context window',
            verdict.status === 'ok' ? OK : verdict.status === 'warn' ? WARN : SKIP,
            verdict.detail,
            verdict.fix ? { fix: verdict.fix } : {},
          ),
        )
      }
    }
  }

  // Refresh the usage snapshot.
  //
  // The doctor is where `core/resolve.ts` ALREADY SENDS PEOPLE: when a `usage`
  // profile has no snapshot, `selectAccount` falls back to the first account and
  // prints "Run `swisscode config doctor` to refresh usage." Until this block
  // existed that sentence was a lie — the doctor had no idea what a snapshot
  // was, so the advice sent users in a circle.
  //
  // Scoped to the accounts a `usage` profile actually names, rather than every
  // account on the machine. Each measurement can raise a Keychain prompt, and
  // prompting for figures that nothing will ever read is a cost with no answer
  // attached.
  const usageAccountNames = [
    ...new Set(
      Object.values(loaded.state.profiles ?? {})
        .filter((p) => p.strategy === 'usage')
        .flatMap((p) => p.accounts ?? []),
    ),
  ]
  if (usageAccountNames.length === 0) {
    checks.push(
      makeCheck(
        'usage-snapshot',
        'usage snapshot',
        SKIP,
        'skipped: no profile selects its account by remaining usage',
      ),
    )
  } else if (offline) {
    checks.push(makeCheck('usage-snapshot', 'usage snapshot', SKIP, 'skipped (--offline)'))
  } else {
    const measurements = await measureAccounts(
      usageAccountNames.map((name) => {
        const account = loaded.state.providerAccounts?.[name]
        return { name, ...(account?.configDir ? { configDir: account.configDir } : {}) }
      }),
      usageFetch ? { fetchUsage: usageFetch } : {},
    )
    const remaining = remainingMap(measurements)
    const measured = Object.keys(remaining)
    if (measured.length === 0) {
      checks.push(
        makeCheck(
          'usage-snapshot',
          'usage snapshot',
          WARN,
          'nothing could be measured, so the cached snapshot was left alone',
          { fix: 'swisscode config accounts usage' },
        ),
      )
    } else {
      // Best effort, like every write to the state directory. The figures are
      // already in the report; failing a diagnostic because its cache could not
      // be written would trade a working answer for a tidy filesystem.
      deps.usage?.write({ remaining, checkedAt: now() })
      checks.push(
        makeCheck(
          'usage-snapshot',
          'usage snapshot',
          OK,
          measured.map((n) => `${n} ${remaining[n]}% left`).join(',  '),
        ),
      )
      // Name what was NOT measured. A partial snapshot still selects, and it
      // selects among the accounts that answered — so an account missing from
      // it silently stops being a candidate, which is worth one line.
      const missed = usageAccountNames.filter((n) => !(n in remaining))
      if (missed.length > 0) {
        checks.push(
          makeCheck(
            'usage-unmeasured',
            'usage snapshot',
            WARN,
            `not measured: ${missed.join(', ')} — selection will pass over them until they answer`,
            { fix: 'swisscode config accounts usage' },
          ),
        )
      }
    }
  }

  // repairs
  const repairs = []
  if (fix && !loaded.readOnly) {
    const pruned = pruneBindings(loaded.state, (key) => existsSync(key))
    if (pruned.removed.length > 0) {
      try {
        store.save(pruned.state)
        for (const r of pruned.removed) repairs.push(`removed binding ${r.key} (${r.reason})`)
      } catch (err) {
        repairs.push(`could not write repairs: ${(err as { message?: string }).message}`)
      }
    }
  }

  const summary = summarize(checks)
  // `redactDeep` is declared `(value: unknown) => unknown` and that is correct:
  // it walks an arbitrary JSON-ish value. It is structure-preserving in
  // practice — strings stay strings, objects keep their keys — but a generic
  // `<T>(v: T) => T` would be an overclaim, because redaction rewrites string
  // CONTENTS and could in principle rewrite one that a literal union depends on
  // (an API key spelled "flag" would corrupt `source`). So the claim is made
  // here, locally and visibly, over an object this function just built and
  // whose shape it therefore knows, rather than being baked into core/.
  const report = redactDeep(
    {
      profile: selection.name,
      source: selection.source,
      provider: provider?.id ?? profile?.provider ?? null,
      endpoint: sanitizeUrlForDisplay(spec?.baseUrl),
      checks,
      repairs,
      notes,
      summary,
    },
    secrets,
  ) as DoctorReport

  return { report, exitCode: summary.exitCode, render: () => renderText(report) }
}
