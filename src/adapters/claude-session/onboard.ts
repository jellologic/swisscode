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

/** @returns the process exit code, or does not return at all (execve). */
export function accountLogin({
  name,
  dir,
  provider = 'anthropic',
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
  try {
    const mode = statSync(target).mode & 0o777
    if (mode & 0o077) {
      err(
        `swisscode: warning — ${target} is readable by other users (mode ${mode.toString(8)}). ` +
          'It is about to hold a login. `chmod 700` it.',
      )
    }
  } catch {
    /* stat failing here is not worth failing a login over */
  }

  const account: ProviderAccount = { provider, configDir: target }
  const next: State = {
    ...state,
    providerAccounts: { ...(state.providerAccounts ?? {}), [name]: account },
  }
  try {
    store.save(next)
  } catch (e) {
    err(`swisscode: could not record the account: ${(e as { message?: string }).message ?? e}`)
    return 2
  }

  const already = readSessionIdentity(target, { env: proc.env() })
  if (already) {
    out(`Account "${name}" already logged in as ${describeIdentity(already)}.`)
    out(`  ${target}`)
    out('Run `/login` inside the session that starts next to switch it to another account.')
  } else {
    out(`Account "${name}" recorded, using ${target}.`)
  }

  // Claude Code is the only agent with this flow — the login being adopted IS a
  // Claude subscription — so this does not consult the agent profile. Kilo and
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
  out('')

  const env = proc.env()
  env.CLAUDE_CONFIG_DIR = target
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
