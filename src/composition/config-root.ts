// Composition root for everything under `swisscode config`.
//
// LAZY, like the UI bundle and the doctor: reached only through a dynamic
// import in src/cli.ts, so none of this is in the launch path's static closure.
//
// WHY EVERY SUBCOMMAND LIVES UNDER `config`
//
// The reserved namespace is `config | setup | --safe | --yolo | --` plus, as of
// this phase, the `--cc-` flag prefix. That is the whole list and it does not
// grow again. `swisscode use …` and `swisscode doctor` would each claim a
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
import { resolveProfileRefs } from '../core/resolve.ts'
import { TIERS } from '../core/tiers.ts'
import { DEFAULT_AGENT_ID } from '../adapters/agents/registry.ts'
import { withCustomProviders } from '../adapters/providers/composite.ts'
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
 * A CALLBACK, injected by src/cli.ts, rather than an import — and the type is
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
  'list', 'default', 'agent', 'rm', 'use', 'bind', 'unbind', 'bindings', 'doctor', 'help',
  'accounts',
  'agents',
])

const USAGE = `swisscode config — manage profiles and directory bindings

  swisscode config                    edit the active profile, or pick one
  swisscode config <name>             create or edit a named profile
  swisscode config list               every profile, with its provider and models
  swisscode config default <name>     set the profile used when nothing else applies
  swisscode config rm <name>          delete a profile and any bindings to it

  swisscode config accounts           provider accounts, and which profiles use each
  swisscode config agents             agent profiles, and which profiles use each

  swisscode config agent              list agents and which profile uses each
  swisscode config agent <name>       show which coding CLI <name> launches
  swisscode config agent <name> <id>  set the coding CLI (claude-code|kilo|opencode)

  swisscode config use <name>         bind the current directory to <name>
  swisscode config use --show         explain which profile applies here, and why
  swisscode config use --clear        remove this directory's binding
  swisscode config bind|unbind        aliases for use / use --clear
  swisscode config bindings [--prune] list bindings; --prune drops dead ones

  swisscode config web [--port <n>]   configure swisscode from a browser
                 [--no-open]

  swisscode config doctor [--json]    check binary, endpoint, credential, models,
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
  deps: baseDeps,
  openUi,
  out = console.log,
  err = console.error,
}: RunConfigCommandOptions): Promise<number> {
  const [head, ...rest] = args

  // Custom providers live in the config file, so every surface that names a
  // provider has to compose the registry after reading it. Done ONCE here and
  // shadowed over `deps`, because doing it per-subcommand is exactly how
  // `config list` came to report "not in this build" for a provider that
  // `config doctor` resolved fine — three call sites, one of them forgotten.
  const deps: LaunchDeps = {
    ...baseDeps,
    registry: withCustomProviders(baseDeps.registry, baseDeps.store.load().state),
  }

  // `setup` is only ever the first-run wizard.
  if (command === 'setup') {
    if (args.length > 0) {
      err(
        `swisscode: \`setup\` takes no arguments; got ${args.map((a) => `"${a}"`).join(' ')}. ` +
          'Use `swisscode config <name>` to edit a specific profile.',
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
    case 'agent':
      return agentCommand({ deps, args: rest, out, err })
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
    case 'web':
      return webCommand({ deps, args: rest, out, err })
    case 'accounts':
      return listAccounts({ deps, out })
    case 'agents':
      return listAgentProfiles({ deps, out })
    default:
      break
  }

  // Not a subcommand, so it names a profile to create or edit.
  if (head.startsWith('-')) {
    err(`swisscode: unknown option "${head}". Try \`swisscode config help\`.`)
    return 2
  }
  if (rest.length > 0) {
    err(
      `swisscode: \`config ${head}\` takes no further arguments; ` +
        `got ${rest.map((a) => `"${a}"`).join(' ')}. Try \`swisscode config help\`.`,
    )
    return 2
  }
  return openWizard({ deps, openUi, name: head, err, out })
}

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
  for (const w of loaded.warnings ?? []) err(`swisscode: ${w}`)

  if (loaded.readOnly) return refuseWrite(err)

  if (name !== null) {
    const exists = Object.prototype.hasOwnProperty.call(loaded.state.profiles ?? {}, name)
    if (!exists) {
      // Validation applies at CREATION only. A hand-edited file keeps working.
      const verdict = validateProfileName(name)
      if (!verdict.ok) {
        err(`swisscode: ${verdict.reason}`)
        return 2
      }
    }
  }

  const saved = await openUi(mode, { state: loaded.state, profileName: name })
  if (saved) out(`\n  saved to ${deps.store.path()}\n`)
  return 0
}

