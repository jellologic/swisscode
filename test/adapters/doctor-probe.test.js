import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROBE_TOOL,
  authHeaders,
  createProbe,
  errorMessage,
  messagesUrl,
  probeBody,
  usedTool,
} from '../../src/adapters/doctor/probe.js'
import { runDoctor } from '../../src/composition/doctor-root.js'
import { registry } from '../../src/adapters/providers/registry.js'

// ---------------------------------------------------------------------------
// The non-streaming rule. This is the whole reason the probe exists in this
// shape: ModelScope answers a bad token with HTTP 200 and an SSE stream that
// dies silently, so a streaming probe cannot tell auth failure from success.
// ---------------------------------------------------------------------------

test('every probe body sets stream:false explicitly', () => {
  assert.equal(probeBody('m').stream, false)
  assert.equal(probeBody('m', { tools: true }).stream, false)
  // Explicit, not omitted: a default that flips under us would silently undo
  // the one property this probe depends on.
  assert.ok('stream' in probeBody('m'))
})

test('the probe is kept tiny, because every call is real inference', () => {
  assert.equal(probeBody('m').max_tokens, 1)
  assert.equal(probeBody('m').messages.length, 1)
  // The tool probe needs room to emit a tool_use block, but not much.
  assert.ok(probeBody('m', { tools: true }).max_tokens <= 16)
})

test('the tool probe forces a call rather than hoping for one', () => {
  const body = probeBody('m', { tools: true })
  assert.deepEqual(body.tools, [PROBE_TOOL])
  assert.deepEqual(body.tool_choice, { type: 'tool', name: PROBE_TOOL.name })
  assert.equal(probeBody('m').tools, undefined, 'the plain probe carries no tools')
})

test('the URL is the bare host plus /v1/messages, with no doubled segment', () => {
  assert.equal(messagesUrl('https://api.z.ai/api/anthropic'), 'https://api.z.ai/api/anthropic/v1/messages')
  assert.equal(messagesUrl('https://x.com/'), 'https://x.com/v1/messages')
  assert.equal(messagesUrl('https://x.com///'), 'https://x.com/v1/messages')
})

test('each credential is presented the way Claude Code presents it', () => {
  // A doctor pass that authenticates differently than the launch would prove
  // nothing about the launch.
  assert.deepEqual(authHeaders('ANTHROPIC_API_KEY', 'k'), { 'x-api-key': 'k' })
  assert.deepEqual(authHeaders('ANTHROPIC_AUTH_TOKEN', 't'), { authorization: 'Bearer t' })
  assert.deepEqual(authHeaders('ANTHROPIC_AUTH_TOKEN', null), {}, 'no header without a credential')
})

test('errorMessage digs a message out of the shapes gateways actually use', () => {
  assert.equal(errorMessage({ error: { message: 'nope' } }), 'nope')
  assert.equal(errorMessage({ message: 'flat' }), 'flat')
  assert.equal(errorMessage({ error: { detail: 'detail form' } }), 'detail form')
  assert.equal(errorMessage(null), null)
  assert.equal(errorMessage({ weird: true }), null)
  assert.equal(errorMessage('x'.repeat(999)).length, 300, 'bounded')
})

test('usedTool requires an actual tool_use block', () => {
  assert.equal(usedTool({ content: [{ type: 'tool_use' }] }), true)
  assert.equal(usedTool({ content: [{ type: 'text', text: 'I would call it' }] }), false)
  assert.equal(usedTool({}), false)
})

// ---------------------------------------------------------------------------
// The probe against a stub fetch.
// ---------------------------------------------------------------------------

function stubFetch(handler) {
  const calls = []
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) })
    return handler(JSON.parse(opts.body), opts)
  }
  fn.calls = calls
  return fn
}

const json = (status, payload) => ({ status, json: async () => payload })

