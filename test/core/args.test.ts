import test from 'node:test'
import assert from 'node:assert/strict'
import { parseArgv } from '../../src/core/args.ts'
// buildArgs + the skip flag are Claude-Code-specific and now live in the adapter.
import { SKIP_FLAG, buildArgs } from '../../src/adapters/agents/claude-code/index.ts'

test('everything that is not reserved forwards to claude verbatim', () => {
  const r = parseArgv(['--resume', '-p', 'hello world', '--model', 'opus'])
  assert.deepEqual(r.passthrough, ['--resume', '-p', 'hello world', '--model', 'opus'])
  assert.equal(r.command, null)
  assert.equal(r.skipOverride, null)
})

test('the reserved namespace is exactly config|setup|--safe|--yolo|--', () => {
  assert.equal(parseArgv(['config']).command, 'config')
  assert.equal(parseArgv(['setup']).command, 'setup')
  assert.equal(parseArgv(['--safe']).skipOverride, false)
  assert.equal(parseArgv(['--yolo']).skipOverride, true)
  // Not in argv[0] position, `config` is just a word for claude.
  assert.equal(parseArgv(['-p', 'config']).command, null)
  assert.deepEqual(parseArgv(['-p', 'config']).passthrough, ['-p', 'config'])
})

test('--safe and --yolo are consumed, not forwarded', () => {
  const r = parseArgv(['--yolo', '--resume'])
  assert.deepEqual(r.passthrough, ['--resume'])
})

test('after a bare -- everything belongs to claude, terminator included', () => {
  const r = parseArgv(['--yolo', '--', '--safe', '--yolo'])
  assert.equal(r.skipOverride, true)
  assert.deepEqual(r.passthrough, ['--', '--safe', '--yolo'])
})

test('config takes its trailing tokens so the CLI can complain about them', () => {
  const r = parseArgv(['config', 'extra'])
  assert.equal(r.command, 'config')
  assert.deepEqual(r.commandArgs, ['extra'])
})

test('buildArgs prepends the skip flag when skipPermissions is set', () => {
  // The --yolo/--safe/profile resolution is buildIntent's job now; buildArgs
  // only decides the flag from the resolved boolean.
  assert.deepEqual(buildArgs(true, ['-p', 'x']), [SKIP_FLAG, '-p', 'x'])
  assert.deepEqual(buildArgs(false, ['-p', 'x']), ['-p', 'x'])
})

test('the flag is never duplicated when the user typed it themselves', () => {
  // Deliberate: the scan does not stop at `--`. If the user typed the flag
  // anywhere at all, a second copy is worse than honouring theirs.
  assert.deepEqual(buildArgs(true, [SKIP_FLAG]), [SKIP_FLAG])
  assert.deepEqual(buildArgs(true, ['--', SKIP_FLAG]), ['--', SKIP_FLAG])
})

test('buildArgs copies rather than aliasing the passthrough array', () => {
  const passthrough = ['-p']
  const out = buildArgs(false, passthrough)
  out.push('mutated')
  assert.deepEqual(passthrough, ['-p'])
})

// --cc-* per-run overrides. The reserved namespace grew by exactly one PREFIX
// in this phase, and these tests pin both halves of that: the prefix is fully
// reserved (an unknown --cc-* is an error, never passthrough), and nothing
// outside it became reserved.

import { CC_FLAGS } from '../../src/core/args.ts'
import { TIERS } from '../../src/core/tiers.ts'
import type { Tier } from '../../src/ports/provider.ts'

test('the reserved namespace grew by the --cc- prefix and nothing else', () => {
  // Anything that merely LOOKS like one of ours still belongs to claude.
  for (const token of ['--cc', '-cc-profile', 'cc-profile', '--ccprofile', '--chrome']) {
    const r = parseArgv([token])
    assert.equal(r.error, null, token)
    assert.deepEqual(r.passthrough, [token], token)
  }
})

test('--cc-* flags never reach claude', () => {
  const r = parseArgv(['--cc-profile', 'work', '--cc-model', 'x', '--resume', '-p', 'hi'])
  assert.equal(r.error, null)
  assert.deepEqual(r.passthrough, ['--resume', '-p', 'hi'])
  assert.ok(!r.passthrough.some((a) => a.startsWith('--cc-')))
  assert.ok(!buildArgs(false, r.passthrough).some((a) => a.startsWith('--cc-')))
})

test('an unknown --cc-* option is a hard error, not a passthrough token', () => {
  // Forwarding it would put a typo into the prompt while the launch silently
  // used the wrong settings.
  const r = parseArgv(['--cc-porfile', 'work'])
  assert.match(r.error!, /unknown option "--cc-porfile"/)
  assert.match(r.error!, /after a bare --/)
})