/**
 * `config agent` — view or set which coding CLI a profile launches. Bare lists
 * the agents and every profile's choice; one arg shows a profile's agent; two
 * sets it (the only writing branch).
 */
function agentCommand({
  deps,
  args,
  out,
  err,
}: {
  deps: LaunchDeps
  args: string[]
  out: Emit
  err: Emit
}): number {
  const loaded = deps.store.load()
  const state = loaded.state
  const known = deps.agents.all()
  const [profileName, agentId, ...extra] = args

  if (extra.length > 0) {
    err(
      `swisscode: \`config agent\` takes at most a profile and an agent id; ` +
        `got extra ${extra.map((a) => `"${a}"`).join(' ')}.`,
    )
    return 2
  }

  if (profileName === undefined) {
    out(`Agents: ${known.map((a) => `${a.id} (${a.label})`).join(', ')}`)
    const names = Object.keys(state.profiles ?? {}).sort()
    if (names.length === 0) {
      out('No profiles yet. Run `swisscode config` to make one.')
      return 0
    }
    for (const n of names) {
      const ap = state.agentProfiles?.[state.profiles[n]?.agentProfile ?? '']
      out(`  ${n} → ${ap?.agent ?? DEFAULT_AGENT_ID}`)
    }
    return 0
  }

  const profile = state.profiles?.[profileName]
  if (!profile) {
    const names = Object.keys(state.profiles ?? {})
    err(
      `swisscode: "${profileName}" is not a profile.` +
        (names.length ? ` Known profiles: ${names.join(', ')}.` : ''),
    )
    return 2
  }

  const agentProfileName = profile.agentProfile
  const agentProfile = state.agentProfiles?.[agentProfileName]
  if (agentId === undefined) {
    out(`${profileName} → ${agentProfile?.agent ?? DEFAULT_AGENT_ID}`)
    return 0
  }

  if (!known.some((a) => a.id === agentId)) {
    err(
      `swisscode: "${agentId}" is not a known agent. Valid ids: ${known.map((a) => a.id).join(', ')}.`,
    )
    return 2
  }
  if (loaded.readOnly) return refuseWrite(err)
  if (!agentProfile) {
    err(
      `swisscode: profile "${profileName}" uses agent profile "${agentProfileName}", which ` +
        'does not exist. Run `swisscode config ' + profileName + '` to repair it.',
    )
    return 2
  }
  // Written to the AGENT PROFILE, not the profile: since v3 that is where the
  // coding CLI lives, and an agent profile may back several profiles — which is
  // the point of the split, and worth the reminder in the confirmation line.
  const next: State = {
    ...state,
    agentProfiles: {
      ...state.agentProfiles,
      [agentProfileName]: { ...agentProfile, agent: agentId },
    },
  }
  deps.store.save(next)
  const alsoUsing = Object.entries(state.profiles ?? {})
    .filter(([n, pr]) => n !== profileName && pr.agentProfile === agentProfileName)
    .map(([n]) => n)
  out(
    `${profileName} now launches ${agentId}.` +
      (alsoUsing.length
        ? ` (shared agent profile "${agentProfileName}" — also used by ${alsoUsing.join(', ')})`
        : ''),
  )
  return 0
}

