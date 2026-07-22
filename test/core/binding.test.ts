import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isAbsolutePath,
  minBindingDepth,
  normalizeBindingKey,
  parentOf,
  resolveBinding,
} from '../../src/core/binding.ts'
import type { BindingValue } from '../../src/ports/config-store.ts'
import { makeState } from '../support/fixtures.ts'

// Zero syscalls means zero fixtures on disk: every path below is a string.

test('normalizes keys to an absolute form with no trailing separator', () => {
  assert.equal(normalizeBindingKey('/a/b/'), '/a/b')
  assert.equal(normalizeBindingKey('/a//b/./c'), '/a/b/c')
  assert.equal(normalizeBindingKey('/a/b/../c'), '/a/c')
  assert.equal(normalizeBindingKey('/'), '/')
  assert.equal(normalizeBindingKey('relative'), null)
  assert.equal(normalizeBindingKey(''), null)
})

test('normalizes Windows drive and UNC paths', () => {
  assert.equal(normalizeBindingKey('C:\\Users\\e\\repo\\'), 'C:\\Users\\e\\repo')
  assert.equal(normalizeBindingKey('C:/Users/e'), 'C:\\Users\\e')
  assert.equal(normalizeBindingKey('C:\\'), 'C:\\')
  assert.equal(normalizeBindingKey('\\\\srv\\share\\proj'), '\\\\srv\\share\\proj')
})

test('parentOf terminates at every root', () => {
  assert.equal(parentOf('/a/b'), '/a')
  assert.equal(parentOf('/a'), '/')
  assert.equal(parentOf('/'), null)
  assert.equal(parentOf('C:\\a'), 'C:\\')
  assert.equal(parentOf('C:\\'), null)
  assert.equal(parentOf('\\\\srv\\share\\a'), '\\\\srv\\share')
  assert.equal(parentOf('\\\\srv\\share'), null, 'UNC share is the root')
})

test('isAbsolutePath accepts posix, drive and UNC forms only', () => {
  assert.ok(isAbsolutePath('/a'))
  assert.ok(isAbsolutePath('C:\\a'))
  assert.ok(isAbsolutePath('\\\\srv\\share'))
  assert.ok(!isAbsolutePath('a/b'))
  assert.ok(!isAbsolutePath('./a'))
})

test('no bindings is the fast path and resolves to nothing', () => {
  assert.equal(resolveBinding('/a/b/c', {}), null)
  assert.equal(resolveBinding('/a/b/c', undefined), null)
})

test('finds the nearest ancestor', () => {
  const bindings = { '/work': 'w' }
  assert.deepEqual(resolveBinding('/work/proj/src', bindings), { name: 'w', key: '/work' })
  assert.equal(resolveBinding('/elsewhere', bindings), null)
})

test('the deepest binding wins', () => {
  const bindings = { '/work': 'outer', '/work/proj': 'inner' }
  assert.equal(resolveBinding('/work/proj/src', bindings)!.name, 'inner')
  assert.equal(resolveBinding('/work/other', bindings)!.name, 'outer')
})

test('an exact match on the bound directory itself resolves', () => {
  assert.equal(resolveBinding('/work/proj', { '/work/proj': 'p' })!.name, 'p')
})

test('binding to the filesystem root is legal', () => {
  assert.equal(resolveBinding('/anywhere/at/all', { '/': 'root' })!.name, 'root')
})

test('the walk is capped and degrades to no binding rather than erroring', () => {
  const deep = `/${Array.from({ length: 60 }, (_, i) => `d${i}`).join('/')}`
  const hit = resolveBinding(deep, { '/d0': 'x' }, { bindingWalkDepth: 3 })
  assert.equal(hit, null)
  // Uncapped, the same lookup succeeds.
  assert.equal(resolveBinding(deep, { '/d0': 'x' }, { bindingWalkDepth: 100 })!.name, 'x')
})

test('case folding is used only on darwin/win32, and only after an exact miss', () => {
  const bindings = { '/Work/Proj': 'p' }
  assert.equal(resolveBinding('/work/proj', bindings, {}, 'linux'), null)
  assert.equal(resolveBinding('/work/proj', bindings, {}, 'darwin')!.name, 'p')
  assert.equal(resolveBinding('/Work/Proj', bindings, {}, 'linux')!.name, 'p')
})

test('exact matches win over folded ones on darwin', () => {
  const bindings = { '/Work': 'upper', '/work': 'lower' }
  assert.equal(resolveBinding('/work/x', bindings, {}, 'darwin')!.name, 'lower')
})

test('Windows drive and UNC paths resolve', () => {
  assert.equal(resolveBinding('C:\\Users\\e\\repo\\src', { 'C:\\Users\\e': 'u' }, {}, 'win32')!.name, 'u')
  assert.equal(
    resolveBinding('\\\\srv\\share\\proj\\src', { '\\\\srv\\share\\proj': 'n' }, {}, 'win32')!.name,
    'n',
  )
})

test('the object binding form is accepted on read', () => {
  // Accepted from day one so a later feature needs no schema version bump.
  const hit = resolveBinding('/w/p', { '/w': { profile: 'a', overrides: { baseUrl: 'x' } } })
  assert.equal(hit!.name, 'a')
  assert.deepEqual(hit!.overrides, { baseUrl: 'x' })
})

test('a malformed binding value resolves to nothing rather than throwing', () => {
  // `as BindingValue` on values BindingValue deliberately cannot describe: a
  // number and an object with no `profile`. That is the whole test — a
  // hand-edited config.json can contain either, and neither may throw.
  assert.equal(resolveBinding('/w/p', { '/w': 42 as unknown as BindingValue }), null)
  assert.equal(resolveBinding('/w/p', { '/w': {} as unknown as BindingValue }), null)
})