test('both --cc-flag value and --cc-flag=value are accepted', () => {
  assert.equal(parseArgv(['--cc-profile', 'w']).profileFlag, 'w')
  assert.equal(parseArgv(['--cc-profile=w']).profileFlag, 'w')
  assert.deepEqual(parseArgv(['--cc-env=FOO=BAR']).overrides.env, { FOO: 'BAR' })
})

test('a --cc-* flag with no value, or a flag-shaped one, is rejected', () => {
  assert.match(parseArgv(['--cc-profile']).error!, /needs a value/)
  assert.match(parseArgv(['--cc-profile', '--resume']).error!, /needs a value/)
  assert.match(parseArgv(['--cc-base-url']).error!, /needs a value/)
})

test('--cc-profile twice is an error, not last-wins', () => {
  // Two answers to "which account pays for this" is not settled by argument
  // order.
  assert.match(parseArgv(['--cc-profile', 'a', '--cc-profile', 'b']).error!, /more than once/)
  assert.match(parseArgv(['--cc-provider', 'a', '--cc-provider', 'b']).error!, /more than once/)
  assert.match(parseArgv(['--cc-base-url', 'a', '--cc-base-url', 'b']).error!, /more than once/)
})

test('a bare --cc-model sets all four tiers', () => {
  const r = parseArgv(['--cc-model', 'kimi-k3'])
  const models = r.overrides.models as Partial<Record<Tier, string>>
  for (const t of TIERS) assert.equal(models[t], 'kimi-k3', t)
})

test('--cc-model applies strictly left to right', () => {
  const r = parseArgv(['--cc-model', 'a', '--cc-model', 'haiku=b', '--cc-model', 'opus=c'])
  assert.deepEqual(r.overrides.models, { opus: 'c', sonnet: 'a', haiku: 'b', fable: 'a' })

  // A later bare form RESETS all four rather than merging.
  const reset = parseArgv(['--cc-model', 'haiku=b', '--cc-model', 'z'])
  assert.deepEqual(reset.overrides.models, { opus: 'z', sonnet: 'z', haiku: 'z', fable: 'z' })
})

test('an unknown tier is rejected with the valid list', () => {
  const r = parseArgv(['--cc-model', 'bogus=x'])
  assert.match(r.error!, /not a model tier/)
  for (const t of TIERS) assert.match(r.error!, new RegExp(t))
})

test('a model id containing = keeps everything after the first one', () => {
  const models = parseArgv(['--cc-model', 'opus=vendor/model=v2']).overrides
    .models as Partial<Record<Tier, string>>
  assert.equal(models.opus, 'vendor/model=v2')
})

test('--cc-env takes KEY=VALUE and KEY= means UNSET', () => {
  const r = parseArgv(['--cc-env', 'A=1', '--cc-env', 'B='])
  assert.deepEqual(r.overrides.env, { A: '1', B: '' })
  assert.match(parseArgv(['--cc-env', 'NOEQUALS']).error!, /KEY=VALUE/)
  assert.match(parseArgv(['--cc-env', '=value']).error!, /needs a variable name/)
})

test('--cc-* after a bare -- is forwarded verbatim', () => {
  // The documented escape hatch: claude tolerates a leading --.
  const r = parseArgv(['--', '--cc-profile', 'work'])
  assert.equal(r.error, null)
  assert.deepEqual(r.passthrough, ['--', '--cc-profile', 'work'])
  assert.equal(r.profileFlag, null)
})

test('argv[0] is offered as a profile candidate only when it could be a name', () => {
  assert.equal(parseArgv(['work', '--resume']).positional, 'work')
  // A profile name can never start with '-', so a flag is rejected before the
  // profile table is consulted at all.
  assert.equal(parseArgv(['--resume', 'work']).positional, null)
  assert.equal(parseArgv(['--']).positional, null)
  assert.equal(parseArgv([]).positional, null)
})

test('the candidate stays in passthrough for the resolver to strip', () => {
  // core/args cannot know which names exist; core/profile decides, and only a
  // MATCH is consumed.
  const r = parseArgv(['work', '--resume'])
  assert.equal(r.passthrough[0], 'work')
})

test('config/setup still shadow everything, including --cc-*', () => {
  const r = parseArgv(['config', 'doctor', '--json'])
  assert.equal(r.command, 'config')
  assert.deepEqual(r.commandArgs, ['doctor', '--json'])
  assert.equal(r.error, null)
})

test('CC_FLAGS is the complete list and every entry carries the prefix', () => {
  for (const f of CC_FLAGS) assert.ok(f.startsWith('--cc-'), f)
  assert.equal(new Set(CC_FLAGS).size, CC_FLAGS.length)
})