test('a 200 is reported with the status and no error text', async () => {
  const fetchImpl = stubFetch(() => json(200, { content: [{ type: 'text' }] }))
  const probe = createProbe({ fetchImpl })
  const r = await probe.messages({
    baseUrl: 'https://x', credentialEnv: 'ANTHROPIC_AUTH_TOKEN', credential: 'tok', model: 'm',
  })
  assert.equal(r.status, 200)
  assert.equal(r.timedOut, false)
  assert.equal(fetchImpl.calls[0].url, 'https://x/v1/messages')
  assert.equal(fetchImpl.calls[0].opts.method, 'POST')
  assert.equal(fetchImpl.calls[0].body.stream, false)
  assert.equal(fetchImpl.calls[0].opts.headers.authorization, 'Bearer tok')
})

test('a non-JSON body still yields the status rather than throwing', async () => {
  // A gateway returning an HTML error page is itself diagnostic.
  const probe = createProbe({
    fetchImpl: async () => ({ status: 502, json: async () => { throw new Error('not json') } }),
  })
  const r = await probe.messages({ baseUrl: 'https://x', model: 'm' })
  assert.equal(r.status, 502)
  assert.equal(r.message, null)
})

test('an abort is reported as a timeout, not a network error', async () => {
  const probe = createProbe({
    fetchImpl: async (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }),
  })
  const r = await probe.messages({ baseUrl: 'https://x', model: 'm', timeoutMs: 20 })
  assert.equal(r.timedOut, true)
  assert.equal(r.networkError, null)
  assert.equal(r.timeoutMs, 20)
})

