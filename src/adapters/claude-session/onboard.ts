// `swisscode config accounts login <name>` — adopt a subscription.
//
// The one-time step that turns "an account I pay for" into "an account
// swisscode can select". It creates a directory, records it, and then HANDS THE
// TERMINAL TO THE AGENT so the official `/login` runs, unmodified, in the
// official client.
//
// SWISSCODE NEVER TOUCHES THE OAUTH FLOW. It does not open a browser, does not
// hold a code, does not see a token. It creates an empty directory and execve's
// the real binary at it. Everything after that is between you and Anthropic —
// which is both the honest architecture and the reason this is a launcher
// rather than a credential manager.

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { describeIdentity, readSessionIdentity } from './identity.ts'
import { validateProfileName } from '../../core/migrate.ts'
import { isDefaultConfigDir } from '../agents/claude-code/env.ts'
import type { ConfigStorePort, ProviderAccount, State } from '../../ports/config-store.ts'
import type { AgentRegistryPort } from '../../ports/agent.ts'
import type { ProcessPort } from '../../ports/process.ts'

type Emit = (line: string) => void

export type LoginOptions = {
  /** account name, as it will appear in config and in `swisscode config accounts` */
  name: string | undefined
  /** `--dir <path>`: adopt an existing directory instead of making one */
  dir?: string | undefined
  /** `--provider <id>`, defaulting to anthropic — the only one with this flow today */
  provider?: string | undefined
  /**
   * `--no-profile`: record the account and stop, leaving it unlaunchable.
   *
   * For the deliberate case — an account you are about to add to an existing
   * multi-account profile by hand — which is the only reason to want the state
   * this command used to leave behind by accident.
   */
  noProfile?: boolean | undefined
  store: ConfigStorePort
  agents: AgentRegistryPort
  proc: ProcessPort
  out: Emit
  err: Emit
}

/**
 * Where swisscode keeps the session directories it makes.
 *
 * Beside `config.json`, under the config directory rather than the state
 * directory: unlike a rotation cursor, a session directory is NOT regenerable.
 * It holds a login. Losing it costs a `/login` per account, and it belongs
 * wherever the user's backups already point.
 */
export function accountsDir(env: Record<string, string | undefined> = process.env): string {
  return join(
    env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'),
    'swisscode',
    'accounts',
  )
}

/**
 * Names that may become a directory.
 *
 * Stricter than the profile-name grammar on purpose: this string is
 * concatenated into a filesystem path, so `..`, separators and leading dots are
 * refused outright rather than sanitised. A rejected name is a typo the user
 * fixes in one second; a sanitised one is a directory somewhere they did not
 * expect.
 */
export function validateAccountName(name: string): { ok: true } | { ok: false; reason: string } {
  if (!name.trim()) return { ok: false, reason: 'an account needs a name.' }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name) || name.includes('..')) {
    return {
      ok: false,
      reason:
        `"${name}" cannot be used as an account name. Use letters, digits, dot, dash or ` +
        'underscore, starting with a letter or digit — the name becomes a directory.',
    }
  }
  return { ok: true }
}

/**
 * What linking an account to a launchable profile did, or why it did not.
 *
 * `profile` is the name you can actually type at `swisscode <name>` afterwards.
 * `null` with a `reason` is a real outcome, not a failure: the account is still
 * recorded, and the reason is what the caller prints instead of a lie.
 */
export type LinkResult = { state: State; profile: string | null; reason: string | null }

/**
 * Make a freshly recorded account LAUNCHABLE.
 *
 * WHY THIS EXISTS. `config accounts login` used to record an account, print
 * "Nothing else to do — this account is ready to use", and stop. That sentence
 * was false: an account is not a thing you can launch, a profile is, and nothing
 * referenced the new account. The first thing anyone did next was type
 * `swisscode <account-name>` and watch the name go to the agent as a prompt.
 *
 * So this mints the same 1:1:1 shape the wizard already produces — an account, a
 * setup and a profile all sharing one name — which is also what the v2->v3
 * migration produces, so there is exactly one arrangement a new install can be
 * in rather than two.
 *
 * It REFUSES rather than improvises in the two cases where guessing would
 * silently change what a launch bills:
 *
 *   - a profile of that name already exists and does not name this account.
 *     Adding the account to it would change who pays for an existing setup.
 *   - the name is not a legal profile name — an account may be called `fix`,
 *     but a PROFILE called `fix` would swallow `swisscode fix the login bug`,
 *     which is the exact hazard COMMON_WORD_GUARD exists to prevent.
 *
 * An existing setup of the same name is REUSED, never overwritten: setups are
 * shareable by design, and clobbering one would silently re-point every profile
 * that references it.
 */
