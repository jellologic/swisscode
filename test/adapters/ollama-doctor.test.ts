// The Ollama context-window check.
//
// Every payload below is captured verbatim from a live Ollama 0.32.0 with
// qwen3:0.6b pulled and resident — not written from documentation. The two
// numbers in them are the whole point: that server, started with no
// OLLAMA_CONTEXT_LENGTH at all, loaded a model whose ceiling is 40960 at 32768;
// restarted with OLLAMA_CONTEXT_LENGTH=4096 it loaded the same model at 4096.
// The ceiling never moved. Only the loaded window governs.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_FLOOR,
  ceilingContextOf,
  interpretOllamaContext,
  loadedContextOf,
} from '../../src/adapters/doctor/ollama.ts'
import { runDoctor } from '../../src/composition/doctor-root.ts'
import { registry } from '../../src/adapters/providers/registry.ts'
import { registry as agents } from '../../src/adapters/agents/registry.ts'
import type { OllamaContext, OllamaIntrospectPort } from '../../src/ports/doctor.ts'
import type { State } from '../../src/ports/config-store.ts'
import { makeProfile } from '../support/fixtures.ts'

// GET /api/ps, model resident
const PS = {
  models: [
    {
      name: 'qwen3:0.6b',
      model: 'qwen3:0.6b',
      size: 4_394_665_902,
      details: { family: 'qwen3', parameter_size: '751.63M', quantization_level: 'Q4_K_M' },
      expires_at: '2026-07-22T07:59:33.587645-04:00',
      context_length: 32768,
    },
  ],
}

// POST /api/show. Note the key is architecture-prefixed, which is why the
// lookup is by suffix rather than against a list of families.
const SHOW = {
  capabilities: ['completion', 'tools', 'thinking'],
  details: { family: 'qwen3', parameter_size: '751.63M' },
  model_info: {
    'general.architecture': 'qwen3',
    'qwen3.context_length': 40960,
    'qwen3.embedding_length': 1024,
  },
}

test('the loaded window is read from a resident model', () => {
  assert.equal(loadedContextOf(PS, 'qwen3:0.6b'), 32768)
})

test('a model that is not resident reports no loaded window rather than zero', () => {
  assert.equal(loadedContextOf(PS, 'llama3:8b'), null)
  assert.equal(loadedContextOf({ models: [] }, 'qwen3:0.6b'), null)
  assert.equal(loadedContextOf(null, 'qwen3:0.6b'), null)
})

test('an aliased model matches on either name Ollama echoes', () => {
  // `ollama cp` is what Ollama's own docs suggest for making ids look
  // Anthropic-shaped, and it makes `name` and `model` diverge.
  const aliased = { models: [{ name: 'claude-3-5-sonnet', model: 'qwen3:0.6b', context_length: 8192 }] }
  assert.equal(loadedContextOf(aliased, 'claude-3-5-sonnet'), 8192)
  assert.equal(loadedContextOf(aliased, 'qwen3:0.6b'), 8192)
})

test('a nonsense context_length is not a number', () => {
  const bad = (v: unknown) => loadedContextOf({ models: [{ name: 'm', context_length: v }] }, 'm')
  assert.equal(bad(0), null)
  assert.equal(bad(-1), null)
  assert.equal(bad('32768'), null)
  assert.equal(bad(1.5), null)
})

test('the ceiling is found by suffix, whatever the architecture is called', () => {
  assert.equal(ceilingContextOf(SHOW), 40960)
  assert.equal(ceilingContextOf({ model_info: { 'llama.context_length': 131072 } }), 131072)
  assert.equal(ceilingContextOf({ model_info: { 'some-future-arch.context_length': 8192 } }), 8192)
  assert.equal(ceilingContextOf({ model_info: {} }), null)
  assert.equal(ceilingContextOf({}), null)
})

// interpretation

const verdict = (ctx: Partial<OllamaContext>) =>
  interpretOllamaContext({ loaded: null, ceiling: null, error: null, ...ctx }, { model: 'm' })

test('a window at or above the floor is fine', () => {
  assert.equal(verdict({ loaded: CONTEXT_FLOOR }).status, 'ok')
  assert.equal(verdict({ loaded: 32768, ceiling: 40960 }).status, 'ok')
  assert.match(verdict({ loaded: 32768, ceiling: 40960 }).detail, /32K.*40K/)
})

