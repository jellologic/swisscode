// Composition root for everything under `cuckoocode config`.
//
// LAZY, like the UI bundle and the doctor: reached only through a dynamic
// import in src/cli.js, so none of this is in the launch path's static closure.
//
// WHY EVERY SUBCOMMAND LIVES UNDER `config`
//
// The reserved namespace is `config | setup | --safe | --yolo | --` plus, as of
// this phase, the `--cc-` flag prefix. That is the whole list and it does not
// grow again. `cuckoocode use …` and `cuckoocode doctor` would each claim a
// bare English word from Claude Code's prompt space forever — and `use` is a
// word people type at the start of a prompt. Nesting them under `config` costs
// six characters and reserves nothing, because `config` is already reserved and
// the profile-name grammar forbids creating a profile called `use` or `doctor`
// (core/migrate.ts SOFT_RESERVED), so the second token can never be ambiguous.
//
// Output goes to STDOUT here: nothing is being launched, so stdout is ours, and
// `config doctor --json | jq` has to work.

import { existsSync } from 'node:fs'
import {
  bindPath,
  bindingEntries,
  explainBinding,
  pruneBindings,
  pruneBindingsForProfile,
  unbindPath,
} from '../core/binding.ts'
import { validateProfileName } from '../core/migrate.ts'
import { TIERS } from '../core/tiers.ts'
import type { LaunchDeps } from './launch-root.ts'
import type { LoadResult, Profile, State } from '../ports/config-store.ts'
import type { ProcessPort } from '../ports/process.ts'

/** A line of output. `console.log`/`console.error` both satisfy it. */
type Emit = (line: string) => void

/** Which wizard `openUi` should open. */
export type WizardMode = 'config' | 'setup'

/**
 * How this module reaches the Ink wizard.
 *
 * A CALLBACK, injected by src/cli.js, rather than an import — and the type is
 * spelled here rather than imported from adapters/ui so that nothing in this
 * file, not even in type space, names the UI module. That keeps the lazy
 * boundary a property of the source graph and not merely of the emit.
 *
 * Returns the saved profile, or null when the user cancelled.
 */
export type OpenUi = (
  mode: WizardMode,
  options: { state: State; profileName: string | null },
) => Promise<Profile | null>

export type RunConfigCommandOptions = {
  /** 'config' | 'setup', as parsed from argv */
  command: string | null
  args?: string[]
  deps: LaunchDeps
  openUi: OpenUi
  out?: Emit
  err?: Emit
}

const SUBCOMMANDS = Object.freeze([
  'list', 'default', 'rm', 'use', 'bind', 'unbind', 'bindings', 'doctor', 'help',
])

const USAGE = `cuckoocode config — manage profiles and directory bindings

  cuckoocode config                    edit the active profile, or pick one
  cuckoocode config <name>             create or edit a named profile
  cuckoocode config list               every profile, with its provider and models
  cuckoocode config default <name>     set the profile used when nothing else applies
  cuckoocode config rm <name>          delete a profile and any bindings to it

  cuckoocode config use <name>         bind the current directory to <name>
  cuckoocode config use --show         explain which profile applies here, and why
  cuckoocode config use --clear        remove this directory's binding
  cuckoocode config bind|unbind        aliases for use / use --clear
  cuckoocode config bindings [--prune] list bindings; --prune drops dead ones

  cuckoocode config doctor [--json]    check binary, endpoint, credential, models,
                                       tool calling, env conflicts, permissions
                 [--offline]           skip every network probe
                 [--fix]               apply the unambiguous repairs
                 [--timeout <ms>]      total budget for all probes

Per-run overrides (never persisted):
  --cc-profile <name>   --cc-provider <id>   --cc-base-url <url>
  --cc-model <id>       --cc-model <tier>=<id>    --cc-env KEY=VALUE (KEY= unsets)
`