export function linkAccount(state: State, name: string): LinkResult {
  const already = Object.entries(state.profiles ?? {}).find(([, p]) =>
    (p.accounts ?? []).includes(name),
  )
  if (already) return { state, profile: already[0], reason: null }

  const existing = state.profiles?.[name]
  if (existing) {
    return {
      state,
      profile: null,
      reason:
        `a profile called "${name}" already exists and does not use this account — adding it ` +
        'would change who pays for that profile',
    }
  }
  const verdict = validateProfileName(name)
  if (!verdict.ok) {
    return { state, profile: null, reason: `"${name}" cannot be a profile name: ${verdict.reason}` }
  }

  return {
    state: {
      ...state,
      // Reused when it exists — a setup can back several profiles.
      setups: { ...(state.setups ?? {}), [name]: state.setups?.[name] ?? {} },
      profiles: {
        ...(state.profiles ?? {}),
        [name]: { setup: name, accounts: [name], strategy: 'single' },
      },
      // First profile on the machine becomes the default, matching the wizard.
      defaultProfile: state.defaultProfile ?? name,
    },
    profile: name,
    reason: null,
  }
}

/** @returns the process exit code, or does not return at all (execve). */
export function accountLogin({
  name,
  dir,
  provider = 'anthropic',
  noProfile = false,
  store,
  agents,
  proc,
  out,
  err,
}: LoginOptions): number {
  if (name === undefined) {
    err('swisscode: `config accounts login <name>` needs a name, e.g. `personal`.')
    return 2
  }
  const verdict = validateAccountName(name)
  if (!verdict.ok) {
    err(`swisscode: ${verdict.reason}`)
    return 2
  }

  const loaded = store.load()
  if (loaded.readOnly) {
    err('swisscode: the config file is not writable, so a new account cannot be recorded.')
    return 2
  }
  const state = loaded.state
  const existing = state.providerAccounts?.[name]

  // An adopted directory must be absolute: this process execve's away and the
  // agent inherits the cwd, so a relative path would mean something different
  // depending on where it is later launched from.
  const target = dir
    ? isAbsolute(dir)
      ? resolve(dir)
      : resolve(proc.cwd(), dir)
    : join(accountsDir(proc.env()), name)

  // Re-login into an account that already exists is a legitimate thing to want
  // (an expired refresh token, a wrong account picked the first time), so this
  // is not an error — but silently retargeting an existing account at a
  // DIFFERENT directory would abandon a login without saying so.
  if (existing?.configDir && resolve(existing.configDir) !== target) {
    err(
      `swisscode: account "${name}" already uses ${existing.configDir}. Delete it first, or ` +
        'pass `--dir` with that same path to log in again.',
    )
    return 2
  }
  if (existing && !existing.configDir) {
    err(
      `swisscode: account "${name}" already authenticates with an API key. An account uses a ` +
        'key or a subscription login, never both — pick another name.',
    )
    return 2
  }

  try {
    // 0700 because this directory will hold a login. `recursive` also creates
    // the parent `accounts/`, and mode applies to every level it creates.
    mkdirSync(target, { recursive: true, mode: 0o700 })
  } catch (e) {
    err(`swisscode: could not create ${target}: ${(e as { message?: string }).message ?? e}`)
    return 2
  }
  // An ADOPTED directory keeps whatever permissions it has — narrowing someone
  // else's ~/.claude-work under their feet is not this command's business — but
  // a permissive one earns a warning, since a login is about to live in it.
  //
  // NOT for the default directory. Claude Code creates `~/.claude` at 0755
  // itself, adopting it changes nothing about its exposure, and a warning that
  // fires on a stock install for something swisscode neither made nor worsened
  // is noise that teaches people to skip warnings. `config doctor` is where a
  // pre-existing permissions problem belongs.
  try {
    const mode = statSync(target).mode & 0o777
    if (mode & 0o077 && !isDefaultConfigDir(target, proc.env())) {
      err(
        `swisscode: warning — ${target} is readable by other users (mode ${mode.toString(8)}). ` +
          'It is about to hold a login. `chmod 700` it.',
      )
    }
  } catch {
    /* stat failing here is not worth failing a login over */
  }

  const account: ProviderAccount = { provider, configDir: target }
  const recorded: State = {
    ...state,
    providerAccounts: { ...(state.providerAccounts ?? {}), [name]: account },
  }
  // An account on its own cannot be launched — only a profile can — so make one
  // unless the user asked not to. See `linkAccount`.
  const link = noProfile
    ? { state: recorded, profile: null, reason: 'you passed `--no-profile`' }
    : linkAccount(recorded, name)
  try {
    store.save(link.state)
  } catch (e) {
    err(`swisscode: could not record the account: ${(e as { message?: string }).message ?? e}`)
    return 2
  }

  /**
   * The one sentence that has to be true.
   *
   * Printed at every exit below, because the previous version's cheerful
   * "nothing else to do" was the whole bug: it said an account was ready when
   * nothing could launch it.
   */
  const sayHowToLaunch = (): void => {
    if (link.profile) {
      out('')
      out(`Launch it with:  swisscode ${link.profile}`)
    } else {
      out('')
      out(`This account cannot be launched yet — ${link.reason}.`)
      out('An account says who pays; a profile is the thing you launch. Make one with')
      out('  swisscode config <profile-name>')
    }
  }

  const env = proc.env()
  const isDefault = isDefaultConfigDir(target, env)
  const already = readSessionIdentity(target, { env })

  if (isDefault && already) {
    // The common first step: adopt the login you already have. Nothing to do,
    // and nothing to launch — telling someone to `/login` into the account they
    // are already using would be busywork that risks replacing it.
    out(`Account "${name}" adopted your existing login: ${describeIdentity(already)}.`)
    out(`  ${target}  (Claude Code's default directory)`)
    sayHowToLaunch()
    out('')
    out('Add a second subscription with')
    out(`  swisscode config accounts login <other-name>`)
    return 0
  }
  if (already) {
    out(`Account "${name}" already logged in as ${describeIdentity(already)}.`)
    out(`  ${target}`)
    out('Run `/login` inside the session that starts next to switch it to another account.')
  } else if (isDefault) {
    // Naming the default directory when nobody has ever logged in there.
    out(`Account "${name}" recorded, using Claude Code's default directory.`)
  } else {
    out(`Account "${name}" recorded, using ${target}.`)
  }
  sayHowToLaunch()

  // Claude Code is the only agent with this flow — the login being adopted IS a
  // Claude subscription — so this does not consult the setup. Kilo and
  // OpenCode declare `sessionDir: false` for exactly this reason.
  const agent = agents.byId('claude-code')
  if (!agent) {
    err('swisscode: the Claude Code adapter is not in this build, so it cannot be launched.')
    return 2
  }

  let bin: string
  try {
    bin = proc.resolveBinary(agent.binary)
  } catch (e) {
    // The account is already recorded, which is the useful half. Say so, rather
    // than making the user wonder whether anything happened.
    err(`swisscode: ${(e as { message?: string }).message ?? 'the Claude Code binary was not found'}`)
    err(`swisscode: the account was still recorded. Install the CLI, then run \`/login\` with`)
    err(`swisscode:   CLAUDE_CONFIG_DIR=${target} claude`)
    return 2
  }

  out('')
  out('Starting Claude Code in that directory. Run `/login` inside it, then exit.')
  // SAY THIS BEFORE IT HAPPENS, because afterwards there is nobody left to say
  // it — this process execve's away, and the surprise lands inside someone
  // else's UI. A new directory does NOT come up logged out: Claude Code seeds it
  // from the login you already have (measured — a fresh directory held a full
  // identity, and a Keychain item under its hashed service name, within a minute
  // of first use and with no `/login` performed). Exit without switching and you
  // have two names for one subscription. `config accounts` and `config doctor`
  // both catch that afterwards, but not being caught by it is better.
  if (!isDefault) {
    out('')
    out('  NOTE  it will already show a login — a new directory starts out cloned from')
    out('        the account you are using now. `/login` as the OTHER account, or this')
    out('        one ends up a duplicate that shares the same quota.')
  }
  out('')

  // Setting the variable to the default path would send the agent to a
  // DIFFERENT credential than the one it uses when the variable is unset, so a
  // login performed here would not be the login a plain `claude` finds. Same
  // rule as the launch path; see `isDefaultConfigDir`.
  if (isDefault) delete env.CLAUDE_CONFIG_DIR
  else env.CLAUDE_CONFIG_DIR = target
  // The same both-variables rule the launch path enforces, for the same reason:
  // either one present would authenticate the login flow as somebody else and
  // the `/login` would appear to do nothing.
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN

  proc.replace(bin, [bin], env)
  // Reached only on the spawn fallback (Node < 23.11), where `replace` relays
  // the child's exit itself.
  return 0
}

/**
 * `config accounts login` needs to know whether a directory has ever been used,
 * which is a filesystem question the listing also asks. Shared here so both
 * surfaces answer it the same way.
 */
export const dirExists = (p: string): boolean => existsSync(p)
