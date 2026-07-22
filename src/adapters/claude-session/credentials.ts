// Reading the OAuth token a session directory owns.
//
// THE ONE MODULE IN THIS TOOL THAT TOUCHES A CREDENTIAL IT DID NOT PUT THERE,
// and it is deliberately the smallest thing that can work: read, report, never
// refresh and never write. It exists so `usage` selection can ask Anthropic
// how much of each subscription is left — nothing else.
//
// WHAT THIS DOES NOT DO, on purpose:
//
//   - It never REFRESHES an expired token. Refreshing needs Anthropic's own
//     OAuth client id, which is the impersonation line this design stays behind.
//     An expired token is reported as expired; the agent refreshes it itself the
//     next time you run it, which is both correct and free.
//   - It never WRITES. Writing lives in `swap.ts`, alone, so that nothing on
//     this path can damage a login — a property held by construction rather
//     than by care.
//   - It never LOGS the token, and no caller is given a shape that tempts it to.
//
// OFF THE LAUNCH PATH — `test/architecture.test.ts` enforces it. A launch hands
// the directory to the agent and lets the agent read its own credential, which
// is why an ordinary `swisscode` never raises a Keychain prompt.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDefaultConfigDir } from '../agents/claude-code/env.ts'

type ReadableEnv = Record<string, string | undefined>

/**
 * An OAuth credential, as Claude Code stores it.
 *
 * `accessToken` is the only field anything here uses. `refreshToken` is
 * deliberately NOT in this type: nothing in swisscode may refresh, so carrying
 * one around would only create the opportunity.
 */
export type SessionCredential = {
  accessToken: string
  /** epoch ms, when published */
  expiresAt: number | null
  /** e.g. 'max' — Anthropic's own word for the plan behind this token */
  subscriptionType: string | null
  /** where it was found, for diagnosis */
  source: 'keychain' | 'file'
}

export type CredentialResult =
  | { ok: true; credential: SessionCredential; expired: boolean }
  /**
   * `reason` names the fix, and `kind` lets a caller distinguish "log in" from
   * "we could not look" — a Keychain prompt the user dismissed is not the same
   * finding as an account that was never logged into.
   */
  | { ok: false; kind: 'absent' | 'denied' | 'unreadable'; reason: string }

/**
 * The Keychain service name holding a session directory's credential.
 *
 * DERIVED FROM CLAUDE CODE'S OWN RULE, whose shape is:
 *
 *     isDefaultDir = !process.env.CLAUDE_CONFIG_DIR
 *     dirHash      = isDefaultDir ? '' : `-${sha256(configDir).slice(0, 8)}`
 *     service      = `Claude Code-credentials${dirHash}`
 *
 * Two things follow, and both matter more than they look:
 *
 * 1. The branch is on whether the VARIABLE IS SET, not on the path's value —
 *    the same asymmetry `isDefaultConfigDir` exists for. A session lowered as
 *    "unset the variable" must be looked up under the UNHASHED name.
 * 2. The hash is over the string that would be WRITTEN to CLAUDE_CONFIG_DIR.
 *    We control that string — the env lowering writes `account.configDir`
 *    verbatim — so this hashes exactly the same string rather than a
 *    re-normalised spelling of it. Normalising here and not there would produce
 *    a name that is right in every test and wrong on every machine.
 *
 * The unhashed branch is VERIFIED live: the real item on this machine is
 * `Claude Code-credentials`, matching exactly. The hashed branch follows the
 * rule above but cannot be confirmed without performing a real `/login` into a
 * custom directory, so `config doctor` reports what it finds rather than
 * asserting the name is right.
 */
