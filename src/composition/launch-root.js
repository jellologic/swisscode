// COLD PATH composition root.
//
// Everything imported transitively from here must stay dependency-free: this is
// the module that runs on every launch, and it must never reach React, Ink, or
// anything under adapters/ui or adapters/catalog. test/architecture.test.js
// walks the import graph from bin/cuckoocode.js and fails if it does.

import { buildArgs } from '../core/args.js'
import { buildEnvPlan, materializeEnv } from '../core/env.js'
import { applyOverrides, retargetProvider } from '../core/overrides.js'
import { resolveProfile } from '../core/profile.js'
import { createFsConfigStore } from '../adapters/store/fs-config-store.js'
import { createNodeProcess, detectRecursion } from '../adapters/process/node-process.js'
import { registry as providerRegistry } from '../adapters/providers/registry.js'

export function defaultDeps() {
  return {
    store: createFsConfigStore(),
    registry: providerRegistry,
    proc: createNodeProcess(),
  }
}

function safeCwd(proc) {
  try {
    // A deleted working directory must never prevent a launch; it just means
    // no directory binding applies.
    return proc.cwd()
  } catch {
    return null
  }
}

export class LaunchError extends Error {
  constructor(message, code = 2) {
    super(message)
    this.exitCode = code
  }
}

/**
 * Resolve everything a launch needs, without launching. Separated so the CLI
 * can decide to open the wizard and so tests can assert the plan.
 *
 * PER-RUN OVERRIDES NEVER PERSIST. Nothing on this path calls store.save, and
 * test/core/overrides.test.js pins that with a counting stub: the only writers
 * in the codebase are the wizard and the `config *` subcommands.
 */
export function planLaunch({
  store,
  registry,
  proc,
  passthrough = [],
  skipOverride = null,
  positional = null,
  profileFlag = null,
  overrides = {},
}) {
  const ambient = proc.env()

  if (detectRecursion(ambient)) {
    throw new LaunchError(
      'refusing to launch: CUCKOOCODE=1 is already set, which means cuckoocode ' +
        'resolved to itself (an alias or a shim on PATH). Point ' +
        'CUCKOOCODE_CLAUDE_BIN at the real claude binary.',
      1,
    )
  }

  const loaded = store.load()
  const sel = resolveProfile(loaded.state, {
    cwd: safeCwd(proc),
    platform: process.platform,
    positional,
    profileFlag,
  })

  // An unknown --cc-profile, or a positional and a flag naming different
  // profiles. Both are explicit assertions of intent, so neither is guessed at.
  if (sel.error) throw new LaunchError(sel.error)

  if (!sel.profile) {
    return { needsSetup: true, loaded, selection: sel }
  }

  // A matched positional profile name is CONSUMED — claude never sees it.
  const args = sel.consumedPositional ? passthrough.slice(1) : passthrough

  // Pipeline, in order: binding overrides, then provider retarget, then the
  // remaining CLI overrides. Retargeting first means --cc-base-url can still
  // correct a base URL borrowed from another profile.
  let profile = applyOverrides(sel.profile, sel.overrides)
  let borrowedFrom = null

  if (overrides.provider) {
    const target = registry.byId(overrides.provider)
    if (!target) {
      throw new LaunchError(
        `--cc-provider "${overrides.provider}" is not a known provider. Valid ids: ` +
          `${registry.all().map((p) => p.id).join(', ')}.`,
      )
    }
    const retarget = retargetProvider(profile, overrides.provider, loaded.state, target, ambient)
    if (!retarget.ok) throw new LaunchError(retarget.reason)
    profile = retarget.profile
    borrowedFrom = retarget.borrowedFrom
  }

  const { provider: _dropped, ...rest } = overrides
  profile = applyOverrides(profile, rest)

  const provider = registry.byId(profile.provider)

  if (!provider && !profile.baseUrl) {
    // Launching anyway would send this profile's third-party key to
    // api.anthropic.com and bill the wrong account.
    throw new LaunchError(
      `profile "${sel.name}" uses provider "${profile.provider}", which this ` +
        'version of cuckoocode does not know, and it has no baseUrl of its own. ' +
        'Run `cuckoocode config` to repair it.',
    )
  }

  const plan = buildEnvPlan(profile, provider, ambient)
  return {
    needsSetup: false,
    loaded,
    selection: sel,
    profile,
    provider,
    plan,
    borrowedFrom,
    overridden: Object.keys(rest).length > 0 || Boolean(overrides.provider),
    env: materializeEnv(ambient, plan),
    args: buildArgs(profile, args, skipOverride),
  }
}

/**
 * One line, only when the user did not get the profile they would have got by
 * default. Silence is the common case, which is what keeps the line meaningful.
 */
export function bannerFor(planned) {
  const { selection, provider, profile } = planned
  const named = selection.source === 'binding' || selection.source === 'positional' || selection.source === 'flag'
  if (!named && !planned.overridden) return null

  const where =
    selection.source === 'binding'
      ? ` (binding: ${selection.bindingKey})`
      : selection.source === 'flag'
        ? ' (--cc-profile)'
        : ''
  const model = profile?.models?.opus ?? provider?.defaultModels?.opus ?? '—'
  const borrowed = planned.borrowedFrom ? `, credential from profile "${planned.borrowedFrom}"` : ''
  const overridden = planned.overridden ? ', overridden for this run' : ''
  // ' · ' rather than '/': model ids contain slashes, and "openrouter/openrouter/fusion"
  // reads like a typo.
  return (
    `cuckoocode: profile "${selection.name ?? '—'}"${where} → ` +
    `${provider?.id ?? profile?.provider} · ${model}${borrowed}${overridden}`
  )
}

export function main({
  passthrough = [],
  skipOverride = null,
  positional = null,
  profileFlag = null,
  overrides = {},
  deps = null,
  report = defaultReport,
}) {
  const { store, registry, proc } = deps ?? defaultDeps()
  const planned = planLaunch({
    store,
    registry,
    proc,
    passthrough,
    skipOverride,
    positional,
    profileFlag,
    overrides,
  })
  if (planned.needsSetup) return planned

  // Every line below goes to STDERR. stdout belongs to Claude Code and may be
  // piped into something that parses it.
  //
  // There is no --quiet FLAG: the reserved namespace is config|setup|--safe|
  // --yolo and grows exactly once, by the --cc- prefix, in the UX phase.
  // Suppression is `settings.quiet` in config.json or CUCKOOCODE_QUIET=1.
  const quiet = Boolean(planned.loaded.state?.settings?.quiet) || proc.env().CUCKOOCODE_QUIET === '1'

  if (!quiet) {
    for (const warning of planned.loaded.warnings ?? []) report(`cuckoocode: ${warning}`)
    for (const warning of planned.selection.warnings ?? []) report(`cuckoocode: ${warning}`)
    // `info` describes something working as intended, so it stays off unless
    // someone is deliberately looking. Everything else describes a conflict
    // between the user's shell and their profile, which they cannot see.
    for (const w of planned.plan.warnings ?? []) {
      if (w.severity !== 'info') report(`cuckoocode: ${w.message}`)
    }

    const banner = bannerFor(planned)
    if (banner) report(banner)
  }

  // Never stdout: stdout may be piped into something that parses it.
  proc.replace(proc.resolveBinary(), planned.args, planned.env)
  return planned
}

function defaultReport(line) {
  console.error(line)
}
