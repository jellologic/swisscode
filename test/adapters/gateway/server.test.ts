import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { startGateway } from '../../../src/adapters/gateway/server.ts'
import type { Route } from '../../../src/adapters/gateway/table.ts'

/** A stub upstream that replays a scripted sequence and records what it saw. */
type Reply = { status: number; body: string; headers?: Record<string, string> }
type Upstream = {
  url: string
  calls: Array<{ path: string; body: string; auth: string | undefined; key: string | undefined }>
  close: () => Promise<void>
}

async function upstream(script: Reply[]): Promise<Upstream> {
  const calls: Upstream['calls'] = []
  let n = 0
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      calls.push({
        path: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        auth: req.headers.authorization,
        key: req.headers['x-api-key'] as string | undefined,
      })
      const reply = script[Math.min(n, script.length - 1)] ?? { status: 500, body: '{}' }
      n++
      res.writeHead(reply.status, reply.headers ?? { 'content-type': 'application/json' })
      res.end(reply.body)
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((done) => { server.close(() => done()) }),
  }
}

const route = (over: Partial<Route> & { baseUrl: string }): Route => ({
  profile: 'p', provider: 'anthropic', credential: '', header: 'authorization',
  models: { opus: undefined, sonnet: undefined, haiku: undefined, fable: undefined },
  ...over,
})

const ok = (body: unknown): Reply => ({ status: 200, body: JSON.stringify(body) })
const overloaded = (headers?: Record<string, string>): Reply => ({
  status: 529,
  body: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  ...(headers ? { headers: { 'content-type': 'application/json', ...headers } } : {}),
})

