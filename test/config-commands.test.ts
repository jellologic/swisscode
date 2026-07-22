// The `config *` subcommand surface, driven through the real dispatcher with a
// fake store.
//
// These commands are the ONLY writers in the codebase besides the wizard, so
// most of what is asserted here is about what they write and what they refuse.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runConfigCommand } from '../src/composition/config-root.ts'
import { registry } from '../src/adapters/providers/registry.ts'
import { registry as agents } from '../src/adapters/agents/registry.ts'
import type { OpenUi } from '../src/composition/config-root.ts'
import type { State } from '../src/ports/config-store.ts'
import { makeProfile } from './support/fixtures.ts'

// Annotated `State` rather than left to inference: the tests below read
// profiles these commands CREATE — `.fix`, `.old`, `.third` — which a literal
// type inferred from the two seeded profiles cannot describe.

const STATE = (): State => ({
  version: 2,
  providerAccounts: {
    z: makeProfile({ provider: 'zai', apiKey: 'zai-secret-value' }),
    or: makeProfile({ provider: 'openrouter', apiKeyFromEnv: 'OPENROUTER_KEY' }),
  },
  agentProfiles: {
    z: { models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2', fable: 'glm-5.2' }, skipPermissions: true },
    or: {},
  },
  profiles: {
    z: { agentProfile: 'z', accounts: ['z'] },
    or: { agentProfile: 'or', accounts: ['or'] },
  },
  defaultProfile: 'z',
  bindings: {},
  settings: {},
})

function harness(
  { state = STATE(), cwd = '/work/proj', readOnly = false }:
    { state?: State; cwd?: string; readOnly?: boolean } = {},
) {
  const saves: State[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  let current = state
  const deps = {
    store: {
      load: () => ({ state: current, corrupt: false, readOnly, migrated: false, warnings: [] }),
      save: (s: State) => {
        if (readOnly) throw new Error('read only')
        saves.push(s)
        current = s
        return '/tmp/config.json'
      },
      path: () => '/tmp/config.json',
      modes: () => ({ dir: 0o700, file: 0o600 }),
    },
    registry,
    agents,
    proc: {
      env: () => ({}),
      cwd: () => cwd,
      resolveBinary: () => '/usr/local/bin/claude',
      replace: () => {
        throw new Error('config subcommands must never launch')
      },
    },
  }
  const uiCalls: Record<string, unknown>[] = []
  const run = (
    args: string[],
    openUi: OpenUi = async (mode, opts) => {
      uiCalls.push({ mode, ...opts })
      return null
    },
  ) =>
    runConfigCommand({
      command: 'config',
      args,
      deps,
      openUi,
      out: (l) => stdout.push(String(l)),
      err: (l) => stderr.push(String(l)),
    })

  return {
    run,
    saves,
    uiCalls,
    stdout,
    stderr,
    state: () => current,
    text: () => stdout.join('\n'),
    errText: () => stderr.join('\n'),
  }
}

// The namespace argument: none of these are reserved WORDS. `config` is
// already reserved, and the profile-name grammar forbids creating a profile
// called `list`/`doctor`/`use`, so the second token is never ambiguous.

test('every subcommand lives under `config`, claiming no new bare word', async () => {
  const h = harness()
  for (const sub of ['list', 'bindings', 'help']) {
    assert.equal(await h.run([sub]), 0, sub)
  }
})

test('a name that is not a subcommand opens the wizard for that profile', async () => {
  const h = harness()
  await h.run(['z'])
  assert.deepEqual(h.uiCalls, [{ mode: 'config', state: h.state(), profileName: 'z' }])
})

test('creating a profile named after a subcommand is refused', async () => {
  // `config doctor` dispatches the doctor, so a profile of that name could
  // never be opened — which is why the name is rejected at creation and why
  // the parser's own reserved set can stay at four tokens.
  const h = harness()
  await h.run(['doctor', '--offline'])
  assert.deepEqual(h.uiCalls, [], 'doctor runs the doctor, it does not open a wizard')

  const h2 = harness()
  assert.equal(await h2.run(['login']), 2)
  assert.equal(h2.uiCalls.length, 0)
  assert.match(h2.errText(), /reserved/)
})

test('a common English word needs --force before it can shadow a prompt', async () => {
  const h = harness()
  assert.equal(await h.run(['fix']), 2)
  assert.match(h.errText(), /likely to type as a prompt/)
})

test('an existing profile with an awkward name still opens', async () => {
  // Validation applies at CREATION only; a hand-edited config keeps working.
  const state = STATE()
  state.providerAccounts.fix = { provider: 'zai' }
  state.agentProfiles.fix = {}
  state.profiles.fix = { agentProfile: 'fix', accounts: ['fix'] }
  const h = harness({ state })
  assert.equal(await h.run(['fix']), 0)
  assert.equal(h.uiCalls[0]!.profileName, 'fix')
})

// list

test('config list never prints any part of a key', async () => {
  const h = harness()
  await h.run(['list'])
  const text = h.text()
  assert.ok(!text.includes('zai-secret-value'))
  assert.ok(!text.includes('zai-secret'))
  assert.ok(!text.includes('zai-sec'), 'not even a prefix')
  // Presence and origin instead, which is what someone debugging needs.
  assert.match(text, /stored in config\.json/)
  assert.match(text, /read from \$OPENROUTER_KEY/)
})

test('config list marks the default and shows inherited models honestly', async () => {
  const h = harness()
  await h.run(['list'])
  assert.match(h.text(), /\* z {2}\(default\)/)
  // `or` pins nothing, so the provider preset is what actually runs.
  assert.match(h.text(), /openrouter\/fusion\*/)
  assert.match(h.text(), /inherited from the provider preset/)
})

test('config list flags a profile whose provider this build does not know', async () => {
  const state = STATE()
  // The provider id lives on the ACCOUNT now, so an unknown one is an unknown
  // account provider — the profile itself resolves fine and still lists.
  state.providerAccounts.old = { provider: 'volcengine' }
  state.agentProfiles.old = {}
  state.profiles.old = { agentProfile: 'old', accounts: ['old'] }
  const h = harness({ state })
  await h.run(['list'])
  assert.match(h.text(), /unknown provider/)
})

// default / rm

test('config default switches the default profile', async () => {
  const h = harness()
  assert.equal(await h.run(['default', 'or']), 0)
  assert.equal(h.saves.at(-1)!.defaultProfile, 'or')
})

test('config default refuses an unknown name and lists the real ones', async () => {
  const h = harness()
  assert.equal(await h.run(['default', 'nope']), 2)
  assert.equal(h.saves.length, 0)
  assert.match(h.errText(), /z, or/)
})

test('config rm deletes the profile and its bindings together', async () => {
  const state = STATE()
  state.bindings = { '/work/proj': 'or', '/elsewhere': 'z' }
  const h = harness({ state })
  assert.equal(await h.run(['rm', 'or']), 0)
  const next = h.saves.at(-1)!
  assert.equal(next.profiles.or, undefined)
  assert.deepEqual(Object.keys(next.bindings), ['/elsewhere'], 'a binding to a deleted profile goes too')
})

test('deleting the default profile promotes the survivor only when there is one', async () => {
  const h = harness()
  await h.run(['rm', 'z'])
  assert.equal(h.saves.at(-1)!.defaultProfile, 'or', 'one left is unambiguous')

  const three = STATE()
  three.providerAccounts.third = { provider: 'zai' }
  three.agentProfiles.third = {}
  three.profiles.third = { agentProfile: 'third', accounts: ['third'] }
  const h2 = harness({ state: three })
  await h2.run(['rm', 'z'])
  // Guessing among several would silently pick an account to bill.
  assert.equal(h2.saves.at(-1)!.defaultProfile, null)
})

// use / bind / unbind / bindings

test('config use binds the current directory', async () => {
  const h = harness({ cwd: '/work/proj' })
  assert.equal(await h.run(['use', 'or']), 0)
  assert.equal(h.saves.at(-1)!.bindings['/work/proj'], 'or')
  assert.match(h.text(), /Subdirectories inherit/)
})

test('config bind is an alias for config use', async () => {
  const h = harness()
  await h.run(['bind', 'or'])
  assert.equal(h.saves.at(-1)!.bindings['/work/proj'], 'or')
})

test('config use refuses to bind to a profile that does not exist', async () => {
  const h = harness()
  assert.equal(await h.run(['use', 'nope']), 2)
  assert.equal(h.saves.length, 0)
})

test('config use --show explains WHICH binding applied and from WHERE', async () => {
  const state = STATE()
  state.bindings = { '/work': 'or' }
  const h = harness({ state, cwd: '/work/proj/deep' })
  assert.equal(await h.run(['use', '--show']), 0)
  const text = h.text()
  assert.match(text, /\/work {2}→ {2}profile "or"/, 'the winning key')
  assert.match(text, /inherited from the nearest ancestor/, 'and how it applied')
  assert.match(text, /effective {3}profile "or"/)
  assert.match(text, /searched.*\/work\/proj\/deep/, 'and where it looked')
})

test('config use --show names the fallback when nothing is bound', async () => {
  const h = harness()
  await h.run(['use', '--show'])
  assert.match(h.text(), /binding {5}none/)
  assert.match(h.text(), /profile "z" \(default profile\)/)
})

test('bare `config use` shows rather than doing anything', async () => {
  // `use` reads like an action, so the no-argument form must not guess at one.
  const h = harness()
  assert.equal(await h.run(['use']), 0)
  assert.equal(h.saves.length, 0)
  assert.match(h.text(), /binding/)
})

test('config use --clear removes only this directory, never an ancestor', async () => {
  const state = STATE()
  state.bindings = { '/work': 'or' }
  const h = harness({ state, cwd: '/work/proj' })
  assert.equal(await h.run(['use', '--clear']), 0)
  assert.equal(h.saves.length, 0, 'nothing was bound HERE, so nothing was written')
  assert.match(h.text(), /\/work still applies here/)
  assert.match(h.text(), /unbind that path explicitly/)
})

test('config unbind removes an exact binding', async () => {
  const state = STATE()
  state.bindings = { '/work/proj': 'or' }
  const h = harness({ state, cwd: '/work/proj' })
  assert.equal(await h.run(['unbind']), 0)
  assert.deepEqual(h.saves.at(-1)!.bindings, {})
})

test('config bindings lists everything and flags what is dead', async () => {
  const state = STATE()
  state.bindings = { '/definitely/not/real': 'z', '/also/not/real': 'deleted-profile' }
  const h = harness({ state })
  assert.equal(await h.run(['bindings']), 0)
  assert.match(h.text(), /directory no longer exists/)
  assert.match(h.text(), /profile no longer exists/)
  assert.equal(h.saves.length, 0, 'listing must not write')
})

test('config bindings --prune removes dead entries and keeps live ones', async () => {
  const live = mkdtempSync(join(tmpdir(), 'swisscode-bind-'))
  try {
    const state = STATE()
    state.bindings = { [live]: 'z', '/definitely/not/real': 'z' }
    const h = harness({ state })
    assert.equal(await h.run(['bindings', '--prune']), 0)
    assert.deepEqual(Object.keys(h.saves.at(-1)!.bindings), [live])
  } finally {
    rmSync(live, { recursive: true, force: true })
  }
})

test('a binding walk is bounded even in a very deep directory', async () => {
  const deep = `/${Array(300).fill('x').join('/')}`
  const h = harness({ cwd: deep })
  assert.equal(await h.run(['use', '--show']), 0, 'deep paths degrade, never error')
})

// Refusals

test('every writing subcommand refuses a config from a newer swisscode', async () => {
  for (const args of [['default', 'or'], ['rm', 'or'], ['use', 'or'], ['unbind'], ['bindings', '--prune']]) {
    const h = harness({ readOnly: true, state: { ...STATE(), bindings: { '/work/proj': 'or' } } })
    assert.equal(await h.run(args), 2, args.join(' '))
    assert.equal(h.saves.length, 0, args.join(' '))
    assert.match(h.errText(), /Upgrade swisscode/)
  }
})

test('reading subcommands still work against a newer config', async () => {
  const h = harness({ readOnly: true })
  assert.equal(await h.run(['list']), 0)
  assert.equal(await h.run(['bindings']), 0)
})

test('an unknown flag is rejected rather than silently ignored', async () => {
  const h = harness()
  assert.equal(await h.run(['--bogus']), 2)
  const h2 = harness()
  assert.equal(await h2.run(['z', 'extra-token']), 2)
  assert.match(h2.errText(), /takes no further arguments/)
})

test('config doctor rejects a malformed --timeout instead of probing forever', async () => {
  const h = harness()
  assert.equal(await h.run(['doctor', '--timeout', 'soon']), 2)
  assert.equal(await h.run(['doctor', '--timeout', '-5']), 2)
})

test('config doctor --offline runs, reports and never launches', async () => {
  const h = harness()
  const code = await h.run(['doctor', '--offline'])
  assert.ok([0, 1, 2].includes(code))
  assert.match(h.text(), /claude binary/)
  assert.match(h.text(), /active profile/)
  assert.ok(!h.text().includes('zai-secret-value'), 'the key must never be printed')
})

test('config doctor --json emits parseable JSON with an exit code to match', async () => {
  const h = harness()
  const code = await h.run(['doctor', '--offline', '--json'])
  const report = JSON.parse(h.text())
  assert.equal(report.profile, 'z')
  assert.ok(Array.isArray(report.checks))
  assert.equal(report.summary.exitCode, code, 'the number CI reads must match the report')
  assert.ok(!JSON.stringify(report).includes('zai-secret-value'))
})

test('config help documents the override flags without inventing new words', async () => {
  const h = harness()
  await h.run(['help'])
  const text = h.text()
  for (const flag of ['--cc-profile', '--cc-provider', '--cc-model', '--cc-base-url', '--cc-env']) {
    assert.match(text, new RegExp(flag.replace(/-/g, '\\-')))
  }
  // Every documented command is spelled `swisscode config …`.
  for (const line of text.split('\n').filter((l) => l.trim().startsWith('swisscode'))) {
    assert.match(line, /^\s*swisscode config\b/, line)
  }
})

test('an unknown doctor flag is rejected wherever it sits in the argv', async () => {
  // Regression: the "skip the --timeout value" rule used to fire at index 0
  // when there was no --timeout at all, so `doctor -x` ran a full probe pass
  // with the flag silently discarded.
  for (const args of [['doctor', '-x', '--offline'], ['doctor', '--offline', '-x'], ['doctor', '--bogus']]) {
    const h = harness()
    assert.equal(await h.run(args), 2, args.join(' '))
    assert.match(h.errText(), /unknown option/)
  }
})

test('a valid --timeout value is not mistaken for an unknown flag', async () => {
  const h = harness()
  assert.notEqual(await h.run(['doctor', '--timeout', '5000', '--offline']), 2)
})

test('every surface that names a provider sees the custom ones', async () => {
  // REGRESSION. The registry was composed in planLaunch and doctor-root but not
  // here, so `config list` reported "unknown provider — not in this build" for a
  // provider `config doctor` resolved perfectly well. Three call sites, one
  // forgotten, and the two commands disagreed about what the config contained.
  //
  // Composing once in runConfigCommand is the fix; this asserts the property
  // rather than the fix, so moving where it happens cannot silently undo it.
  const h = harness({
    state: {
      version: 2,      providerAccounts: {
        rig: makeProfile({ provider: 'vllm' }),
      },
      agentProfiles: {
        rig: {},
      },
      profiles: {
        rig: { agentProfile: 'rig', accounts: ['rig'] },
      },
      defaultProfile: 'rig',
      bindings: {},
      settings: {},
      providers: {
        vllm: {
          id: 'vllm',
          label: 'Local vLLM',
          baseUrl: 'http://localhost:8000',
          defaultModels: { opus: 'my-70b' },
        },
      },
    } as unknown as State,
  })

  await h.run(['list'])
  const text = h.text()
  assert.match(text, /vllm/)
  assert.doesNotMatch(text, /not in this build/, 'a custom provider read as unknown')
  // Its defaults are inherited exactly as a shipped preset's would be.
  assert.match(text, /my-70b/)
})

test('a profile on a genuinely unknown provider still says so', async () => {
  // The composition must not turn the honest "this build does not know that
  // provider" report into silence — that warning is what stops a third-party
  // key being sent to api.anthropic.com.
  const h = harness({
    state: {
      version: 2,      providerAccounts: {
        ghost: makeProfile({ provider: 'nope' }),
      },
      agentProfiles: {
        ghost: {},
      },
      profiles: {
        ghost: { agentProfile: 'ghost', accounts: ['ghost'] },
      },
      defaultProfile: 'ghost',
      bindings: {},
      settings: {},
    } as unknown as State,
  })
  await h.run(['list'])
  assert.match(h.text(), /not in this build/)
})