/** @returns the process exit code */
export async function runConfigCommand({
  command,
  args = [],
  deps,
  openUi,
  out = console.log,
  err = console.error,
}: RunConfigCommandOptions): Promise<number> {
  const [head, ...rest] = args

  // `setup` is only ever the first-run wizard.
  if (command === 'setup') {
    if (args.length > 0) {
      err(
        `cuckoocode: \`setup\` takes no arguments; got ${args.map((a) => `"${a}"`).join(' ')}. ` +
          'Use `cuckoocode config <name>` to edit a specific profile.',
      )
      return 2
    }
    return openWizard({ deps, openUi, name: null, mode: 'setup', err, out })
  }

  if (head === undefined) return openWizard({ deps, openUi, name: null, err, out })
  if (head === 'help' || head === '--help' || head === '-h') {
    out(USAGE)
    return 0
  }

  switch (head) {
    case 'list':
      return listProfiles({ deps, out })
    case 'default':
      return setDefault({ deps, name: rest[0], out, err })
    case 'rm':
      return removeProfile({ deps, name: rest[0], out, err })
    case 'use':
    case 'bind':
      return useCommand({ deps, head, args: rest, out, err })
    case 'unbind':
      return unbindCommand({ deps, path: rest[0], out, err })
    case 'bindings':
      return listBindings({ deps, prune: rest.includes('--prune'), out, err })
    case 'doctor':
      return doctorCommand({ deps, args: rest, out, err })
    default:
      break
  }

  // Not a subcommand, so it names a profile to create or edit.
  if (head.startsWith('-')) {
    err(`cuckoocode: unknown option "${head}". Try \`cuckoocode config help\`.`)
    return 2
  }
  if (rest.length > 0) {
    err(
      `cuckoocode: \`config ${head}\` takes no further arguments; ` +
        `got ${rest.map((a) => `"${a}"`).join(' ')}. Try \`cuckoocode config help\`.`,
    )
    return 2
  }
  return openWizard({ deps, openUi, name: head, err, out })
}

// ---------------------------------------------------------------------------

async function openWizard({
  deps,
  openUi,
  name,
  mode = 'config',
  err,
  out,
}: {
  deps: LaunchDeps
  openUi: OpenUi
  name: string | null
  mode?: WizardMode
  err: Emit
  out: Emit
}): Promise<number> {
  const loaded = deps.store.load()
  for (const w of loaded.warnings ?? []) err(`cuckoocode: ${w}`)

  if (loaded.readOnly) {
    err('cuckoocode: config.json is newer than this cuckoocode understands; refusing to edit it.')
    return 2
  }

  if (name !== null) {
    const exists = Object.prototype.hasOwnProperty.call(loaded.state.profiles ?? {}, name)
    if (!exists) {
      // Validation applies at CREATION only. A hand-edited file keeps working.
      const verdict = validateProfileName(name)
      if (!verdict.ok) {
        err(`cuckoocode: ${verdict.reason}`)
        return 2
      }
    }
  }

  const saved = await openUi(mode, { state: loaded.state, profileName: name })
  if (saved) out(`\n  saved to ${deps.store.path()}\n`)
  return 0
}

