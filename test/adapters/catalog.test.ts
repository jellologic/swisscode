// Catalog adapters, exercised over captured payload shapes with an injected
// clock and net port. No network, no waiting 24 hours for a TTL.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  OPENROUTER_CAPABILITIES,
  createOpenRouterCatalog,
  normalizeOpenRouter,
} from '../../src/adapters/catalog/openrouter.ts'
import {
  MODELSCOPE_CAPABILITIES,
  createModelScopeCatalog,
  normalizeModelScope,
} from '../../src/adapters/catalog/modelscope.ts'
import {
  OLLAMA_CAPABILITIES,
  normalizeOllama,
} from '../../src/adapters/catalog/ollama.ts'
import { createCatalogRegistry } from '../../src/adapters/catalog/registry.ts'
import { createFsCacheStore } from '../../src/adapters/store/fs-cache-store.ts'
import { CACHE_TTL_MS, CACHE_VERSION } from '../../src/core/catalog.ts'

// OpenRouter

const OPENROUTER_PAYLOAD = {
  data: [
    {
      id: 'anthropic/claude-opus-4.8',
      name: 'Claude Opus 4.8',
      description: 'A capable model.',
      context_length: 200000,
      top_provider: { max_completion_tokens: 64000 },
      pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
      supported_parameters: ['tools', 'reasoning'],
      benchmarks: { artificial_analysis: { intelligence_index: 58, coding_index: 74.3, agentic_index: 52 } },
    },
    {
      id: 'legacy/no-tools',
      name: 'Legacy',
      pricing: { prompt: '0', completion: '0' },
      supported_parameters: [],
    },
    {
      id: 'mystery/unpriced',
      name: 'Mystery',
      supported_parameters: ['tools'],
    },
  ],
}

test('OpenRouter payloads normalize into the port shape', () => {
  const [claude, legacy, mystery] = normalizeOpenRouter(OPENROUTER_PAYLOAD)

  assert.deepEqual(claude!.pricing, { prompt: 3e-6, completion: 1.5e-5, cacheRead: 3e-7 })
  assert.deepEqual(claude!.benchmarks, { intelligence: 58, coding: 74.3, agentic: 52 })
  assert.equal(claude!.tools, true)
  assert.equal(claude!.context, 200000)

  assert.deepEqual(legacy!.pricing, { prompt: 0, completion: 0, cacheRead: null })
  assert.equal(legacy!.tools, false, 'OpenRouter publishes parameters, so absent means absent')
  assert.equal(legacy!.benchmarks, null)

  // Unpriced must not become 0, or it renders as "free" and passes the free
  // filter.
  assert.equal(mystery!.pricing, null)
})

test('OpenRouter declares that it publishes prices, benchmarks and tool support', () => {
  assert.deepEqual(OPENROUTER_CAPABILITIES, {
    pricing: true,
    benchmarks: true,
    toolSupportKnown: true,
    requiresAuth: false,
  })
})

test('an unexpected OpenRouter response is an error, not a silent empty list', () => {
  assert.throws(() => normalizeOpenRouter({}), /unexpected response shape/)
})

// ModelScope

const MODELSCOPE_PAYLOAD = {
  object: 'list',
  data: [
    { id: 'Qwen/Qwen3-235B-A22B-Instruct', object: 'model', owned_by: 'Qwen' },
    { id: 'deepseek-ai/deepseek-v3.1', object: 'model', owned_by: 'deepseek-ai' },
    { id: 'moonshotai/Kimi-K2', object: 'model', owned_by: 'moonshotai' },
  ],
}

test('ModelScope normalizes to rows with honest nulls, not zeros', () => {
  const rows = normalizeModelScope(MODELSCOPE_PAYLOAD)
  assert.equal(rows.length, 3)
  for (const row of rows) {
    assert.equal(row.pricing, null, 'ModelScope publishes no prices')
    assert.equal(row.benchmarks, null)
    assert.equal(row.context, null)
    assert.ok(row.id.length > 0, 'a row must never render blank')
    assert.ok(row.name.length > 0)
  }
})

test('ModelScope tool support is UNKNOWN by default and false only where probed', () => {
  // Unknown and confirmed-absent must not be collapsed: one is "try it", the
  // other is "this will not work".
  const [qwen, deepseek, kimi] = normalizeModelScope(MODELSCOPE_PAYLOAD)
  assert.equal(qwen!.tools, null)
  assert.equal(deepseek!.tools, false)
  assert.equal(kimi!.tools, false)
})

test('ModelScope declares that it publishes neither prices nor benchmarks', () => {
  assert.deepEqual(MODELSCOPE_CAPABILITIES, {
    pricing: false,
    benchmarks: false,
    toolSupportKnown: false,
    requiresAuth: false,
  })
})

