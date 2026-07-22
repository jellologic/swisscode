// The round-robin cursor store.
//
// Everything here is about DEGRADING WELL. The cursor is written after a launch
// has already been decided, so no failure in this adapter may ever propagate —
// the worst it is allowed to do is stop advancing, which the profile banner
// makes visible because it names the account.
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsCursorStore, stateDir } from '../../src/adapters/store/fs-cursor-store.ts'

const fresh = () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'swisscode-cursor-')), 'state')
  return { dir, store: createFsCursorStore({ dir }) }
}

test('an absent cursor reads as null, which starts the rotation', () => {
  const { store } = fresh()
  assert.equal(store.read('anything'), null)
})

test('a cursor round-trips', () => {
  const { store } = fresh()
  store.advance('work', 2)
  assert.equal(store.read('work'), 2)
})

test('cursors for different profiles do not collide', () => {
  const { store } = fresh()
  store.advance('a', 1)
  store.advance('b', 7)
  assert.equal(store.read('a'), 1)
  assert.equal(store.read('b'), 7)
})

test('it lives OUTSIDE the config directory', () => {
  // The launch path writes no config, and a counter that churned on every
  // launch would show up in every config diff pasted into a bug report.
  const dir = stateDir({ HOME: '/home/u' })
  assert.match(dir, /\.local[/\\]state[/\\]swisscode$/)
  assert.doesNotMatch(dir, /\.config/)
  // XDG wins when set.
  assert.equal(stateDir({ XDG_STATE_HOME: '/xdg/state' }), join('/xdg/state', 'swisscode'))
})

test('the file is 0600 in a 0700 directory', () => {
  // It names PROFILES, which are user-chosen and can carry client names — the
  // same leak SECURITY.md flags for binding paths. No credential, but nobody
  // else's business.
  const { dir, store } = fresh()
  store.advance('work', 1)
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  assert.equal(statSync(join(dir, 'cursors.json')).mode & 0o777, 0o600)
})

test('a corrupt file reads as no cursor rather than throwing', () => {
  const { dir, store } = fresh()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'cursors.json'), 'not json at all')
  assert.equal(store.read('work'), null)
  // …and the next write repairs it, because a torn cursor file is worth
  // nothing and overwriting it costs nothing.
  store.advance('work', 3)
  assert.equal(store.read('work'), 3)
})

test('a hand-edited nonsense value restarts the rotation', () => {
  // It indexes an account array, so a negative or fractional value must never
  // reach the caller.
  const { dir, store } = fresh()
  mkdirSync(dir, { recursive: true })
  for (const bad of ['-1', '1.5', '"two"', 'null', '{}']) {
    writeFileSync(join(dir, 'cursors.json'), `{"work": ${bad}}`)
    assert.equal(store.read('work'), null, `${bad} was accepted as a cursor`)
  }
})

test('an unwritable directory stops rotation instead of failing the launch', () => {
  // THE CONTRACT. By the time this runs the launch is already decided; throwing
  // here would trade a working session for a tidy file.
  const parent = mkdtempSync(join(tmpdir(), 'swisscode-cursor-ro-'))
  const dir = join(parent, 'state')
  mkdirSync(dir)
  chmodSync(dir, 0o500)
  const store = createFsCursorStore({ dir })
  try {
    assert.doesNotThrow(() => store.advance('work', 1))
    assert.equal(store.read('work'), null, 'it degrades to no cursor, which means no rotation')
  } finally {
    chmodSync(dir, 0o700)
  }
})

test('the written file is readable JSON, not an opaque blob', () => {
  // Someone debugging a rotation should be able to look.
  const { dir, store } = fresh()
  store.advance('work', 4)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'cursors.json'), 'utf8')), { work: 4 })
})