function listProfiles({ deps, out }: { deps: LaunchDeps; out: Emit }): number {
  const { state } = deps.store.load()
  const names = Object.keys(state.profiles ?? {})
  if (names.length === 0) {
    out('No profiles yet. Run `cuckoocode config` to make one.')
    return 0
  }

  // Annotated: a bare `new Map()` infers `Map<any, any>`, which typechecks but
  // silently opts this loop out of every check the rest of the file gets.
  const bindingsByProfile = new Map<string, string[]>()
  for (const b of bindingEntries(state)) {
    if (!b.name) continue
    if (!bindingsByProfile.has(b.name)) bindingsByProfile.set(b.name, [])
    // `!` — the `has`/`set` pair on the line above guarantees the entry. Same
    // provably-redundant lookup the catalog registry's memoization has.
    bindingsByProfile.get(b.name)!.push(b.key)
  }

  for (const name of names.sort()) {
    // `!` is noUncheckedIndexedAccess meeting Object.keys: `names` was read off
    // this very object three lines up, so every key is present. Asserted once
    // at the binding rather than at each of the seven reads below.
    const p = state.profiles[name]!
    const isDefault = state.defaultProfile === name
    const provider = deps.registry.byId(p.provider)
    const flags = [
      isDefault ? 'default' : null,
      provider ? null : 'unknown provider',
      // The subcommand always wins positionally, so such a profile can only be
      // selected with --cc-profile.
      SUBCOMMANDS.includes(name) ? 'shadowed' : null,
    ].filter(Boolean)

    out(`${isDefault ? '*' : ' '} ${name}${flags.length ? `  (${flags.join(', ')})` : ''}`)
    out(`    provider   ${p.provider}${provider ? '' : '  — not in this build'}`)
    if (p.baseUrl) out(`    baseUrl    ${p.baseUrl}`)
    // Presence and ORIGIN only. Never a prefix, never a suffix, never a length:
    // a masked key is still a fingerprint, and this output gets pasted into bug
    // reports.
    out(`    key        ${credentialOrigin(p)}`)
    // What will actually be sent, not just what is stored: an absent tier
    // inherits the provider default at launch, and printing "—" for something
    // that resolves to a real model is how a config gets debugged twice.
    const models = TIERS.map((t) => {
      const pinned = p.models?.[t]
      if (pinned) return `${t}=${pinned}`
      const inherited = provider?.defaultModels?.[t]
      return inherited ? `${t}=${inherited}*` : `${t}=—`
    }).join('  ')
    out(`    models     ${models}`)
    if (TIERS.some((t) => !p.models?.[t] && provider?.defaultModels?.[t])) {
      out('               * inherited from the provider preset')
    }
    if (p.skipPermissions) out('    perms      --dangerously-skip-permissions by default')
    for (const key of bindingsByProfile.get(name) ?? []) out(`    bound      ${key}`)
  }

  if (!state.defaultProfile && names.length > 1) {
    out('')
    out('No default profile. Set one with `cuckoocode config default <name>`.')
  }
  return 0
}

function credentialOrigin(profile: Profile): string {
  if (profile.apiKeyFromEnv) return `read from $${profile.apiKeyFromEnv} at launch`
  if (profile.apiKey) return 'stored in config.json (0600)'
  return 'none'
}

type NamedProfileOptions = {
  deps: LaunchDeps
  /** `rest[0]`, so genuinely absent when the user typed no name */
  name: string | undefined
  out: Emit
  err: Emit
}

function setDefault({ deps, name, out, err }: NamedProfileOptions): number {
  const { state, readOnly } = deps.store.load()
  if (readOnly) return refuseWrite(err)
  if (!name) {
    err('cuckoocode: `config default` needs a profile name.')
    return 2
  }
  if (!Object.prototype.hasOwnProperty.call(state.profiles ?? {}, name)) {
    err(`cuckoocode: "${name}" is not a profile. Known: ${Object.keys(state.profiles ?? {}).join(', ') || 'none'}.`)
    return 2
  }
  deps.store.save({ ...state, defaultProfile: name })
  out(`default profile is now "${name}"`)
  return 0
}

function removeProfile({ deps, name, out, err }: NamedProfileOptions): number {
  const { state, readOnly } = deps.store.load()
  if (readOnly) return refuseWrite(err)
  if (!name) {
    err('cuckoocode: `config rm` needs a profile name.')
    return 2
  }
  if (!Object.prototype.hasOwnProperty.call(state.profiles ?? {}, name)) {
    err(`cuckoocode: "${name}" is not a profile.`)
    return 2
  }

  const profiles = { ...state.profiles }
  delete profiles[name]
  // A binding to a deleted profile is inert but confusing; take them with it.
  const pruned = pruneBindingsForProfile({ ...state, profiles }, name)
  const next = pruned.state
  if (next.defaultProfile === name) {
    const remaining = Object.keys(profiles)
    // Exactly one left has an unambiguous answer; more than one does not, and
    // guessing picks an account to bill.
    // `remaining[0]!`: guarded on length === 1 the line above.
    next.defaultProfile = remaining.length === 1 ? remaining[0]! : null
  }

  deps.store.save(next)
  out(`removed profile "${name}"`)
  for (const key of pruned.removed) out(`  also removed the binding for ${key}`)
  if (!next.defaultProfile && Object.keys(profiles).length > 1) {
    out('  no default profile now — set one with `cuckoocode config default <name>`')
  }
  return 0
}