function listProfiles({ deps, out }: { deps: LaunchDeps; out: Emit }): number {
  const { state } = deps.store.load()
  const names = Object.keys(state.profiles ?? {})
  if (names.length === 0) {
    out('No profiles yet. Run `swisscode config` to make one.')
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
    // this very object three lines up, so every key is present.
    const p = state.profiles[name]!
    const isDefault = state.defaultProfile === name

    // Show what the profile RESOLVES to, not what it references. A list of key
    // names would make the reader do the dereference in their head, and the
    // question this command answers is "what happens if I launch this".
    const resolution = resolveProfileRefs(state, name)
    const resolved = resolution.ok ? resolution.resolved : null
    const provider = resolved ? deps.registry.byId(resolved.provider) : null

    const flags = [
      isDefault ? 'default' : null,
      resolution.ok ? null : 'broken',
      resolved && !provider ? 'unknown provider' : null,
      // The subcommand always wins positionally, so such a profile can only be
      // selected with --cc-profile.
      SUBCOMMANDS.includes(name) ? 'shadowed' : null,
    ].filter(Boolean)

    out(`${isDefault ? '*' : ' '} ${name}${flags.length ? `  (${flags.join(', ')})` : ''}`)

    if (!resolution.ok) {
      out(`    ${resolution.reason}`)
      continue
    }
    const r = resolved!

    // The three-way structure, named. Which account pays is the most
    // consequential line here, so it is first and it is never elided.
    const others = (p.accounts ?? []).filter((a) => a !== r.accountName)
    out(
      `    account    ${r.accountName} → ${r.provider}` +
        (provider ? '' : '  — not in this build') +
        (others.length ? `  (+${others.length} more, ${p.strategy ?? 'single'})` : ''),
    )
    out(`    agent      ${r.agentProfileName} → ${r.agent ?? DEFAULT_AGENT_ID}`)
    if (r.baseUrl) out(`    baseUrl    ${r.baseUrl}`)
    // Presence and ORIGIN only. Never a prefix, never a suffix, never a length:
    // a masked key is still a fingerprint, and this output gets pasted into bug
    // reports.
    out(`    key        ${credentialOrigin(r)}`)
    // What will actually be sent, not just what is stored: an absent tier
    // inherits the provider default at launch, and printing "—" for something
    // that resolves to a real model is how a config gets debugged twice.
    const models = TIERS.map((t) => {
      const pinned = r.models?.[t]
      if (pinned) return `${t}=${pinned}`
      const inherited = provider?.defaultModels?.[t]
      return inherited ? `${t}=${inherited}*` : `${t}=—`
    }).join('  ')
    out(`    models     ${models}`)
    if (TIERS.some((t) => !r.models?.[t] && provider?.defaultModels?.[t])) {
      out('               * inherited from the provider preset')
    }
    if (r.skipPermissions) out('    perms      --dangerously-skip-permissions by default')
    for (const key of bindingsByProfile.get(name) ?? []) out(`    bound      ${key}`)
  }

  if (!state.defaultProfile && names.length > 1) {
    out('')
    out('No default profile. Set one with `swisscode config default <name>`.')
  }
  return 0
}

function credentialOrigin(account: { apiKey?: string; apiKeyFromEnv?: string }): string {
  if (account.apiKeyFromEnv) return `read from $${account.apiKeyFromEnv} at launch`
  if (account.apiKey) return 'stored in config.json (0600)'
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
    err('swisscode: `config default` needs a profile name.')
    return 2
  }
  if (!Object.prototype.hasOwnProperty.call(state.profiles ?? {}, name)) {
    err(`swisscode: "${name}" is not a profile. Known: ${Object.keys(state.profiles ?? {}).join(', ') || 'none'}.`)
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
    err('swisscode: `config rm` needs a profile name.')
    return 2
  }
  if (!Object.prototype.hasOwnProperty.call(state.profiles ?? {}, name)) {
    err(`swisscode: "${name}" is not a profile.`)
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
    out('  no default profile now — set one with `swisscode config default <name>`')
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
    err(`swisscode: \`config ${head}\` needs a profile name, or --show / --clear.`)
    return 2
  }
  if (loaded.readOnly) return refuseWrite(err)

  const result = bindPath(loaded.state, cwd, name)
  if (!result.ok) {
    err(`swisscode: ${result.reason}`)
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
      // Report the ACCOUNT the binding resolves to, not a stored provider id:
      // since v3 the profile holds neither, and "which account pays here" is
      // the question `use --show` exists to answer.
      const bound = resolveProfileRefs(state, info.match.name)
      out(
        `effective   profile "${info.match.name}" (` +
          (bound.ok ? `${bound.resolved.accountName} → ${bound.resolved.provider}` : 'broken') +
          ')',
      )
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
    err(`swisscode: "${target}" is not an absolute path.`)
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
    out('No directory bindings. Create one with `swisscode config use <profile>`.')
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
      err('swisscode: --timeout needs a positive number of milliseconds.')
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
    err(`swisscode: unknown option(s) for \`config doctor\`: ${unknown.join(', ')}.`)
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
    err('swisscode: the current directory no longer exists.')
    return null
  }
}

function refuseWrite(err: Emit): number {
  err(
    'swisscode: config.json was written by a newer swisscode than this one; ' +
      'refusing to overwrite it. Upgrade swisscode.',
  )
  return 2
}

