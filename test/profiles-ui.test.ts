// Drives the profile-management wizard with synthetic keystrokes.
//
// Deliberately a separate file from ui.test.js: that one guards the FIRST-RUN
// path, which this phase must not change. Multi-profile management is new
// surface and gets its own script rather than complicating the one test that
// proves the original flow still works.
//
// Written with createElement rather than JSX so it runs under plain `node`.
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import type { Profile, State } from '../src/ports/config-store.ts'

/**
 * dist/ui.js is BUILD OUTPUT — see src/cli.ts for the full reasoning. tsc must
 * not resolve it; the contract is stated against the real source instead.
 */
type UiModule = typeof import('../src/composition/ui-root.ts')
type AppProps = Parameters<UiModule['App']>[0]

const home = mkdtempSync(join(tmpdir(), 'cuckoocode-profiles-'))
process.env.XDG_CONFIG_HOME = home

const React = (await import('react')).default
const { render } = await import('ink-testing-library')
// @ts-expect-error build artifact, not source — see UiModule above.
const { App }: UiModule = await import('../dist/ui.js')
const { createFsConfigStore } = await import('../src/adapters/store/fs-config-store.ts')

const h = React.createElement
const DOWN = '[B'
const ENTER = '\r'
const ESC = ''
const tick = () => new Promise((r) => setTimeout(r, 60))

const SECRET = 'zai-secret-value-do-not-print'
const CWD = '/work/proj'

const baseState = (): State => ({
  version: 2,
  profiles: {
    work: {
      provider: 'zai',
      apiKey: SECRET,
      models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2', fable: 'glm-5.2' },
      skipPermissions: true,
    },
    personal: { provider: 'openrouter', apiKey: 'or-secret' },
  },
  defaultProfile: 'work',
  bindings: {},
  settings: {},
})

/** A store that records writes instead of touching the real config. */
function fakeStore(state: State) {
  const saves: State[] = []
  return {
    saves,
    port: {
      load: () => ({ state, corrupt: false, readOnly: false, migrated: false, warnings: [] }),
      save: (s: State) => {
        saves.push(structuredClone(s))
        return join(home, 'cuckoocode', 'config.json')
      },
      path: () => join(home, 'cuckoocode', 'config.json'),
    },
  }
}

function mount(props: Partial<AppProps>) {
  let result: Profile | null | undefined
  let resolved = false
  const app = render(
    h(App, {
      cwd: CWD,
      onResult: (cfg: Profile | null) => {
        result = cfg
        resolved = true
      },
      ...props,
    }),
  )
  return { ...app, result: () => result, done: () => resolved }
}

// ---------------------------------------------------------------------------

{
  // More than one profile and none named: the picker opens.
  const store = fakeStore(baseState())
  const ui = mount({ state: baseState(), store: store.port })
  await tick()

  assert.match(ui.lastFrame()!, /Profiles/, 'expected the profile list')
  assert.match(ui.lastFrame()!, /work/)
  assert.match(ui.lastFrame()!, /personal/)
  assert.match(ui.lastFrame()!, /★/, 'expected the default marker')
  assert.match(ui.lastFrame()!, /\+ new profile/)

  // Presence and origin of a key, never any part of its value.
  assert.doesNotMatch(ui.lastFrame()!, /zai-secret/, 'a key must never render')
  assert.match(ui.lastFrame()!, /key stored/)

  ui.unmount()
  assert.equal(store.saves.length, 0, 'merely browsing must not write')
  console.log('profiles ui: picker lists profiles without leaking keys')
}

{
  // Exactly one profile keeps the pre-profiles behaviour: straight into it.
  const single = baseState()
  delete single.profiles.personal
  const ui = mount({ state: single, store: fakeStore(single).port })
  await tick()
  assert.match(ui.lastFrame()!, /Which provider/, 'one profile must open directly')
  assert.doesNotMatch(ui.lastFrame()!, /\+ new profile/)
  ui.unmount()
  console.log('profiles ui: a single profile opens directly, as before')
}

{
  // `config <name>` opens that profile, whatever the default is.
  const state = baseState()
  const ui = mount({ state, store: fakeStore(state).port, profileName: 'personal' })
  await tick()
  assert.match(ui.lastFrame()!, /profile: personal/)
  assert.match(ui.lastFrame()!, /Which provider/)
  ui.unmount()
  console.log('profiles ui: config <name> opens that profile directly')
}