async function withGateway<T>(
  routes: Route[],
  run: (url: string, usage: Map<string, { requests: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>) => Promise<T>,
): Promise<T> {
  const gateway = await startGateway({
    routes, port: 0, out: () => {}, sleep: async () => {},
  })
  try {
    return await run(gateway.url, gateway.usage)
  } finally {
    await gateway.close()
  }
}

const post = (url: string, body: unknown) =>
  fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

test('a healthy upstream is forwarded and its response returned unchanged', async () => {
  const up = await upstream([ok({ id: 'msg_1', usage: { input_tokens: 5, output_tokens: 2 } })])
  try {
    await withGateway([route({ baseUrl: up.url })], async (url, usage) => {
      const res = await post(url, { model: 'claude-opus-5' })
      assert.equal(res.status, 200)
      assert.deepEqual(((await res.json()) as { id: string }).id, 'msg_1')
      assert.equal(usage.get('p')?.inputTokens, 5)
    })
    assert.equal(up.calls[0]?.path, '/v1/messages')
  } finally {
    await up.close()
  }
})

test('529 is retried against the same route before giving up on it', async () => {
  const up = await upstream([overloaded(), overloaded(), ok({ id: 'msg_ok' })])
  try {
    await withGateway([route({ baseUrl: up.url })], async (url) => {
      const res = await post(url, { model: 'claude-opus-5' })
      assert.equal(res.status, 200)
    })
    assert.equal(up.calls.length, 3)
  } finally {
    await up.close()
  }
})

test('once a route is exhausted the next profile serves the request', async () => {
  const primary = await upstream([overloaded()])
  const backup = await upstream([ok({ id: 'from_backup' })])
  try {
    await withGateway(
      [route({ profile: 'work', baseUrl: primary.url }), route({ profile: 'glm', baseUrl: backup.url })],
      async (url) => {
        const res = await post(url, { model: 'claude-opus-5' })
        assert.equal(((await res.json()) as { id: string }).id, 'from_backup')
      },
    )
    assert.equal(primary.calls.length, 3, 'primary should exhaust its retries first')
    assert.equal(backup.calls.length, 1)
  } finally {
    await primary.close()
    await backup.close()
  }
})

test('failover rewrites the model to the fallback profile’s tier equivalent', async () => {
  const primary = await upstream([overloaded()])
  const backup = await upstream([ok({ id: 'ok' })])
  try {
    await withGateway(
      [
        route({
          profile: 'work', baseUrl: primary.url,
          models: { opus: 'claude-opus-5', sonnet: undefined, haiku: undefined, fable: undefined },
        }),
        route({
          profile: 'glm', baseUrl: backup.url,
          models: { opus: 'glm-5.2', sonnet: undefined, haiku: undefined, fable: undefined },
        }),
      ],
      async (url) => { await post(url, { model: 'claude-opus-5' }) },
    )
    assert.equal(JSON.parse(primary.calls[0]?.body ?? '{}').model, 'claude-opus-5')
    assert.equal(JSON.parse(backup.calls[0]?.body ?? '{}').model, 'glm-5.2')
  } finally {
    await primary.close()
    await backup.close()
  }
})

test('a non-retryable status fails immediately without burning attempts', async () => {
  const up = await upstream([{ status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}' }])
  try {
    await withGateway([route({ baseUrl: up.url })], async (url) => {
      const res = await post(url, { model: 'claude-opus-5' })
      assert.equal(res.status, 400)
    })
    assert.equal(up.calls.length, 1)
  } finally {
    await up.close()
  }
})

test('a 429 that reads as a balance problem is not retried', async () => {
  const up = await upstream([{
    status: 429,
    body: '{"error":{"message":"Insufficient balance or no resource package. Please recharge."}}',
  }])
  try {
    await withGateway([route({ baseUrl: up.url })], async (url) => {
      const res = await post(url, { model: 'claude-opus-5' })
      assert.equal(res.status, 429)
    })
    // Retrying a spend cap is pure latency; it will still be 429 in an hour.
    assert.equal(up.calls.length, 1)
  } finally {
    await up.close()
  }
})

test('a route with a key never forwards the caller’s own credential', async () => {
  const up = await upstream([ok({ id: 'x' })])
  try {
    await withGateway(
      [route({ baseUrl: up.url, credential: 'route-key', header: 'authorization' })],
      async (url) => {
        await fetch(`${url}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer CALLER-SECRET' },
          body: JSON.stringify({ model: 'claude-opus-5' }),
        })
      },
    )
    assert.equal(up.calls[0]?.auth, 'Bearer route-key')
    assert.ok(!JSON.stringify(up.calls[0]).includes('CALLER-SECRET'))
  } finally {
    await up.close()
  }
})

test('a session-mode route forwards the caller’s credential untouched', async () => {
  const up = await upstream([ok({ id: 'x' })])
  try {
    await withGateway([route({ baseUrl: up.url, credential: '' })], async (url) => {
      await fetch(`${url}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer SUBSCRIPTION' },
        body: JSON.stringify({ model: 'claude-opus-5' }),
      })
    })
    assert.equal(up.calls[0]?.auth, 'Bearer SUBSCRIPTION')
  } finally {
    await up.close()
  }
})

test('count_tokens is answered locally and never reaches an upstream', async () => {
  const up = await upstream([{ status: 401, body: '{"error":{"message":"jwt auth is not yet supported"}}' }])
  try {
    await withGateway([route({ baseUrl: up.url })], async (url) => {
      const res = await fetch(`${url}/v1/messages/count_tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'hello world' }] }),
      })
      assert.equal(res.status, 200)
      assert.ok(((await res.json()) as { input_tokens: number }).input_tokens > 0)
    })
    assert.equal(up.calls.length, 0)
  } finally {
    await up.close()
  }
})

test('a streamed response is forwarded frame for frame, ping events included', async () => {
  const wire =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":9}}}\n\n' +
    'event: ping\ndata: {"type":"ping"}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  const up = await upstream([{ status: 200, body: wire, headers: { 'content-type': 'text/event-stream' } }])
  try {
    await withGateway([route({ baseUrl: up.url })], async (url) => {
      const res = await post(url, { model: 'claude-opus-5', stream: true })
      const text = await res.text()
      // A dropped ping leaves a client with no way to tell a slow stream from
      // a dead one, and Claude Code has no inactivity watchdog.
      assert.ok(text.includes('event: ping'))
      assert.equal(text, wire)
    })
  } finally {
    await up.close()
  }
})

test('every route failing surfaces the last upstream error', async () => {
  const a = await upstream([overloaded()])
  const b = await upstream([{ status: 429, body: '{"type":"error","error":{"type":"rate_limit_error","message":"slow"}}' }])
  try {
    await withGateway(
      [route({ profile: 'a', baseUrl: a.url }), route({ profile: 'b', baseUrl: b.url })],
      async (url) => {
        const res = await post(url, { model: 'claude-opus-5' })
        assert.equal(res.status, 429)
      },
    )
  } finally {
    await a.close()
    await b.close()
  }
})

test('/health names the routes without leaking credentials', async () => {
  await withGateway([route({ profile: 'work', baseUrl: 'http://127.0.0.1:1', credential: 'SECRET' })], async (url) => {
    const res = await fetch(`${url}/health`)
    const text = await res.text()
    assert.match(text, /work/)
    assert.ok(!text.includes('SECRET'))
  })
})
