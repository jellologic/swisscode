// Moving one account's login into one session directory's slot.
//
// THIS IS THE ONLY MODULE IN SWISSCODE THAT WRITES A CREDENTIAL. It is separate
// from `credentials.ts` on purpose: that module's header promises it never
// writes, and that promise is worth more than the two imports saved by merging
// them. Nothing on the read path can damage a login, and that stays true by
// construction rather than by care.
//
// WHAT THIS IS. `/login` writes into ONE GLOBAL SLOT, and every running Claude
// Code re-reads it within 30s — so switching accounts for one terminal switches
// all of them, and an artifact created after the switch lands on whichever
// account happened to win. This writes into ONE directory's slot instead.
// Sessions on other directories are untouched. That is the entire difference,
// and it is why this exists.
//
// THE BLOB IS OPAQUE HERE, and that is a security property rather than
// laziness. `SessionCredential` deliberately drops `refreshToken`, because
// nothing in swisscode may refresh — but a swap that moved only the access
// token would hand the target a login that dies at the next refresh, hours
// later, far from the command that caused it. So this reads and writes the
// stored bytes verbatim, never parsing them into a shape that could be logged,
// inspected or accidentally narrowed.
//
// OFF THE LAUNCH PATH, like the rest of adapters/claude-session.

import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { credentialFilePath, keychainService } from './credentials.ts'
import { configFilePath } from './identity.ts'

type ReadableEnv = Record<string, string | undefined>

export type SwapResult =
  | { ok: true; source: 'keychain' | 'file'; wroteIdentity: boolean }
  | { ok: false; reason: string }

/**
 * Read the stored credential blob verbatim.
 *
 * Returns the bytes, not a parsed credential — see the note at the top of this
 * file. Null means "nothing stored here", which is a normal state.
 */
export function readRawCredential(
  configDir: string,
  {
    env = process.env,
    platform = process.platform,
    exec = execFileSync,
    readFile = (p: string) => readFileSync(p, 'utf8'),
  }: {
    env?: ReadableEnv
    platform?: NodeJS.Platform
    exec?: typeof execFileSync
    readFile?: (path: string) => string
  } = {},
): { blob: string; source: 'keychain' | 'file' } | null {
  if (platform === 'darwin') {
    try {
      const blob = exec(
        '/usr/bin/security',
        ['find-generic-password', '-s', keychainService(configDir, env), '-w'],
        { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'ignore'] },
      ) as string
      if (blob.trim()) return { blob: blob.trim(), source: 'keychain' }
    } catch {
      /* not found, or the prompt was dismissed; try the file */
    }
  }
  try {
    const blob = readFile(credentialFilePath(configDir))
    if (blob.trim()) return { blob: blob.trim(), source: 'file' }
  } catch {
    /* nothing stored */
  }
  return null
}

/**
 * Remove a session directory's Keychain item, if it has one.
 *
 * NOT A CLEANUP STEP — it is what makes the file below authoritative. After a
 * swap there must be exactly ONE stored credential for the target directory,
 * and it must be the one just written. Leaving a stale Keychain item next to a
 * fresh file means the answer to "which login does this directory use?" depends
 * on a precedence rule inside someone else's binary, which is precisely the
 * class of ambiguity this whole feature exists to remove.
 *
 * The service name is not a secret, so argv is fine here. Missing item (exit
 * 44) is a normal, successful outcome.
 */