{
  // Setting the default writes exactly that and nothing else.
  const state = baseState()
  const store = fakeStore(state)
  const ui = mount({ state, store: store.port })
  await tick()
  // The list is sorted, so "personal" is first and "work" (the current
  // default) is second.
  ui.stdin.write(ENTER)
  await tick()
  assert.match(ui.lastFrame()!, /Profile.*personal/s, 'expected the action menu')
  assert.match(ui.lastFrame()!, /make this the default profile/)

  ui.stdin.write(DOWN) // edit -> make default
  await tick()
  ui.stdin.write(ENTER)
  await tick()

  assert.equal(store.saves.length, 1)
  assert.equal(store.saves[0]!.defaultProfile, 'personal')
  assert.deepEqual(
    Object.keys(store.saves[0]!.profiles).sort(),
    ['personal', 'work'],
    'no profile may be touched by a default change',
  )
  assert.equal(store.saves[0]!.profiles.work!.apiKey, SECRET, 'other profiles survive intact')
  ui.unmount()
  console.log('profiles ui: set-default writes only the default')
}

{
  // Binding the current directory from the UI.
  const state = baseState()
  const store = fakeStore(state)
  const ui = mount({ state, store: store.port })
  await tick()
  ui.stdin.write(ENTER) // open "personal" (sorted first)
  await tick()
  const name = ui.lastFrame()!.match(/Profile\s+(\S+)/)?.[1]
  assert.ok(name, 'expected an action menu for a profile')
  assert.match(ui.lastFrame()!, new RegExp(`use "${name}" in this directory`))

  ui.stdin.write(DOWN)
  await tick()
  ui.stdin.write(DOWN)
  await tick()
  ui.stdin.write(ENTER) // bind
  await tick()

  assert.equal(store.saves.length, 1)
  assert.equal(store.saves[0]!.bindings[CWD], name)
  ui.unmount()
  console.log('profiles ui: bind writes a binding for the current directory')
}

{
  // Deleting asks first, and takes the bindings with it.
  const state = baseState()
  state.bindings = { [CWD]: 'personal', '/other': 'work' }
  const store = fakeStore(state)
  const ui = mount({ state, store: store.port })
  await tick()
  ui.stdin.write(ENTER) // "personal"
  await tick()
  for (let i = 0; i < 3; i++) {
    ui.stdin.write(DOWN)
    await tick()
  }
  ui.stdin.write(ENTER) // delete
  await tick()

  assert.match(ui.lastFrame()!, /Delete profile "personal"\?/)
  assert.match(ui.lastFrame()!, /cannot be recovered/)
  assert.match(ui.lastFrame()!, /1 directory binding/)
  assert.equal(store.saves.length, 0, 'nothing is written before confirmation')

  // The safe option is selected first: a stray return keeps the profile.
  ui.stdin.write(ENTER)
  await tick()
  assert.equal(store.saves.length, 0, 'the default answer must be "keep it"')
  assert.match(ui.lastFrame()!, /Profile/, 'back to the action menu')

  // Now confirm for real.
  for (let i = 0; i < 3; i++) {
    ui.stdin.write(DOWN)
    await tick()
  }
  ui.stdin.write(ENTER) // delete again
  await tick()
  ui.stdin.write(DOWN)
  await tick()
  ui.stdin.write(ENTER) // yes
  await tick()

  assert.equal(store.saves.length, 1)
  const saved = store.saves[0]!
  assert.equal(saved.profiles.personal, undefined)
  assert.equal(saved.profiles.work!.apiKey, SECRET, 'the other profile is untouched')
  assert.deepEqual(Object.keys(saved.bindings), ['/other'], 'its bindings went with it')
  assert.equal(saved.defaultProfile, 'work', 'the survivor becomes the default')
  ui.unmount()
  console.log('profiles ui: delete confirms, prunes bindings, keeps the rest')
}