/**
 * `swisscode config web` — the browser UI, and the singleton.
 *
 * The server module is imported LAZILY even from here, which is already a lazy
 * module. config-root is reached for every `config` subcommand, including
 * `list` and `doctor`, and none of those should pay for loading an HTTP server.
 *
 * Returns a promise that never settles on success: the server owns the process
 * until Ctrl-C. That is the one place in swisscode where a command deliberately
 * does not exit, and it is why this is opt-in rather than a background daemon.
 */
async function webCommand({
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
  const portFlag = args.indexOf('--port')
  let port = 0
  if (portFlag !== -1) {
    const raw = args[portFlag + 1]
    const parsed = Number(raw)
    if (!raw || !Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
      err(`swisscode: --port needs a number between 0 and 65535; got "${raw ?? ''}".`)
      return 2
    }
    port = parsed
  }

  const { runWeb } = await import('./web-root.ts')
  try {
    const server = await runWeb({
      deps,
      port,
      noOpen: args.includes('--no-open'),
      out,
    })
    // Resolve only when the server closes, so the command holds the terminal.
    await new Promise<void>((resolve) => {
      const stop = () => {
        void server.close().then(resolve)
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    return 0
  } catch (e) {
    err(`swisscode: ${(e as { message?: string }).message ?? 'could not start the web UI'}`)
    return 2
  }
}

/**
 * `swisscode config accounts` — who pays, and who uses them.
 *
 * The reverse index is the point. A profile lists its accounts; nothing else
 * says which profiles an account backs, and that is the question you have
 * before deleting one or rotating a key.
 */
function listAccounts({ deps, out }: { deps: LaunchDeps; out: Emit }): number {
  const { state } = deps.store.load()
  const names = Object.keys(state.providerAccounts ?? {}).sort()
  if (names.length === 0) {
    out('No provider accounts yet. Run `swisscode config` to make one.')
    return 0
  }

  for (const name of names) {
    // `!` — read off Object.keys of this very object.
    const a = state.providerAccounts[name]!
    const provider = deps.registry.byId(a.provider)
    const usedBy = Object.entries(state.profiles ?? {})
      .filter(([, p]) => (p.accounts ?? []).includes(name))
      .map(([n]) => n)

    out(`  ${name}${a.label ? `  (${a.label})` : ''}`)
    out(`    provider   ${a.provider}${provider ? '' : '  — not in this build'}`)
    if (a.baseUrl) out(`    baseUrl    ${a.baseUrl}`)
    // Presence and ORIGIN only, exactly as `config list` does: a masked key is
    // still a fingerprint and this output gets pasted into bug reports.
    out(`    key        ${credentialOrigin(a)}`)
    out(`    used by    ${usedBy.length > 0 ? usedBy.join(', ') : '— nothing'}`)
  }
  return 0
}

/**
 * `swisscode config agents` — what runs, and who uses it.
 *
 * Named for the concept rather than the CLI: `config agent <profile> <id>`
 * already existed and still edits which coding CLI a profile launches. This
 * lists the agent PROFILES, which is the thing that can now be shared.
 */
function listAgentProfiles({ deps, out }: { deps: LaunchDeps; out: Emit }): number {
  const { state } = deps.store.load()
  const names = Object.keys(state.agentProfiles ?? {}).sort()
  if (names.length === 0) {
    out('No agent profiles yet. Run `swisscode config` to make one.')
    return 0
  }

  for (const name of names) {
    const ap = state.agentProfiles[name]!
    const usedBy = Object.entries(state.profiles ?? {})
      .filter(([, p]) => p.agentProfile === name)
      .map(([n]) => n)

    out(`  ${name}${ap.label ? `  (${ap.label})` : ''}`)
    out(`    agent      ${ap.agent ?? DEFAULT_AGENT_ID}`)
    const pinned = TIERS.filter((t) => ap.models?.[t]).map((t) => `${t}=${ap.models![t]}`)
    out(`    models     ${pinned.length > 0 ? pinned.join('  ') : '— provider defaults'}`)
    if (ap.skipPermissions) out('    perms      --dangerously-skip-permissions by default')
    const flags = Object.entries(ap.compat ?? {}).filter(([, on]) => on).map(([f]) => f)
    if (flags.length > 0) out(`    compat     ${flags.join(', ')}`)
    // Shared setups are the reason this concept exists, so say when one is.
    out(
      `    used by    ${usedBy.length > 0 ? usedBy.join(', ') : '— nothing'}` +
        (usedBy.length > 1 ? '  (shared)' : ''),
    )
  }
  return 0
}