test('a window below the floor warns, and names the silent failure', () => {
  const v = verdict({ loaded: 4096, ceiling: 40960 })
  assert.equal(v.status, 'warn')
  // The point is not "small window" — it is that nothing will tell the user.
  assert.match(v.detail, /silently forgets/)
  assert.match(v.fix!, /OLLAMA_CONTEXT_LENGTH=65536/)
  // A Modelfile num_ctx overrides the env var, so advising the env var alone
  // would send someone to fix the wrong thing.
  assert.match(v.fix!, /num_ctx/)
})

test('the advice mentions the ceiling only when it is the binding constraint', () => {
  // Telling someone to set 64K on a model that tops out at 40K without saying
  // so sends them chasing a window they cannot have.
  assert.match(verdict({ loaded: 4096, ceiling: 40960 }).fix!, /ceiling is 40K/)
  assert.doesNotMatch(verdict({ loaded: 4096, ceiling: 131072 }).fix!, /ceiling/)
})

test('a ceiling alone NEVER warns', () => {
  // The ceiling is an upper bound, not a setting. Warning on it would be the
  // same guessing this check exists to replace — the model may well be about to
  // load at a perfectly good window.
  const v = verdict({ loaded: null, ceiling: 4096 })
  assert.equal(v.status, 'skip')
  assert.match(v.detail, /not loaded/)
  assert.match(v.fix!, /ollama run m/)
})

test('a failed lookup is a skip, never a pass', () => {
  // Reporting "all clear" for work that did not happen is the failure mode
  // `skip` exists to avoid.
  const v = verdict({ error: 'connect ECONNREFUSED' })
  assert.equal(v.status, 'skip')
  assert.match(v.detail, /ECONNREFUSED/)
})

// wiring

const ollamaState = {
  version: 2,
  providerAccounts: {
    local: makeProfile({ provider: 'ollama' }),
  },
  agentProfiles: {
    local: { models: { opus: 'qwen3:0.6b' } },
  },
  profiles: {
    local: { agentProfile: 'local', accounts: ['local'] },
  },
  defaultProfile: 'local',
  bindings: {},
  settings: {},
} as unknown as State

function deps(state: State) {
  return {
    store: {
      load: () => ({ state, corrupt: false, readOnly: false, migrated: false, warnings: [] }),
      save: () => '/tmp/config.json',
      path: () => '/tmp/config.json',
      modes: () => ({ dir: 0o700, file: 0o600 }),
    },
    registry,
    agents,
    proc: {
      env: () => ({}),
      cwd: () => '/work',
      resolveBinary: () => '/usr/local/bin/claude',
      replace: () => {
        throw new Error('doctor must never launch anything')
      },
    },
  }
}

const fakeIntrospect = (ctx: OllamaContext): OllamaIntrospectPort => ({
  context: async () => ctx,
})

const probeStub = {
  messages: async () => ({
    status: 200,
    message: null,
    usedTool: true,
    timedOut: false,
    networkError: null,
    timeoutMs: 1000,
  }),
}

test('an Ollama profile gets the context check', async () => {
  const { report } = await runDoctor({
    deps: deps(ollamaState),
    probe: probeStub,
    ollama: fakeIntrospect({ loaded: 4096, ceiling: 40960, error: null }),
  })
  const check = report.checks.find((c) => c.id.startsWith('ollama-context'))
  assert.ok(check, 'no context check ran for an Ollama profile')
  assert.equal(check.status, 'warn')
  assert.equal(check.title, 'context window')
})

test('--offline skips it, because it is still a network call', async () => {
  // It bills nothing — /api/ps and /api/show run no inference — but --offline
  // means no network, and a check that ignored that would be lying about what
  // offline means.
  const { report } = await runDoctor({ deps: deps(ollamaState), offline: true })
  const check = report.checks.find((c) => c.id.startsWith('ollama-context'))
  assert.equal(check?.status, 'skip')
  assert.match(check!.detail, /offline/)
})

test('a non-Ollama profile gets no context check at all', async () => {
  const zaiState = {
    version: 2,
    providerAccounts: {
      z: makeProfile({ provider: 'zai', apiKey: 'k' }),
    },
    agentProfiles: {
      z: { models: { opus: 'glm-5.2' } },
    },
    profiles: {
      z: { agentProfile: 'z', accounts: ['z'] },
    },
    defaultProfile: 'z',
    bindings: {},
    settings: {},
  } as unknown as State

  const { report } = await runDoctor({ deps: deps(zaiState), probe: probeStub })
  assert.equal(
    report.checks.find((c) => c.id.startsWith('ollama-context')),
    undefined,
  )
})