test('a connection failure is reported as a network error, not a timeout', async () => {
  const probe = createProbe({
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  const r = await probe.messages({ baseUrl: 'https://x', model: 'm' })
  assert.equal(r.timedOut, false)
  assert.match(r.networkError, /ECONNREFUSED/)
})

// ---------------------------------------------------------------------------
// The whole doctor, wired.
// ---------------------------------------------------------------------------

const SECRET = 'ms-super-secret-token'

function deps(over = {}) {
  const state = over.state ?? {
    version: 2,
    profiles: {
      z: {
        provider: 'zai',
        apiKey: SECRET,
        models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2', fable: 'glm-5.2' },
      },
    },
    defaultProfile: 'z',
    bindings: {},
    settings: {},
  }
  const saves = []
  return {
    saves,
    deps: {
      store: {
        load: () => ({ state, corrupt: false, readOnly: false, migrated: false, warnings: [] }),
        save: (s) => { saves.push(s); return '/tmp/config.json' },
        path: () => '/tmp/config.json',
        modes: () => ({ dir: 0o700, file: 0o600 }),
      },
      registry,
      proc: {
        env: () => over.env ?? {},
        cwd: () => '/work',
        resolveBinary: () => '/usr/local/bin/claude',
        replace: () => { throw new Error('doctor must never launch anything') },
      },
    },
  }
}

test('doctor probes each distinct model once, then tool calling once', async () => {
  const seen = []
  const probe = {
    messages: async (opts) => {
      seen.push({ model: opts.model, tools: Boolean(opts.tools) })
      return { status: 200, message: null, usedTool: true, timedOut: false, networkError: null, timeoutMs: 8000 }
    },
  }
  const { report, exitCode } = await runDoctor({ deps: deps().deps, probe })
  // Four tiers, one distinct model: two requests total, not five.
  assert.deepEqual(seen, [
    { model: 'glm-5.2', tools: false },
    { model: 'glm-5.2', tools: true },
  ])
  assert.equal(exitCode, 0)
  assert.ok(report.checks.some((c) => c.id === 'tool-calling' && c.status === 'ok'))
})

test('doctor skips the tool probe when the endpoint is already unreachable', async () => {
  // No point spending a second request, and no point reporting a tool failure
  // that is really an auth failure.
  const seen = []
  const probe = {
    messages: async (opts) => {
      seen.push(opts.model)
      return { status: 401, message: null, usedTool: false, timedOut: false, networkError: null, timeoutMs: 8000 }
    },
  }
  const { exitCode } = await runDoctor({ deps: deps().deps, probe })
  assert.equal(seen.length, 1)
  assert.equal(exitCode, 2)
})

test('doctor never launches anything and never writes without --fix', async () => {
  const d = deps()
  await runDoctor({ deps: d.deps, offline: true })
  assert.equal(d.saves.length, 0, 'a diagnostic must not rewrite the config')
})

test('--offline makes no network calls at all', async () => {
  const probe = { messages: async () => { throw new Error('must not be called') } }
  const { exitCode, report } = await runDoctor({ deps: deps().deps, offline: true, probe })
  assert.equal(exitCode, 0)
  assert.ok(report.checks.some((c) => c.id === 'probe' && c.detail.includes('--offline')))
})

test('the total budget stops the run rather than running long', async () => {
  const state = {
    version: 2,
    profiles: {
      z: {
        provider: 'zai',
        apiKey: SECRET,
        models: { opus: 'a', sonnet: 'b', haiku: 'c', fable: 'd' },
      },
    },
    defaultProfile: 'z',
    bindings: {},
    settings: {},
  }
  let clock = 0
  const seen = []
  const probe = {
    messages: async (opts) => {
      seen.push(opts.model)
      clock += 400 // each probe burns 400ms of the budget
      return { status: 200, message: null, usedTool: true, timedOut: false, networkError: null, timeoutMs: 8000 }
    },
  }
  const { report } = await runDoctor({
    deps: deps({ state }).deps,
    probe,
    totalTimeoutMs: 1000,
    now: () => clock,
  })
  // Four distinct models at 400ms each against a 1000ms budget: three fit, the
  // fourth finds nothing left. The run stops rather than overrunning, and says
  // so instead of reporting the unprobed model as fine.
  assert.equal(seen.length, 3)
  assert.ok(report.checks.some((c) => c.id === 'probe-deadline'))
  assert.ok(!report.checks.some((c) => c.id === 'endpoint-d'), 'the skipped model is not reported as ok')
})

test('the credential never reaches the report, even when echoed back', async () => {
  const probe = {
    messages: async () => ({
      status: 401,
      message: `rejected key ${SECRET} for this account`,
      usedTool: false,
      timedOut: false,
      networkError: null,
      timeoutMs: 8000,
    }),
  }
  const { report } = await runDoctor({ deps: deps().deps, probe })
  const serialized = JSON.stringify(report)
  assert.ok(!serialized.includes(SECRET), 'the key leaked into --json output')
  assert.match(serialized, /<redacted>/)
  assert.match(serialized, /rejected key/, 'the rest of the diagnostic survives')
})

test('doctor says what it did NOT test about the [1m] suffix', async () => {
  const probe = {
    messages: async () => ({ status: 200, message: null, usedTool: true, timedOut: false, networkError: null, timeoutMs: 1 }),
  }
  const { report } = await runDoctor({ deps: deps().deps, probe })
  assert.ok(report.notes.some((n) => n.includes('[1m]')), 'the untested suffix must be stated')
  assert.ok(report.notes.some((n) => n.includes('non-streaming')))
})

test('--fix prunes dangling bindings and nothing else', async () => {
  const state = {
    version: 2,
    profiles: { z: { provider: 'zai', apiKey: SECRET, models: { opus: 'glm-5.2' } } },
    defaultProfile: 'z',
    bindings: { '/definitely/not/a/real/path': 'gone' },
    settings: {},
  }
  const d = deps({ state })
  await runDoctor({ deps: d.deps, offline: true, fix: true })
  assert.equal(d.saves.length, 1)
  assert.deepEqual(d.saves[0].bindings, {})
  // The model string the user pinned is untouched.
  assert.deepEqual(d.saves[0].profiles.z.models, { opus: 'glm-5.2' })
})