export function keychainService(configDir: string, env: ReadableEnv = process.env): string {
  if (isDefaultConfigDir(configDir, env)) return 'Claude Code-credentials'
  const hash = createHash('sha256').update(configDir).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${hash}`
}

/**
 * Where the credential lives when it is a file rather than a Keychain item.
 *
 * Unlike `.claude.json`, this one has NO asymmetry — it is inside the config
 * directory either way. Worth stating because the neighbouring file does not
 * behave like this, and assuming they match is an easy way to read the wrong
 * account's token.
 */
export function credentialFilePath(configDir: string): string {
  return join(configDir, '.credentials.json')
}

/** Pull the fields we use out of whichever envelope the token arrived in. */
function parseCredential(raw: string, source: 'keychain' | 'file'): SessionCredential | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  // Both stores wrap the token in `claudeAiOauth`; tolerate a bare object too,
  // since the wrapper is not ours and tolerating it costs one line.
  const o = parsed as Record<string, unknown>
  const oauth = (o.claudeAiOauth ?? o) as Record<string, unknown>
  const accessToken = oauth.accessToken
  if (typeof accessToken !== 'string' || accessToken === '') return null
  return {
    accessToken,
    expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
    subscriptionType:
      typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
    source,
  }
}

export type ReadCredentialOptions = {
  env?: ReadableEnv
  /** injected in tests; defaults to /usr/bin/security */
  keychain?: (service: string) => string
  /** injected in tests; defaults to node:fs */
  readFile?: (path: string) => string
  platform?: NodeJS.Platform
  /** injected so expiry is decidable without a clock */
  now?: number
}

/**
 * `/usr/bin/security find-generic-password -s <service> -w`.
 *
 * ABSOLUTE PATH, so a `security` earlier on PATH cannot impersonate it — this
 * command's whole job is handling a secret, and PATH is attacker-influenced on a
 * shared machine.
 *
 * The service name goes in argv, which is fine: it is not a secret and it is
 * already visible in the Keychain. THE TOKEN COMES BACK ON STDOUT and is never
 * placed in argv by anything here.
 */
function readKeychain(service: string): string {
  return execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
    encoding: 'utf8',
    // A Keychain prompt the user never answers must not hang a configuration
    // screen forever. 20s is generous for a click and short enough to recover.
    timeout: 20_000,
    // The token is on stdout; keep the CLI's own chatter off our stderr.
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

/**
 * Read the credential for a session directory.
 *
 * Never throws and never refreshes. On macOS it tries the Keychain, then the
 * file — Claude Code writes the file on platforms without a Keychain, and some
 * macOS setups end up with one too, so trying both is what actually works
 * rather than what the platform table says should.
 */
export function readSessionCredential(
  configDir: string,
  {
    env = process.env,
    keychain = readKeychain,
    readFile = (p) => readFileSync(p, 'utf8'),
    platform = process.platform,
    now = Date.now(),
  }: ReadCredentialOptions = {},
): CredentialResult {
  let denied = false

  if (platform === 'darwin') {
    try {
      const credential = parseCredential(keychain(keychainService(configDir, env)), 'keychain')
      if (credential) {
        return { ok: true, credential, expired: isExpired(credential, now) }
      }
    } catch (e) {
      // Exit 44 is "item not found", which is a normal state for a directory
      // nobody has logged into. Anything else — a dismissed prompt, a locked
      // keychain — is a DIFFERENT finding and must not be reported as
      // "not logged in", which would send the user to fix the wrong thing.
      const status = (e as { status?: number }).status
      denied = status !== 44 && status !== undefined
    }
  }

  try {
    const credential = parseCredential(readFile(credentialFilePath(configDir)), 'file')
    if (credential) return { ok: true, credential, expired: isExpired(credential, now) }
  } catch {
    /* fall through to the verdict below */
  }

  if (denied) {
    return {
      ok: false,
      kind: 'denied',
      reason:
        'the keychain refused to hand over this account\'s token — the prompt was dismissed, ' +
        'or the keychain is locked. Unlock it and try again; nothing is wrong with the account.',
    }
  }
  return {
    ok: false,
    kind: 'absent',
    reason: `no login found for ${configDir}. Run \`swisscode config accounts login\` for it.`,
  }
}

/**
 * Expiry is REPORTED, never acted on.
 *
 * A token past `expiresAt` still identifies the account; it just will not
 * authenticate. Callers say so and move on — the agent refreshes it on its next
 * run, which is the only party entitled to.
 */
function isExpired(credential: SessionCredential, now: number): boolean {
  return credential.expiresAt !== null && credential.expiresAt <= now
}