test('minBindingDepth bounds the walk', () => {
  assert.equal(minBindingDepth({ '/a/b/c': 'x', '/a': 'y' }), 1)
  assert.equal(minBindingDepth({}), null)
})

// Binding management. Still zero syscalls: `pruneBindings` takes existence as
// an injected predicate, because resolution must never stat anything and this
// is the only code allowed to.

import {
  ancestorsOf,
  bindPath,
  bindingEntries,
  explainBinding,
  pruneBindings,
  pruneBindingsForProfile,
  unbindPath,
} from '../../src/core/binding.ts'

const state = () =>
  makeState({
    profiles: { z: { provider: 'zai' }, or: { provider: 'openrouter' } },
    defaultProfile: 'z',
    bindings: { '/work/a': 'or', '/work/a/b/c': 'z', '/gone': 'deleted' },
    settings: {},
  })

test('binding a path normalizes the key and reports what it replaced', () => {
  const r = bindPath(state(), '/work/a/', 'z')
  assert.ok(r.ok)
  assert.equal(r.key, '/work/a')
  assert.equal(r.replaced, 'or')
  assert.equal(r.state.bindings['/work/a'], 'z')
  // Pure: the input is untouched.
  assert.equal(state().bindings['/work/a'], 'or')
})

test('binding refuses an unknown profile or a relative path', () => {
  type Refused = Extract<ReturnType<typeof bindPath>, { ok: false }>
  assert.match((bindPath(state(), '/work/a', 'nope') as Refused).reason, /not a profile/)
  assert.match((bindPath(state(), 'relative', 'z') as Refused).reason, /not an absolute path/)
})

test('unbinding removes only the exact path, never an ancestor', () => {
  // Unbinding a directory you merely sit inside would delete a binding you did
  // not name.
  const r = unbindPath(state(), '/work/a/b/c/d')
  assert.equal(r.removed, null, 'a descendant must not remove the ancestor binding')
  assert.ok(r.state.bindings['/work/a/b/c'])

  const exact = unbindPath(state(), '/work/a/b/c')
  assert.equal(exact.removed, 'z')
  assert.equal(exact.state.bindings['/work/a/b/c'], undefined)
  assert.equal(exact.state.bindings['/work/a'], 'or', 'siblings survive')
})

test('deleting a profile takes its bindings with it', () => {
  const r = pruneBindingsForProfile(state(), 'or')
  assert.deepEqual(r.removed, ['/work/a'])
  assert.equal(r.state.bindings['/work/a'], undefined)
  assert.equal(r.state.bindings['/work/a/b/c'], 'z')
})

test('bindingEntries flags a binding whose profile is gone', () => {
  const entries = bindingEntries(state())
  assert.deepEqual(entries.map((e) => e.key), ['/gone', '/work/a', '/work/a/b/c'])
  assert.equal(entries.find((e) => e.key === '/gone')!.dangling, true)
  assert.equal(entries.find((e) => e.key === '/work/a')!.dangling, false)
})

test('prune drops dead directories and dangling profiles, and nothing else', () => {
  const alive = (key: string) => key !== '/work/a/b/c'
  const r = pruneBindings(state(), alive)
  assert.deepEqual(r.removed.map((x) => x.key).sort(), ['/gone', '/work/a/b/c'])
  assert.match(r.removed.find((x) => x.key === '/gone')!.reason, /profile/)
  assert.match(r.removed.find((x) => x.key === '/work/a/b/c')!.reason, /directory/)
  assert.deepEqual(Object.keys(r.state.bindings), ['/work/a'])
})

test('ancestorsOf lists exactly the paths the walk probes, deepest first', () => {
  const paths = ancestorsOf('/work/a/b/c/d', state().bindings, {})
  assert.equal(paths[0], '/work/a/b/c/d')
  assert.ok(paths.includes('/work/a'))
  // Bounded below by the SHALLOWEST binding key, which here is /gone at depth
  // 1 — so the walk stops at depth 1 and never reaches '/'. Nothing shallower
  // than the shallowest key can possibly match.
  assert.equal(paths.at(-1), '/work')
  assert.ok(!paths.includes('/'))

  // With only deep keys, the walk is correspondingly shorter.
  const shallow = ancestorsOf('/work/a/b/c/d', { '/work/a/b/c': 'z' }, {})
  assert.deepEqual(shallow, ['/work/a/b/c/d', '/work/a/b/c'])
})

test('ancestorsOf reports no walk at all when nothing is bound', () => {
  // resolveBinding returns on one property check; --show must not claim to have
  // searched work that never happened.
  assert.deepEqual(ancestorsOf('/deep/nested/path', {}, {}), [])
})

test('explainBinding says which key won and whether it was exact', () => {
  const exact = explainBinding('/work/a', state())
  assert.equal(exact.match!.key, '/work/a')
  assert.equal(exact.match!.name, 'or')
  assert.equal(exact.cwd, '/work/a')

  const inherited = explainBinding('/work/a/b', state())
  assert.equal(inherited.match!.key, '/work/a', 'nearest ancestor')
  assert.notEqual(inherited.match!.key, inherited.cwd)

  // Deepest wins, not first-registered.
  assert.equal(explainBinding('/work/a/b/c/d', state()).match!.key, '/work/a/b/c')
})

test('explainBinding reports a dangling match rather than hiding it', () => {
  const info = explainBinding('/gone/here', state())
  assert.equal(info.match!.name, 'deleted')
  assert.equal(info.dangling, true)
  assert.equal(info.defaultProfile, 'z', 'what the launch actually falls back to')
})

test('explainBinding on an unbound directory names the fallback', () => {
  const info = explainBinding('/elsewhere', state())
  assert.equal(info.match, null)
  assert.equal(info.defaultProfile, 'z')
})