function useCommand({
  deps,
  head,
  args,
  out,
  err,
}: {
  deps: LaunchDeps
  /** which spelling the user typed; only the error message differs */
  head: 'use' | 'bind'
  args: string[]
  out: Emit
  err: Emit
}): number {
  const loaded = deps.store.load()
  const cwd = safeCwd(deps.proc, err)
  if (cwd === null) return 2

  const wantsShow = args.includes('--show') || (head === 'use' && args.length === 0)
  const wantsClear = args.includes('--clear')

  if (wantsClear) return unbindCommand({ deps, path: cwd, out, err })
  if (wantsShow) return showBinding({ deps, loaded, cwd, out })

  const name = args.find((a) => !a.startsWith('-'))
  if (!name) {
    err(`cuckoocode: \`config ${head}\` needs a profile name, or --show / --clear.`)
    return 2
  }
  if (loaded.readOnly) return refuseWrite(err)

  const result = bindPath(loaded.state, cwd, name)
  if (!result.ok) {
    err(`cuckoocode: ${result.reason}`)
    return 2
  }
  deps.store.save(result.state)
  out(
    result.replaced && result.replaced !== name
      ? `${result.key} now uses profile "${name}" (was "${result.replaced}")`
      : `${result.key} now uses profile "${name}"`,
  )
  out('Subdirectories inherit this unless they have a binding of their own.')
  return 0
}

/**
 * The point of --show: not "what is bound here" but "why is THIS profile the
 * one running, and which path decided it". A binding that silently fails to
 * apply — because it was made in a symlinked path, or a deeper one wins — is
 * the failure mode worth spending output on.
 */
function showBinding({
  deps,
  loaded,
  cwd,
  out,
}: {
  deps: LaunchDeps
  loaded: LoadResult
  cwd: string
  out: Emit
}): number {
  const state = loaded.state
  const info = explainBinding(cwd, state, process.platform)

  out(`directory   ${info.cwd ?? cwd}`)
  if (info.match) {
    const known = Object.prototype.hasOwnProperty.call(state.profiles ?? {}, info.match.name)
    out(`binding     ${info.match.key}  →  profile "${info.match.name}"${known ? '' : '  (profile no longer exists)'}`)
    out(
      info.match.key === info.cwd
        ? '            bound to this exact directory'
        : '            inherited from the nearest ancestor that has one',
    )
    if (known) {
      // `!` — `known` is a hasOwnProperty check on this exact key, which tsc
      // does not treat as a narrowing but which is a real runtime proof.
      out(`effective   profile "${info.match.name}" (${state.profiles[info.match.name]!.provider})`)
    } else {
      out(`effective   profile "${state.defaultProfile ?? 'none'}" — the binding is dangling, so it is ignored`)
    }
  } else {
    out('binding     none')
    out(
      state.defaultProfile
        ? `effective   profile "${state.defaultProfile}" (default profile)`
        : 'effective   nothing — no binding and no default profile',
    )
  }

  out(`searched    ${info.searched.length} path(s): ${info.searched.join(', ') || '(none)'}`)
  const total = Object.keys(state.bindings ?? {}).length
  out(`stored      ${total} binding(s) in ${deps.store.path()}`)
  return 0
}

function unbindCommand({
  deps,
  path,
  out,
  err,
}: {
  deps: LaunchDeps
  /** explicit path, or undefined to mean "this directory" */
  path: string | undefined
  out: Emit
  err: Emit
}): number {
  const loaded = deps.store.load()
  const target = path ?? safeCwd(deps.proc, err)
  if (target === null) return 2
  if (loaded.readOnly) return refuseWrite(err)

  const result = unbindPath(loaded.state, target)
  if (result.key === null) {
    err(`cuckoocode: "${target}" is not an absolute path.`)
    return 2
  }
  if (result.removed === null) {
    // Deliberately not an error: "there is no binding here" is the state the
    // user asked for. Say which ancestor still applies, though.
    const info = explainBinding(target, loaded.state, process.platform)
    out(`no binding on ${result.key}`)
    if (info.match) {
      out(`  ${info.match.key} still applies here (profile "${info.match.name}")`)
      out('  unbind that path explicitly if you meant to remove it')
    }
    return 0
  }

  deps.store.save(result.state)
  out(`removed the binding on ${result.key} (was profile "${result.removed}")`)
  return 0
}