{
  // A new profile is named before anything else, and the name is validated.
  const state = baseState()
  const store = fakeStore(state)
  const ui = mount({ state, store: store.port })
  await tick()
  ui.stdin.write(DOWN)
  await tick()
  ui.stdin.write(DOWN)
  await tick()
  ui.stdin.write(ENTER) // + new profile
  await tick()
  assert.match(ui.lastFrame()!, /Name for the new profile/)

  // A reserved word is refused rather than silently creating an unreachable
  // profile.
  ui.stdin.write('doctor')
  await tick()
  ui.stdin.write(ENTER)
  await tick()
  assert.match(ui.lastFrame()!, /reserved/)
  assert.equal(store.saves.length, 0)

  // A duplicate is refused too.
  for (let i = 0; i < 6; i++) {
    ui.stdin.write('')
    await tick()
  }
  ui.stdin.write('work')
  await tick()
  ui.stdin.write(ENTER)
  await tick()
  assert.match(ui.lastFrame()!, /already exists/)

  // A good name proceeds to a blank provider step.
  for (let i = 0; i < 4; i++) {
    ui.stdin.write('')
    await tick()
  }
  ui.stdin.write('staging')
  await tick()
  ui.stdin.write(ENTER)
  await tick()
  assert.match(ui.lastFrame()!, /profile: staging/)
  assert.match(ui.lastFrame()!, /Which provider/)
  ui.unmount()
  console.log('profiles ui: new-profile names are validated at creation')
}

{
  // A full edit of a named profile lands under that name, not a derived one.
  const state = baseState()
  const store = fakeStore(state)
  const ui = mount({ state, store: store.port, profileName: 'personal' })
  await tick()
  ui.stdin.write(ENTER) // keep openrouter, the provider this profile already uses
  await tick()
  // Straight past the key field without typing: re-editing a profile must not
  // force you to re-paste a credential you may not have anywhere else.
  assert.doesNotMatch(ui.lastFrame()!, /or-secret/, 'the existing key stays masked')
  ui.stdin.write(ENTER)
  await tick()
  // OpenRouter has a catalog, so the model step is a tier list ending in
  // "continue →" rather than four text inputs.
  for (let i = 0; i < 4; i++) {
    ui.stdin.write(DOWN)
    await tick()
  }
  ui.stdin.write(ENTER) // continue →
  await tick()
  ui.stdin.write(ENTER) // permissions: yes
  await tick()

  assert.equal(store.saves.length, 1)
  const saved = store.saves[0]!
  assert.ok(saved.profiles.personal, 'the edited profile keeps its name')
  assert.equal(saved.profiles.personal!.apiKey, 'or-secret', 'the existing key survives an edit')
  assert.ok(saved.profiles.work, 'the other profile survives the write')
  assert.equal(saved.defaultProfile, 'work', 'editing must not steal the default')
  ui.unmount()
  console.log('profiles ui: editing a named profile writes under that name')
}

{
  // esc from the picker cancels cleanly rather than writing anything.
  const state = baseState()
  const store = fakeStore(state)
  const ui = mount({ state, store: store.port })
  await tick()
  ui.stdin.write(ESC)
  await tick()
  assert.equal(store.saves.length, 0)
  assert.equal(ui.result(), null)
  ui.unmount()
  console.log('profiles ui: esc cancels without writing')
}

{
  // Whatever the wizard writes has to survive a real round trip through the
  // store, at the permissions the file demands.
  const store = createFsConfigStore()
  const ui = mount({ state: baseState(), store, profileName: 'personal' })
  await tick()
  ui.stdin.write(ENTER)
  await tick()
  ui.stdin.write(ENTER)
  await tick()
  for (let i = 0; i < 4; i++) {
    ui.stdin.write(DOWN)
    await tick()
  }
  ui.stdin.write(ENTER) // continue →
  await tick()
  ui.stdin.write(ENTER) // permissions
  await tick()

  const path = join(home, 'cuckoocode', 'config.json')
  const saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.version, 2)
  assert.ok(saved.profiles.personal)
  assert.ok(saved.profiles.work, 'the untouched profile round-tripped')
  assert.equal(statSync(path).mode & 0o777, 0o600, 'the file holds API keys')
  assert.equal(statSync(join(home, 'cuckoocode')).mode & 0o777, 0o700)
  ui.unmount()
  console.log('profiles ui: multi-profile state round-trips at 0600 in a 0700 dir')
}

console.log('profiles ui: all assertions passed')
