import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  candidateNames,
  detectRecursion,
  findBinary,
  makeIsExecutable,
  spawnFallback,
} from '../../src/adapters/process/node-process.ts'
import type { SignalHost } from '../../src/adapters/process/node-process.ts'
import type { EnvMap } from '../../src/ports/process.ts'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const never = () => false

test('PATH order wins, and the first executable match is used', () => {
  const found = new Set(['/a/claude', '/b/claude'])
  const { bin } = findBinary({
    pathEnv: '/a:/b',
    isExecutable: (p) => found.has(p),
    isSelf: never,
  })
  assert.equal(bin, '/a/claude')
})

test('swisscode never resolves to itself', () => {
  const r = findBinary({
    pathEnv: '/self:/real',
    isExecutable: () => true,
    isSelf: (p) => p.startsWith('/self/'),
  })
  assert.equal(r.bin, '/real/claude')
  assert.equal(r.skippedSelf, true)
})

test('fallback locations are searched when PATH has nothing', () => {
  const { bin } = findBinary({
    pathEnv: '',
    fallbacks: ['/opt/homebrew/bin/claude'],
    isExecutable: (p) => p === '/opt/homebrew/bin/claude',
    isSelf: never,
  })
  assert.equal(bin, '/opt/homebrew/bin/claude')
})

test('nothing found reports it rather than returning a bogus path', () => {
  const r = findBinary({ pathEnv: '/a', isExecutable: never, isSelf: never })
  assert.equal(r.bin, null)
  assert.equal(r.skippedSelf, false)
})

test('Windows honours PATHEXT so claude.cmd is found', () => {
  // Without this, resolveClaude threw on every Windows box and the spawn
  // fallback that exists for Windows was unreachable code.
  assert.deepEqual(candidateNames('claude', 'win32', '.COM;.EXE;.CMD'), [
    'claude',
    'claude.COM',
    'claude.EXE',
    'claude.CMD',
  ])
  assert.deepEqual(candidateNames('claude', 'linux', '.EXE'), ['claude'])

  const { bin } = findBinary({
    pathEnv: 'C:\\tools',
    platform: 'win32',
    pathExt: '.EXE;.CMD',
    isExecutable: (p) => p === 'C:\\tools\\claude.CMD',
    isSelf: never,
  })
  assert.equal(bin, 'C:\\tools\\claude.CMD')
})

test('PATHEXT defaults are used when the variable is unset', () => {
  const names = candidateNames('claude', 'win32', null)
  assert.ok(names.includes('claude.CMD'))
  assert.ok(names.includes('claude.EXE'))
})

test('the execute-bit check is skipped on Windows', () => {
  // NTFS has no execute bit; Node reports 0o666/0o444, so mode & 0o111 is
  // always 0 there and every candidate would be rejected.
  const dir = mkdtempSync(join(tmpdir(), 'swisscode-exec-'))
  const file = join(dir, 'claude')
  writeFileSync(file, '#!/bin/sh\n')
  chmodSync(file, 0o644)

  assert.equal(makeIsExecutable('linux')(file), false)
  assert.equal(makeIsExecutable('win32')(file), true)

  chmodSync(file, 0o755)
  assert.equal(makeIsExecutable('linux')(file), true)
  assert.equal(makeIsExecutable('linux')(dir), false, 'a directory is not a binary')
  assert.equal(makeIsExecutable('linux')(join(dir, 'nope')), false)
})

test('the recursion guard reads the marker the child env always carried', () => {
  // A shell shim running `exec swisscode "$@"` defeats a realpath check, and
  // the result is an infinite chain of execve calls that presents as a hang.
  assert.equal(detectRecursion({ SWISSCODE: '1' }), true)
  assert.equal(detectRecursion({}), false)
  assert.equal(detectRecursion(undefined), false)
})

/**
 * Stands in for `process` so the exit relay can be observed.
 *
 * An EventEmitter that also satisfies SignalHost — the test needs both halves:
 * `listenerCount` to prove the no-op SIGTERM handler was removed, and the
 * SignalHost surface because that is what spawnFallback drives. The single
 * assertion at construction is what lets the four assignments below be checked
 * against SignalHost rather than being untyped expandos.
 */
type FakeHost = EventEmitter &
  SignalHost & { exits: number[]; kills: [number, NodeJS.Signals | number][] }

/** Stands in for `process` so the exit relay can be observed. */
function fakeHost(): FakeHost {
  const host = new EventEmitter() as FakeHost
  host.pid = 4242
  host.exits = []
  host.kills = []
  host.exit = (code: number) => host.exits.push(code)
  host.kill = (pid: number, signal: NodeJS.Signals | number) => host.kills.push([pid, signal])
  return host
}

test('the spawn fallback relays a normal exit code', async () => {
  const host = fakeHost()
  spawnFallback(process.execPath, ['-e', 'process.exit(3)'], process.env as EnvMap, host)
  await new Promise((r) => setTimeout(r, 400))
  assert.deepEqual(host.exits, [3])
})

test('the spawn fallback re-raises a signal instead of reporting exit 0', async () => {
  // Its own no-op SIGINT/SIGTERM handlers made process.kill(self, signal)
  // inert, so a signal-killed claude reported success to the shell. Every Node
  // 22 user takes this path, because execve needs 23.11+.
  const host = fakeHost()
  spawnFallback(
    process.execPath,
    ['-e', "process.kill(process.pid, 'SIGTERM')"],
    process.env as EnvMap,
    host,
  )
  await new Promise((r) => setTimeout(r, 500))
  assert.deepEqual(host.exits, [], 'must not report a clean exit')
  assert.deepEqual(host.kills, [[4242, 'SIGTERM']])
  assert.equal(host.listenerCount('SIGTERM'), 0, 'the no-op handler must be removed first')
})

test('a missing binary reports 127 rather than throwing', async () => {
  const host = fakeHost()
  spawnFallback('/nonexistent/claude-binary', [], process.env as EnvMap, host)
  await new Promise((r) => setTimeout(r, 300))
  assert.deepEqual(host.exits, [127])
})
