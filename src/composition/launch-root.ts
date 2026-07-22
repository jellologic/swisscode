// COLD PATH composition root.
//
// Everything imported transitively from here must stay dependency-free: this is
// the module that runs on every launch, and it must never reach React, Ink, or
// anything under adapters/ui or adapters/catalog. test/architecture.test.ts
// walks the import graph from bin/cuckoocode.js and fails if it does.

import { buildArgs } from '../core/args.ts'
import { buildEnvPlan, materializeEnv } from '../core/env.ts'
import { applyOverrides, retargetProvider } from '../core/overrides.ts'
import { resolveProfile } from '../core/profile.ts'
import { createFsConfigStore } from '../adapters/store/fs-config-store.ts'
import { createNodeProcess, detectRecursion } from '../adapters/process/node-process.ts'
import { registry as providerRegistry } from '../adapters/providers/registry.ts'
import type { EnvPlan } from '../core/env.ts'
import type { ProfileSelection } from '../core/profile.ts'
import type { ConfigStorePort, LoadResult, Profile } from '../ports/config-store.ts'
import type { ProviderDescriptor, ProviderRegistryPort } from '../ports/provider.ts'
import type { EnvMap, ProcessPort } from '../ports/process.ts'
import type { ProfileOverrides } from '../ports/config-store.ts'

/**
 * THE WIRING CONTRACT.
 *
 * Every composition root in this directory takes exactly this set, and each
 * field is a PORT type, never an adapter type. That is what makes a mis-wire a
 * compile error rather than a runtime `undefined is not a function`: handing
 * `createFsCacheStore()` to `store`, or swapping `store` and `proc`, fails at
 * the call site in this file.
 *
 * It is stated once here and imported by config-root and doctor-root with
 * `import type`, so the three roots cannot drift apart in what they expect.
 */
export type LaunchDeps = {
  store: ConfigStorePort
  registry: ProviderRegistryPort
  proc: ProcessPort
}

export function defaultDeps(): LaunchDeps {
  return {
    store: createFsConfigStore(),
    registry: providerRegistry,
    proc: createNodeProcess(),
  }
}

function safeCwd(proc: ProcessPort): string | null {
  try {
    // A deleted working directory must never prevent a launch; it just means
    // no directory binding applies.
    return proc.cwd()
  } catch {
    return null
  }
}

/**
 * `exitCode` is declared by INTERFACE MERGING rather than as a class field.
 *
 * A `exitCode: number` field declaration would compile — erasableSyntaxOnly
 * permits it — but under useDefineForClassFields it emits an extra `exitCode;`
 * into the class body. That is a change to the shipped program for no gain. The
 * merged interface is pure type space and erases to nothing, so dist/ is
 * byte-identical to the JavaScript this file replaced.
 */
export interface LaunchError {
  /** process exit code the CLI should use for this failure */
  exitCode: number
}

export class LaunchError extends Error {
  constructor(message: string, code: number = 2) {
    super(message)
    this.exitCode = code
  }
}

/**
 * Resolve everything a launch needs, without launching. Separated so the CLI
 * can decide to open the wizard and so tests can assert the plan.
 *
 * PER-RUN OVERRIDES NEVER PERSIST. Nothing on this path calls store.save, and
 * test/core/overrides.test.ts pins that with a counting stub: the only writers
 * in the codebase are the wizard and the `config *` subcommands.
 */
export type PlanLaunchOptions = LaunchDeps & {
  passthrough?: string[]
  skipOverride?: boolean | null
  positional?: string | null
  profileFlag?: string | null
  overrides?: ProfileOverrides
}

/** No profile could be selected; the CLI opens the wizard instead of launching. */
export type LaunchNeedsSetup = {
  needsSetup: true
  loaded: LoadResult
  selection: ProfileSelection
}

/** Everything a launch needs, resolved. */
export type LaunchPlan = {
  needsSetup: false
  loaded: LoadResult
  selection: ProfileSelection
  profile: Profile
  /**
   * null is a REAL state, not a defect: a profile naming a provider this build
   * does not know still launches, provided it carries a baseUrl of its own.
   * The refusal a few lines below is the only place that combination is fatal.
   */
  provider: ProviderDescriptor | null
  plan: EnvPlan
  borrowedFrom: string | null
  overridden: boolean
  env: EnvMap
  args: string[]
}

/**
 * Discriminated on `needsSetup`, which is what makes the CLI's
 * `if (!planned.needsSetup) return` a real narrowing: `planned.args` is
 * unreachable on the setup branch because on that branch it does not exist.
 * The old shape said `{needsSetup, loaded, selection}` and `{needsSetup, …9
 * more}` were the same object type with most fields absent.
 */
export type PlannedLaunch = LaunchNeedsSetup | LaunchPlan

export function planLaunch({
  store,
  registry,
  proc,
  passthrough = [],
  skipOverride = null,
  positional = null,
  profileFlag = null,
  overrides = {},
}: PlanLaunchOptions): PlannedLaunch {
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
export function bannerFor(planned: LaunchPlan): string | null {
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

export type MainOptions = {
  passthrough?: string[]
  skipOverride?: boolean | null
  positional?: string | null
  profileFlag?: string | null
  overrides?: ProfileOverrides
  /** null => wire the real adapters. Tests pass fakes. */
  deps?: LaunchDeps | null
  /** every line goes to STDERR; stdout belongs to Claude Code */
  report?: (line: string) => void
}

export function main({
  passthrough = [],
  skipOverride = null,
  positional = null,
  profileFlag = null,
  overrides = {},
  deps = null,
  report = defaultReport,
}: MainOptions): PlannedLaunch {
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

function defaultReport(line: string): void {
  console.error(line)
}