test('the ModelScope catalog endpoint is the /v1 OpenAI route, unlike the base URL', async () => {
  const { MODELSCOPE_ENDPOINT } = await import('../../src/adapters/catalog/modelscope.ts')
  const { modelscope } = await import('../../src/adapters/providers/modelscope.ts')
  assert.equal(MODELSCOPE_ENDPOINT, 'https://api-inference.modelscope.cn/v1/models')
  assert.equal(modelscope.baseUrl, 'https://api-inference.modelscope.cn')
})

// Ollama

// Captured verbatim from `GET /api/tags` on a live Ollama 0.32.0. The
// `capabilities` array and `details.context_length` are both real — an earlier
// version of this adapter assumed neither existed, which is what pulling an
// actual model corrected.
const OLLAMA_PAYLOAD = {
  models: [
    {
      name: 'qwen3:0.6b',
      model: 'qwen3:0.6b',
      size: 522_653_767,
      details: {
        family: 'qwen3',
        parameter_size: '751.63M',
        quantization_level: 'Q4_K_M',
        context_length: 40960,
      },
      capabilities: ['completion', 'tools', 'thinking'],
    },
    // No tools: the case that must be visibly distinguishable.
    { name: 'embed-only:1b', model: 'embed-only:1b', size: 700_000_000, capabilities: ['completion'] },
    // An older Ollama omits `capabilities` entirely — UNKNOWN, not "no tools".
    { name: 'legacy:7b', model: 'legacy:7b', size: 4_100_000_000, details: {} },
    { name: '', model: 'nameless' },
    'not-an-object',
  ],
}

test('Ollama normalizes local models, and refuses the context length it is handed', () => {
  const rows = normalizeOllama(OLLAMA_PAYLOAD)
  // The blank name and the primitive row are dropped, not rendered blank.
  assert.equal(rows.length, 3)
  assert.equal(rows[0]!.id, 'qwen3:0.6b')
  assert.match(rows[0]!.description!, /751\.63M/)
  assert.match(rows[0]!.description!, /523MB/)
  for (const row of rows) {
    // /api/tags DOES publish details.context_length (40960 above) and it is
    // deliberately dropped: that is the model's ceiling, while the same server
    // with no OLLAMA_CONTEXT_LENGTH set loaded this model at 32768. A catalog
    // context flows into contextWindows and out as CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    // so publishing the ceiling would compact at a boundary the server does not
    // serve. The doctor reads /api/ps for the window that is genuinely loaded.
    assert.equal(row.context, null, 'the model ceiling leaked in as the context window')
    assert.equal(row.pricing, null, 'local models have no prices to publish')
    assert.equal(row.benchmarks, null)
  }
})

test('Ollama publishes tool support, and UNKNOWN survives where it does not', () => {
  // Claude Code cannot work without tool calling, so a confirmed answer is
  // worth having — but an older Ollama omits `capabilities`, and "this server
  // does not say" must not collapse into "this model cannot".
  const [qwen, embed, legacy] = normalizeOllama(OLLAMA_PAYLOAD)
  assert.equal(qwen!.tools, true)
  assert.equal(qwen!.reasoning, true, 'thinking is published the same way')
  assert.equal(embed!.tools, false, 'a confirmed absence must be reportable')
  assert.equal(legacy!.tools, null, 'a missing capabilities array is UNKNOWN')
  assert.equal(legacy!.reasoning, null)

  // Safe against that UNKNOWN because filterModels hides a row only on
  // `tools === false`; nulls stay visible rather than emptying the picker.
  assert.equal(OLLAMA_CAPABILITIES.toolSupportKnown, true)
})

test('an unexpected Ollama response is an error, not a silent empty list', () => {
  assert.throws(() => normalizeOllama({ models: 'nope' }), /unexpected response shape/)
  assert.throws(() => normalizeOllama(null), /unexpected response shape/)
})

test('the Ollama catalog uses the native /api/tags route, not the launch base URL', async () => {
  const { OLLAMA_ENDPOINT } = await import('../../src/adapters/catalog/ollama.ts')
  const { ollama } = await import('../../src/adapters/providers/ollama.ts')
  assert.equal(OLLAMA_ENDPOINT, 'http://localhost:11434/api/tags')
  // The base URL must stay a bare host: Claude Code appends /v1/messages, so a
  // /v1 here would produce /v1/v1/messages and a 404.
  assert.equal(ollama.baseUrl, 'http://localhost:11434')
})

// caching / TTL

function harness(
  // `payload` is `unknown` because two tests pass an Error deliberately, to
  // drive the "list never throws" and "serve a stale cache when offline" paths.
  // NetPort.getJson is declared to return `unknown` for the same reason: a
  // catalog response is untrusted JSON and every row is re-validated.
  { payload = OPENROUTER_PAYLOAD as unknown, now = 1_000_000_000_000 }: { payload?: unknown; now?: number } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'swisscode-cat-'))
  const clock = { now: () => now }
  const calls: string[] = []
  const net = {
    getJson: async (url: string) => {
      calls.push(url)
      if (payload instanceof Error) throw payload
      return payload
    },
  }
  const cache = createFsCacheStore({ dir, clock })
  return { dir, clock, calls, net, cache, setNow: (n: number) => { now = n } }
}