function dropKeychainItem(service: string, exec: typeof execFileSync): void {
  try {
    exec('/usr/bin/security', ['delete-generic-password', '-s', service], {
      timeout: 20_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  } catch {
    /* nothing stored under that name, which is the common case */
  }
}

/**
 * Copy the `oauthAccount` block so the target reports the right identity.
 *
 * WITHOUT THIS THE SWAP IS SILENTLY HALF-DONE: the token would be the new
 * account's while `/status` and every "logged in as" readout still named the
 * old one. A tool whose whole purpose is ending silently-wrong-account
 * confusion cannot ship the same confusion in a new place.
 *
 * Merges into the existing file rather than replacing it — `.claude.json` holds
 * project history, MCP servers and onboarding state that have nothing to do
 * with which account pays, and are not ours to discard.
 */
function copyIdentity(fromDir: string, intoDir: string, env: ReadableEnv): boolean {
  let oauthAccount: unknown
  try {
    const parsed = JSON.parse(readFileSync(configFilePath(fromDir, env), 'utf8')) as {
      oauthAccount?: unknown
    }
    oauthAccount = parsed.oauthAccount
  } catch {
    return false
  }
  if (!oauthAccount || typeof oauthAccount !== 'object') return false

  const target = configFilePath(intoDir, env)
  let existing: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(target, 'utf8'))
    if (parsed && typeof parsed === 'object') existing = parsed as Record<string, unknown>
  } catch {
    /* a directory that has never been used has no file yet; create one */
  }
  try {
    writeFileSync(target, `${JSON.stringify({ ...existing, oauthAccount }, null, 2)}\n`, {
      mode: 0o600,
    })
    return true
  } catch {
    return false
  }
}

export type SwapOptions = {
  env?: ReadableEnv
  platform?: NodeJS.Platform
  exec?: typeof execFileSync
}

/**
 * Write `from`'s login into `into`'s slot.
 *
 * Both arguments are DIRECTORIES, not account names: this module knows about
 * session directories and credentials, and resolving a user's word for an
 * account into a path is the composition root's job.
 */
export function swapCredential(
  fromDir: string,
  intoDir: string,
  { env = process.env, platform = process.platform, exec = execFileSync }: SwapOptions = {},
): SwapResult {
  if (resolve(fromDir) === resolve(intoDir)) {
    return { ok: false, reason: 'the source and target are the same directory — nothing to do' }
  }

  const found = readRawCredential(fromDir, { env, platform, exec })
  if (!found) {
    return {
      ok: false,
      reason:
        `no login is stored for ${fromDir}. Run \`swisscode config accounts login\` for that ` +
        'account and complete `/login` inside it first.',
    }
  }

  // The target directory must exist before anything is written into it — a
  // swap into a path that is not there yet is a reasonable thing to ask for.
  try {
    if (!existsSync(intoDir)) mkdirSync(intoDir, { recursive: true, mode: 0o700 })
  } catch (e) {
    return { ok: false, reason: `could not create ${intoDir}: ${(e as Error).message}` }
  }

  // THE CREDENTIAL IS WRITTEN AS A FILE, ON EVERY PLATFORM INCLUDING MACOS.
  //
  // Not the obvious choice, and it was measured rather than reasoned. Writing
  // the Keychain needs `/usr/bin/security add-generic-password`, and its two
  // ways of taking a secret are both unusable here:
  //
  //   -w <value>   puts the token in argv, where `ps` shows it to every user on
  //                the machine for the life of the process.
  //   -w  (stdin)  prompts, and TRUNCATES AT 128 BYTES. Verified: 500 bytes in,
  //                128 bytes stored, exit 0, no warning. A real credential is
  //                ~3.9 kB, so this silently stores a corrupt fragment — the
  //                first draft of this module shipped exactly that, and the
  //                unit tests passed because a fake `security` has no buffer.
  //
  // The file is neither. It is 0600 in a 0700 directory, it holds the blob
  // whole, and it is a path Claude Code already reads — verified on macOS by
  // pointing the agent at a directory containing only this file, which
  // authenticated, against an empty directory, which printed "Not logged in".
  try {
    const path = credentialFilePath(intoDir)
    writeFileSync(path, `${found.blob}\n`, { mode: 0o600 })
    // Explicit, because `mode` only applies when the file is CREATED. Swapping
    // twice into the same directory would otherwise keep whatever mode the
    // first write happened to land on.
    chmodSync(path, 0o600)
  } catch (e) {
    return { ok: false, reason: `could not write the credential file: ${(e as Error).message}` }
  }

  // Only now, once the new credential is safely on disk: remove the item that
  // would otherwise compete with it. Doing this first would leave a directory
  // with no login at all if the write then failed.
  if (platform === 'darwin') dropKeychainItem(keychainService(intoDir, env), exec)

  return { ok: true, source: found.source, wroteIdentity: copyIdentity(fromDir, intoDir, env) }
}
