// Who a Claude Code session directory is logged in as.
//
// READS NO CREDENTIAL. Everything here comes out of `.claude.json`, which the
// agent writes for its own bookkeeping, so listing every account's identity
// costs one file read apiece and prompts nothing — no Keychain, no network, no
// unlock dialog. That is the whole reason identity is a separate module from
// `credentials.ts`: `config accounts` runs constantly and must stay free.
//
// OFF THE LAUNCH PATH, like the doctor probes and the catalogs.
// `test/architecture.test.ts` holds that line: the launch path resolves a
// session directory and lowers it to an env var without ever opening it, since
// a launch that stats a 200 kB JSON file to print a nicer banner has spent the
// budget this tool exists to protect.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

type ReadableEnv = Record<string, string | undefined>

/**
 * What `.claude.json` is willing to tell us about the logged-in account.
 *
 * Every field optional, and every field VERIFIED PRESENT on a real Max account
 * rather than assumed from the shape of the type. The nulls below are why:
 * this was written against the real file, and the obvious-looking fields turned
 * out to be the empty ones.
 */
export type SessionIdentity = {
  /** stable across email changes; the honest key for "same account?" */
  accountUuid?: string
  email?: string
  displayName?: string
  organizationName?: string
  organizationUuid?: string
  /**
   * A human-readable plan, best effort.
   *
   * MEASURED, NOT ASSUMED. `seatTier` and `userRateLimitTier` — the two fields
   * that sound like the answer — are both `null` on a live Max 20x account.
   * The field that actually carries it is `organizationRateLimitTier`
   * ("default_claude_max_20x"), with `organizationType` ("claude_max") behind
   * it. Preferring the plausible-sounding fields would have shown every user a
   * blank plan, which is the class of bug this codebase measures to avoid.
   */
  plan?: string
  /** true when the account can spend beyond the subscription window */
  extraUsage?: boolean
}

/**
 * Where a session directory keeps its `.claude.json`.
 *
 * THE ASYMMETRY IS REAL AND IT IS THE POINT. Confirmed by running the agent
 * against a throwaway dir:
 *
 *   CLAUDE_CONFIG_DIR unset   ->  ~/.claude.json      (a SIBLING of ~/.claude)
 *   CLAUDE_CONFIG_DIR=<dir>   ->  <dir>/.claude.json  (INSIDE it)
 *
 * There is deliberately NO fallback between the two. If a custom directory has
 * no `.claude.json`, the answer is "never logged in" — reading `~/.claude.json`
 * instead would report the DEFAULT account's identity for a directory that is
 * not it, which is precisely the silently-wrong-account failure this whole
 * feature exists to end.
 */
export function configFilePath(configDir: string, env: ReadableEnv = process.env): string {
  const home = env.HOME || homedir()
  // `resolve` so that `~/.claude`, `~/.claude/`, and a relative path spelling of
  // it all compare equal; a trailing slash must not turn the default directory
  // into a custom one.
  return resolve(configDir) === resolve(join(home, '.claude'))
    ? join(home, '.claude.json')
    : join(resolve(configDir), '.claude.json')
}

/** The shape we pick out of the file. Everything else is the agent's business. */
type OAuthAccount = {
  accountUuid?: unknown
  emailAddress?: unknown
  displayName?: unknown
  organizationName?: unknown
  organizationUuid?: unknown
  organizationType?: unknown
  organizationRateLimitTier?: unknown
  userRateLimitTier?: unknown
  seatTier?: unknown
  hasExtraUsageEnabled?: unknown
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined

/**
 * Turn a rate-limit tier id into something worth printing.
 *
 * Falls through to the raw id rather than to a blank: an unrecognised tier is
 * far more useful shown verbatim than hidden, and a new plan name appearing in
 * output is a smaller failure than a plan silently reading as "—".
 */
function readablePlan(a: OAuthAccount): string | undefined {
  const raw =
    str(a.organizationRateLimitTier) ??
    str(a.userRateLimitTier) ??
    str(a.seatTier) ??
    str(a.organizationType)
  if (!raw) return undefined
  const known: Record<string, string> = {
    default_claude_max_20x: 'Max 20x',
    default_claude_max_5x: 'Max 5x',
    default_claude_pro: 'Pro',
    claude_max: 'Max',
    claude_pro: 'Pro',
  }
  return known[raw] ?? raw
}

export type ReadIdentityOptions = {
  env?: ReadableEnv
  /** injected in tests; defaults to node:fs */
  readFile?: (path: string) => string
}

/**
 * Read the identity of a session directory, or null.
 *
 * Null covers every "we cannot say" case — no directory, no file, unparseable
 * file, or a file with no `oauthAccount` (a real state: a directory the agent
 * has started in but nobody has run `/login` in yet). The caller distinguishes
 * those with `existsSync` if it cares; for display purposes they are all
 * "not logged in", and guessing between them would be inventing detail.
 */
export function readSessionIdentity(
  configDir: string,
  { env = process.env, readFile = (p) => readFileSync(p, 'utf8') }: ReadIdentityOptions = {},
): SessionIdentity | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFile(configFilePath(configDir, env)))
  } catch {
    // Absent, unreadable, or not JSON. All three mean "we cannot say".
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const account = (parsed as { oauthAccount?: unknown }).oauthAccount
  if (!account || typeof account !== 'object') return null

  const a = account as OAuthAccount
  const identity: SessionIdentity = {}
  // Conditional assignment throughout: `exactOptionalPropertyTypes` makes
  // `email: undefined` a different type from an absent `email`, and callers
  // branch on presence.
  const accountUuid = str(a.accountUuid)
  if (accountUuid) identity.accountUuid = accountUuid
  const email = str(a.emailAddress)
  if (email) identity.email = email
  const displayName = str(a.displayName)
  if (displayName) identity.displayName = displayName
  const organizationName = str(a.organizationName)
  if (organizationName) identity.organizationName = organizationName
  const organizationUuid = str(a.organizationUuid)
  if (organizationUuid) identity.organizationUuid = organizationUuid
  const plan = readablePlan(a)
  if (plan) identity.plan = plan
  if (typeof a.hasExtraUsageEnabled === 'boolean') identity.extraUsage = a.hasExtraUsageEnabled

  // An `oauthAccount` with nothing recognisable in it is not an identity.
  return Object.keys(identity).length > 0 ? identity : null
}

/**
 * One line naming the account, for a list.
 *
 * Prefers the email, because that is what the user typed at `/login` and what
 * `/status` shows them. The org name is a poor substitute — on a personal Max
 * account it is literally "<email>'s Organization" — so it appears only when
 * there is no email at all.
 */
export function describeIdentity(identity: SessionIdentity | null): string {
  if (!identity) return 'not logged in'
  const who = identity.email ?? identity.displayName ?? identity.organizationName ?? 'logged in'
  return identity.plan ? `${who}  ·  ${identity.plan}` : who
}

/**
 * Whether a directory looks like one the agent has ever run in.
 *
 * Distinguishes "never used" from "used but logged out", which is the
 * difference between `config accounts login` being the fix and it being a
 * puzzle. Deliberately a path check, not a login check.
 */
export function sessionDirLooksInitialised(
  configDir: string,
  { env = process.env, exists }: { env?: ReadableEnv; exists: (p: string) => boolean },
): boolean {
  const file = configFilePath(configDir, env)
  return exists(file) || exists(dirname(file))
}