test('a fresh cache is served without touching the network', async () => {
  const h = harness()
  const first = await createOpenRouterCatalog(h).list()
  assert.equal(first.fromCache, false)
  assert.equal(h.calls.length, 1)

  const second = await createOpenRouterCatalog(h).list()
  assert.equal(second.fromCache, true)
  assert.equal(second.stale, false)
  assert.equal(h.calls.length, 1, 'no second fetch')
})

test('the cache expires after 24 hours', async () => {
  const h = harness()
  await createOpenRouterCatalog(h).list()
  h.setNow(1_000_000_000_000 + CACHE_TTL_MS + 1)
  const after = await createOpenRouterCatalog(h).list()
  assert.equal(after.fromCache, false)
  assert.equal(h.calls.length, 2)
})

test('a hand-edited fetchedAt cannot pin the cache as fresh forever', async () => {
  const h = harness()
  await createOpenRouterCatalog(h).list()
  const path = h.cache.path('openrouter')
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...raw, fetchedAt: 'whenever' }))

  const after = await createOpenRouterCatalog(h).list()
  assert.equal(after.fromCache, false, 'garbage timestamps must count as stale')
})

test('a future fetchedAt is also stale', async () => {
  const h = harness()
  await createOpenRouterCatalog(h).list()
  const path = h.cache.path('openrouter')
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...raw, fetchedAt: 2_000_000_000_000 }))

  const after = await createOpenRouterCatalog(h).list()
  assert.equal(after.fromCache, false)
})

test('malformed cache rows are dropped rather than fed into config.json', async () => {
  // An undefined id here would end up in ANTHROPIC_DEFAULT_*_MODEL.
  const h = harness()
  const path = h.cache.path('openrouter')
  mkdirSync(h.dir, { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      version: CACHE_VERSION,
      fetchedAt: h.clock.now(),
      models: [{ notAModel: true }, { id: undefined, name: 'x' }],
    }),
  )
  const r = await createOpenRouterCatalog(h).list()
  assert.equal(r.fromCache, false, 'an all-junk cache is no cache at all')
  assert.ok(r.models.every((m) => typeof m.id === 'string' && m.id.length > 0))
})

test('a cache from an older format is refetched, not half-trusted', async () => {
  const h = harness()
  mkdirSync(h.dir, { recursive: true })
  // The 0.1.0 envelope: no version field, flat price fields.
  writeFileSync(
    h.cache.path('openrouter'),
    JSON.stringify({ fetchedAt: h.clock.now(), models: [{ id: 'a', name: 'a', prompt: 0 }] }),
  )
  const r = await createOpenRouterCatalog(h).list()
  assert.equal(r.fromCache, false)
  assert.equal(h.calls.length, 1)
})

test('a warm cache keeps the picker working offline', async () => {
  const h = harness()
  await createOpenRouterCatalog(h).list()
  h.setNow(1_000_000_000_000 + CACHE_TTL_MS + 1)

  const offline = createOpenRouterCatalog({
    ...h,
    net: { getJson: async () => { throw new Error('getaddrinfo ENOTFOUND') } },
  })
  const r = await offline.list()
  assert.equal(r.fromCache, true)
  assert.equal(r.stale, true)
  assert.match(r.error!, /ENOTFOUND/)
  assert.ok(r.models.length > 0)
})

test('list never throws, even with a cold cache and no network', async () => {
  const h = harness({ payload: new Error('offline') })
  const r = await createOpenRouterCatalog(h).list()
  assert.deepEqual(r.models, [])
  assert.equal(r.error, 'offline')
})

test('the cache file is written atomically into a 0700 directory', async () => {
  const h = harness()
  await createOpenRouterCatalog(h).list()
  assert.equal(statSync(h.dir).mode & 0o777, 0o700, 'this dir also holds config.json')
  assert.equal(readdirSync(h.dir).filter((f) => f.includes('.tmp.')).length, 0)
})

test('ModelScope caches under its own id, so catalogs cannot collide', async () => {
  const h = harness({ payload: MODELSCOPE_PAYLOAD })
  const r = await createModelScopeCatalog(h).list()
  assert.ok(r.models.length > 0)
  assert.ok(readdirSync(h.dir).includes('models-modelscope.json'))
})

test('the catalog registry resolves ids lazily and memoizes them', () => {
  const h = harness()
  const registry = createCatalogRegistry(h)
  assert.equal(registry.byId('nope'), null)
  assert.equal(registry.byId(null), null)
  const a = registry.byId('openrouter')
  assert.equal(a!.id, 'openrouter')
  assert.equal(registry.byId('openrouter'), a, 'built once')
  assert.equal(registry.byId('modelscope')!.capabilities.pricing, false)
})
