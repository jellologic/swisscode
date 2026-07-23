// The wizard's one-line banner, and the COLOUR it wears.
//
// Every other UI test here asserts text. This one asserts hue, because the
// defect it guards against is a correct sentence in the wrong colour: a
// `bindPath` refusal used to render in the same green as "…is now the default
// profile", so a failure wore the success colour and the only thing telling
// them apart was reading the words. `notice` now carries a tone alongside its
// text, and this is what stops that pairing from being re-broken silently — the
// text would still match either way.
//
// FORCE_COLOR must be set BEFORE anything pulls in Ink: chalk resolves its
// colour support once, at import time, and ink-testing-library's fake stdout is
// not a TTY, so without this the frames come back with no escape codes at all
// and an assertion about colour would pass against every possible bug.
process.env.FORCE_COLOR = '1'

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import type { Profile, State } from '../src/ports/config-store.ts'

/** dist/ui.js is BUILD OUTPUT — see test/ui.test.ts for why tsc must not resolve it. */
type UiModule = typeof import('../src/composition/ui-root.ts')
type AppProps = Parameters<UiModule['App']>[0]

process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'swisscode-notice-'))

const React = (await import('react')).default
const { render } = await import('ink-testing-library')
// @ts-expect-error build artifact, not source — see UiModule above.
const { App }: UiModule = await import('../dist/ui.js')

const h = React.createElement
const DOWN = '[B'
const ENTER = '\r'
const tick = () => new Promise((r) => setTimeout(r, 60))

// SGR 32 is green, 33 is yellow. Ink writes them literally into the frame.
const GREEN = '[32m'
const YELLOW = '[33m'

const state = (): State => ({
  version: 2,
  providerAccounts: { work: { provider: 'zai', apiKey: 'k' }, personal: { provider: 'openrouter', apiKey: 'k' } },
  agentProfiles: { work: {}, personal: {} },
  profiles: {
    work: { agentProfile: 'work', accounts: ['work'] },
    personal: { agentProfile: 'personal', accounts: ['personal'] },
  },
  defaultProfile: 'work',
  bindings: {},
  settings: {},
})

function fakeStore(s: State) {
  const saves: State[] = []
  return {
    saves,
    port: {
      load: () => ({ state: s, corrupt: false, readOnly: false, migrated: false, warnings: [] }),
      save: (next: State) => {
        saves.push(structuredClone(next))
        return '/dev/null'
      },
      path: () => '/dev/null',
    },
  }
}

function mount(props: Partial<AppProps>) {
  return render(h(App, { onResult: (_: Profile | null) => {}, ...props }))
}

// A relative cwd is truthy, so <ProfileActions> offers "use … in this
// directory" — and `bindPath` then refuses it, which is the branch under test.
// The action menu is [edit, make default, bind, delete, back].
const toBind = async (ui: ReturnType<typeof mount>) => {
  ui.stdin.write(ENTER) // open the first profile
  await tick()
  ui.stdin.write(DOWN)
  await tick()
  ui.stdin.write(DOWN)
  await tick()
  ui.stdin.write(ENTER)
  await tick()
}

{
  const store = fakeStore(state())
  const ui = mount({ cwd: 'not/absolute', state: state(), store: store.port })
  await tick()
  // The harness itself has to be proven: if chalk decided against colour, every
  // assertion below would be vacuously true.
  assert.ok(ui.lastFrame()!.includes('['), 'FORCE_COLOR did not take — no escapes in the frame')

  await toBind(ui)
  const frame = ui.lastFrame()!

  assert.match(frame, /is not an absolute path/, 'expected the refusal to be reported')
  assert.equal(store.saves.length, 0, 'a refused binding must not write')
  const refusal = frame.split('\n').find((l) => l.includes('is not an absolute path'))!
  assert.ok(refusal.includes(YELLOW), 'a refused binding must render in the warn colour')
  assert.ok(!refusal.includes(GREEN), 'a refused binding must NOT render in the ok colour')
  ui.unmount()
  console.log('ui notice: a refused binding renders as a warning, not as a success')
}

{
  // The other half of the claim: a notice that IS a success still reads green,
  // so the assertion above is about the tone and not about the tone being gone.
  const store = fakeStore(state())
  const ui = mount({ cwd: '/work/proj', state: state(), store: store.port })
  await tick()
  ui.stdin.write(ENTER) // "personal" sorts first
  await tick()
  ui.stdin.write(DOWN)
  await tick()
  ui.stdin.write(ENTER) // make default
  await tick()

  const frame = ui.lastFrame()!
  assert.match(frame, /is now the default profile/)
  const ok = frame.split('\n').find((l) => l.includes('is now the default profile'))!
  assert.ok(ok.includes(GREEN), 'a completed action must render in the ok colour')
  ui.unmount()
  console.log('ui notice: a completed action still renders as a success')
}

console.log('ui notice: all assertions passed')