function listBindings({
  deps,
  prune,
  out,
  err,
}: {
  deps: LaunchDeps
  prune: boolean
  out: Emit
  err: Emit
}): number {
  const loaded = deps.store.load()
  const entries = bindingEntries(loaded.state)
  if (entries.length === 0) {
    out('No directory bindings. Create one with `cuckoocode config use <profile>`.')
    return 0
  }

  if (prune) {
    if (loaded.readOnly) return refuseWrite(err)
    const result = pruneBindings(loaded.state, (key) => existsSync(key))
    if (result.removed.length === 0) {
      out('Nothing to prune.')
    } else {
      deps.store.save(result.state)
      for (const r of result.removed) out(`pruned ${r.key} — ${r.reason}`)
    }
    return 0
  }

  // This is the one command allowed to stat binding paths. Resolution never
  // does, which is why a dead binding costs a launch nothing.
  for (const b of entries) {
    const notes = [
      b.dangling ? 'profile no longer exists' : null,
      existsSync(b.key) ? null : 'directory no longer exists',
    ].filter(Boolean)
    out(`${b.key}  →  ${b.name ?? '(unreadable)'}${notes.length ? `   [${notes.join('; ')}]` : ''}`)
  }
  if (entries.some((b) => b.dangling)) {
    out('')
    out('Dangling bindings are ignored at launch. Remove them with `--prune`.')
  }
  return 0
}

async function doctorCommand({
  deps,
  args,
  out,
  err,
}: {
  deps: LaunchDeps
  args: string[]
  out: Emit
  err: Emit
}): Promise<number> {
  const json = args.includes('--json')
  const offline = args.includes('--offline')
  const fix = args.includes('--fix')

  const timeoutIdx = args.indexOf('--timeout')
  let totalTimeoutMs
  if (timeoutIdx !== -1) {
    const raw = Number(args[timeoutIdx + 1])
    if (!Number.isFinite(raw) || raw <= 0) {
      err('cuckoocode: --timeout needs a positive number of milliseconds.')
      return 2
    }
    totalTimeoutMs = raw
  }

  const known = ['--json', '--offline', '--fix', '--timeout']
  const unknown = args.filter((a, i) => {
    // The token AFTER --timeout is its value, not a flag. Guarding on
    // timeoutIdx !== -1 matters: without it, `timeoutIdx + 1` is 0 when there
    // is no --timeout at all, and an unknown flag in first position gets
    // silently skipped.
    if (timeoutIdx !== -1 && i === timeoutIdx + 1) return false
    return a.startsWith('-') && !known.includes(a)
  })
  if (unknown.length > 0) {
    err(`cuckoocode: unknown option(s) for \`config doctor\`: ${unknown.join(', ')}.`)
    return 2
  }

  const { runDoctor } = await import('./doctor-root.ts')
  const { report, exitCode, render } = await runDoctor({
    deps,
    offline,
    fix,
    ...(totalTimeoutMs ? { totalTimeoutMs } : {}),
  })

  out(json ? JSON.stringify(report, null, 2) : render())
  return exitCode
}

function safeCwd(proc: ProcessPort, err: Emit): string | null {
  try {
    return proc.cwd()
  } catch {
    err('cuckoocode: the current directory no longer exists.')
    return null
  }
}

function refuseWrite(err: Emit): number {
  err(
    'cuckoocode: config.json was written by a newer cuckoocode than this one; ' +
      'refusing to overwrite it. Upgrade cuckoocode.',
  )
  return 2
}
