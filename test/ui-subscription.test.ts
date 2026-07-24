// The wizard's SUBSCRIPTION branch, driven end to end with keystrokes.
//
// WHY THIS BRANCH EXISTS. The wizard used to write `apiKey` unconditionally, so
// it could not express a Claude Pro/Max account at all — subscription users were
// pushed onto the raw four-noun path in the web UI, which is the harder one and
// the reason the whole model felt confusing. This is the terminal flow that
// covers both, so there is one way in rather than two.
//
// Written with createElement rather than JSX so it runs under plain `node` with
// no build step of its own — same as ui.test.ts.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import type { Profile } from '../src/ports/config-store.ts'

type UiModule = typeof import('../src/composition/ui-root.ts')

const home = mkdtempSync(join(tmpdir(), 'swisscode-sub-'))
process.env.XDG_CONFIG_HOME = home

const React = (await import('react')).default
const { render } = await import('ink-testing-library')
// @ts-expect-error build artifact, not source — see ui.test.ts.
const { App }: UiModule = await import('../dist/ui.js')

const h = React.createElement
const ENTER = '\r'
const tick = () => new Promise((r) => setTimeout(r, 60))

let result: Profile | null | undefined
let sessionDir: string | null = null
const { lastFrame, stdin } = render(
  h(App, {
    initial: null,
    onResult: (cfg: Profile | null) => {
      result = cfg
    },
    onSessionAccount: (dir: string) => {
      sessionDir = dir
    },
  }),
)

await tick()
assert.match(lastFrame()!, /Which provider/, 'expected the provider step')

// Anthropic is first in the list and is the only sessionCapable provider.
stdin.write(ENTER)
await tick()

// THE NEW STEP. It must appear for Anthropic and must offer the distinction
// that caused the confusion: a subscription kept SEPARATE, versus the login you
// already use. Those look identical from outside and are not.
assert.match(lastFrame()!, /How does this account pay\?/, 'expected the credential-kind step')
assert.match(lastFrame()!, /subscription, kept separate/, 'expected the separate-subscription option')
assert.match(lastFrame()!, /login I already use/, 'expected the existing-login option')
assert.match(lastFrame()!, /API key/, 'expected the key option')

stdin.write(ENTER) // "A Claude subscription, kept separate"
await tick()

// The key step must be SKIPPED entirely — a subscription has no key to type,
// and asking for one is what made this impossible to express before.
assert.doesNotMatch(lastFrame()!, /paste key/, 'the key step must not appear for a subscription')

// models (four tiers, all blank for Anthropic) then permissions
for (let i = 0; i < 4; i++) {
  stdin.write(ENTER)
  await tick()
}
assert.match(lastFrame()!, /dangerously-skip-permissions/, 'expected the permissions step')
stdin.write(ENTER)
await tick()

assert.ok(result, 'wizard should have produced a profile')

const saved = JSON.parse(readFileSync(join(home, 'swisscode', 'config.json'), 'utf8'))
const accountName = result!.accounts[0]!
const account = saved.providerAccounts[accountName]

assert.equal(account.provider, 'anthropic')
// ONE credential or the other, never both — the schema refuses the combination
// because "which one paid for this" must never have a subtle answer.
assert.ok(account.configDir, 'a subscription account must carry a session directory')
assert.equal(account.apiKey, undefined, 'a subscription account must store NO key')
// Same directory `config accounts login` uses, so both routes put it one place.
assert.match(account.configDir, /swisscode[/\\]accounts[/\\]/)

// The profile is what `swisscode <name>` selects, so it has to exist and point
// at this account — an account alone cannot be launched.
assert.ok(saved.profiles[Object.keys(saved.profiles)[0]!].accounts.includes(accountName))

// The handoff note is the only thing that tells the user to run /login, and it
// fires after Ink unmounts so it survives on screen.
assert.equal(sessionDir, account.configDir, 'the handoff note must name the same directory')

// NOTHING WAS WRITTEN INTO THE LOGIN DIRECTORY. swisscode names it; the agent
// creates its own files. This is the line the whole session design sits behind.
let created = true
try {
  readFileSync(join(account.configDir, '.credentials.json'))
} catch {
  created = false
}
assert.equal(created, false, 'swisscode must never write a credential into a session directory')

console.log('ui subscription: all assertions passed')

// The directory is created at 0700 BEFORE the agent runs, not left to it.
// A login is about to live there; `config accounts login` holds the same line.
const { statSync } = await import('node:fs')
assert.equal(
  statSync(account.configDir).mode & 0o777,
  0o700,
  'a directory about to hold a login must be 0700',
)
console.log('ui subscription: directory permissions verified')
