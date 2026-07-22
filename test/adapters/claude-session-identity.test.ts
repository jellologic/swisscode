// Reading who a session directory is logged in as.
//
// Every payload below is shaped after the REAL `~/.claude.json` on a live Max
// 20x account, including the fields that turned out to be null. That is the
// point of the file: the obvious-looking fields are the empty ones.
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  configFilePath,
  describeIdentity,
  readSessionIdentity,
} from '../../src/adapters/claude-session/identity.ts'

const HOME = '/home/u'
const env = { HOME }

/** A reader over an in-memory filesystem, so no test touches a real dot-file. */
const reader = (files: Record<string, string>) => (p: string) => {
  const content = files[p]
  if (content === undefined) throw new Error(`ENOENT: ${p}`)
  return content
}

// Verbatim field names and values from the live account, minus the identifying
// parts. `seatTier` and `userRateLimitTier` really are null on a Max 20x plan.
const REAL_MAX_ACCOUNT = {
  oauthAccount: {
    accountUuid: 'c0bdf393-0000-0000-0000-000000000000',
    emailAddress: 'someone@example.com',
    organizationUuid: '023a272a-0000-0000-0000-000000000000',
    hasExtraUsageEnabled: false,
    billingType: 'stripe_subscription',
    ccOnboardingFlags: {},
    claudeCodeTrialEndsAt: null,
    seatTier: null,
    displayName: 'Someone',
    organizationRole: 'admin',
    workspaceRole: null,
    organizationName: "someone@example.com's Organization",
    organizationType: 'claude_max',
    organizationRateLimitTier: 'default_claude_max_20x',
    userRateLimitTier: null,
  },
}

test('the default directory keeps its config file OUTSIDE itself', () => {
  // ~/.claude.json is a SIBLING of ~/.claude, not a child. Getting this
  // backwards reads nothing and reports every account as logged out.
  assert.equal(configFilePath(join(HOME, '.claude'), env), join(HOME, '.claude.json'))
})

test('a custom directory keeps it INSIDE itself', () => {
  // Confirmed by running the agent against a throwaway dir: it created
  // <dir>/.claude.json and left ~/.claude.json untouched.
  assert.equal(configFilePath('/srv/work', env), '/srv/work/.claude.json')
})

test('a trailing slash does not turn the default directory into a custom one', () => {
  assert.equal(configFilePath(`${HOME}/.claude/`, env), join(HOME, '.claude.json'))
})

test('a missing custom config file does NOT fall back to the home one', () => {
  // The failure this prevents: reporting the DEFAULT account's identity for a
  // directory that is not it — the silently-wrong-account bug, in the surface
  // whose entire job is to tell the accounts apart.
  const files = { [join(HOME, '.claude.json')]: JSON.stringify(REAL_MAX_ACCOUNT) }
  assert.equal(readSessionIdentity('/srv/work', { env, readFile: reader(files) }), null)
})

test('the plan comes from organizationRateLimitTier, because the obvious fields are null', () => {
  const files = { '/srv/work/.claude.json': JSON.stringify(REAL_MAX_ACCOUNT) }
  const id = readSessionIdentity('/srv/work', { env, readFile: reader(files) })
  assert.ok(id)
  assert.equal(id.plan, 'Max 20x')
  assert.equal(id.email, 'someone@example.com')
  assert.equal(id.extraUsage, false)
})

test('an unrecognised tier is shown verbatim rather than hidden', () => {
  // A plan Anthropic ships next year should read as its raw id, not as blank.
  const files = {
    '/srv/work/.claude.json': JSON.stringify({
      oauthAccount: { emailAddress: 'a@b.c', organizationRateLimitTier: 'default_claude_ultra' },
    }),
  }
  const id = readSessionIdentity('/srv/work', { env, readFile: reader(files) })
  assert.equal(id?.plan, 'default_claude_ultra')
})

test('a fresh, never-logged-in directory reads as null', () => {
  // The real shape: the agent creates .claude.json on first run with machineID,
  // userID and projects — and no oauthAccount at all.
  const files = {
    '/srv/work/.claude.json': JSON.stringify({
      firstStartTime: '2026-01-01',
      machineID: 'abc',
      userID: 'def',
      projects: {},
    }),
  }
  assert.equal(readSessionIdentity('/srv/work', { env, readFile: reader(files) }), null)
})

test('a corrupt or unreadable file reads as null rather than throwing', () => {
  for (const content of ['', 'not json', 'null', '[]', '{"oauthAccount": 42}']) {
    const files = { '/srv/work/.claude.json': content }
    assert.equal(
      readSessionIdentity('/srv/work', { env, readFile: reader(files) }),
      null,
      `${JSON.stringify(content)} should read as null`,
    )
  }
  assert.equal(readSessionIdentity('/srv/work', { env, readFile: reader({}) }), null)
})

test('an oauthAccount with nothing recognisable in it is not an identity', () => {
  const files = { '/srv/work/.claude.json': JSON.stringify({ oauthAccount: { foo: 'bar' } }) }
  assert.equal(readSessionIdentity('/srv/work', { env, readFile: reader(files) }), null)
})

test('the description names the account a user would recognise', () => {
  assert.equal(describeIdentity(null), 'not logged in')
  assert.equal(describeIdentity({ email: 'a@b.c', plan: 'Max 20x' }), 'a@b.c  ·  Max 20x')
  // No email: the org name is a poor substitute but better than nothing. On a
  // personal plan it is literally "<email>'s Organization", which is why it is
  // last rather than first.
  assert.equal(describeIdentity({ organizationName: 'Acme' }), 'Acme')
  assert.equal(describeIdentity({}), 'logged in')
})

test('reading an identity never reveals a credential', () => {
  // `.claude.json` holds far more than oauthAccount — project histories, and on
  // some setups auth-adjacent bookkeeping. Only the identity fields come out.
  const files = {
    '/srv/work/.claude.json': JSON.stringify({
      ...REAL_MAX_ACCOUNT,
      projects: { '/secret/client-work': { history: ['do not leak me'] } },
      claudeCodeFirstTokenDate: '2026-01-01',
    }),
  }
  const id = readSessionIdentity('/srv/work', { env, readFile: reader(files) })
  const serialised = JSON.stringify(id)
  assert.doesNotMatch(serialised, /secret|leak|history/)
  assert.deepEqual(Object.keys(id ?? {}).sort(), [
    'accountUuid',
    'displayName',
    'email',
    'extraUsage',
    'organizationName',
    'organizationUuid',
    'plan',
  ])
})
