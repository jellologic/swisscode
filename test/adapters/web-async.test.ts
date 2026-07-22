// The two API routes that do I/O.
//
// They live apart from api.ts so the pure handler stays pure; these tests
// exercise them through injected fakes, so nothing here resolves a binary,
// bills a token, or touches a network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { handleAsyncApi } from '../../src/adapters/web/api-async.ts'
import type { DoctorReport } from '../../src/ports/doctor.ts'
import type { CatalogRegistryPort, ModelCatalogPort } from '../../src/ports/catalog.ts'

const report = (): DoctorReport =>
  ({
    profile: 'work',
    source: 'default',
    provider: 'zai',
    endpoint: 'https://api.z.ai/api/anthropic',
    checks: [],
    repairs: [],
    notes: [],
    summary: { counts: { ok: 1, warn: 0, error: 0, skip: 0 }, exitCode: 0 },
  }) as DoctorReport

test('an unrecognised route is handed back, not answered', async () => {
  // Returning null rather than a 404 is what lets the pure handler own
  // everything else. Answering here would shadow every route in api.ts.
  assert.equal(await handleAsyncApi({ method: 'GET', path: '/api/bootstrap', body: null }, {}), null)
  assert.equal(await handleAsyncApi({ method: 'PUT', path: '/api/profiles/x', body: null }, {}), null)
})

test('the doctor defaults to OFFLINE, inverting the CLI on purpose', async () => {
  // On the command line, `config doctor` is an explicit act. In a browser it is
  // a button, and the probes are real billable inference requests — so spending
  // money has to be opted into, not defaulted into.
  const calls: boolean[] = []
  const deps = {
    doctor: async ({ offline }: { offline: boolean }) => {
      calls.push(offline)
      return report()
    },
  }

  await handleAsyncApi({ method: 'POST', path: '/api/doctor', body: null }, deps)
  await handleAsyncApi({ method: 'POST', path: '/api/doctor', body: {} }, deps)
  await handleAsyncApi({ method: 'POST', path: '/api/doctor', body: { offline: true } }, deps)
  assert.deepEqual(calls, [true, true, true], 'a probe ran without being asked for')

  // …and it is genuinely reachable when asked for explicitly.
  await handleAsyncApi({ method: 'POST', path: '/api/doctor', body: { offline: false } }, deps)
  assert.equal(calls[3], false)
})

test('a doctor that throws is reported, not turned into a hang', async () => {
  const res = await handleAsyncApi(
    { method: 'POST', path: '/api/doctor', body: null },
    {
      doctor: async () => {
        throw new Error('resolveBinary exploded')
      },
    },
  )
  assert.equal(res?.status, 500)
  assert.match(String((res?.body as { error: string }).error), /exploded/)
})

test('with no doctor wired the route says so rather than 404ing', async () => {
  // 404 would read as "no such endpoint", which would send someone looking for
  // a typo in a URL that is perfectly correct.
  const res = await handleAsyncApi({ method: 'POST', path: '/api/doctor', body: null }, {})
  assert.equal(res?.status, 501)
})

// catalog

const fakeCatalog = (over: Partial<ModelCatalogPort> = {}): ModelCatalogPort =>
  ({
    id: 'openrouter',
    label: 'OpenRouter',
    capabilities: { pricing: true, benchmarks: true, toolSupportKnown: true, requiresAuth: false },
    list: async () => ({ models: [], fromCache: false, stale: false, error: null }),
    ...over,
  }) as ModelCatalogPort

const registry = (catalog: ModelCatalogPort | null): CatalogRegistryPort => ({
  ids: () => ['openrouter'],
  has: () => catalog !== null,
  byId: () => catalog,
})

test('a catalog is served with its capabilities, so the UI can branch on facts', async () => {
  const res = await handleAsyncApi(
    { method: 'GET', path: '/api/catalog/openrouter', body: null },
    { catalogs: registry(fakeCatalog()) },
  )
  assert.equal(res?.status, 200)
  const body = res?.body as Record<string, unknown>
  // Declared up front rather than inferred from a page of nulls — the same
  // reason the port carries `capabilities` at all.
  assert.deepEqual(body.capabilities, {
    pricing: true,
    benchmarks: true,
    toolSupportKnown: true,
    requiresAuth: false,
  })
})

test('a stale cache is reported as stale rather than passed off as fresh', async () => {
  // list() never throws; it reports. Losing that distinction would show a
  // day-old list as current.
  const res = await handleAsyncApi(
    { method: 'GET', path: '/api/catalog/openrouter', body: null },
    {
      catalogs: registry(
        fakeCatalog({
          list: async () => ({
            models: [],
            fromCache: true,
            stale: true,
            error: 'network unreachable',
          }),
        }),
      ),
    },
  )
  const body = res?.body as Record<string, unknown>
  assert.equal(body.stale, true)
  assert.equal(body.error, 'network unreachable')
})

test('a provider with no catalog is a 404, which is a normal state', async () => {
  // Most providers publish nothing browsable; the UI asks and gets told no.
  const res = await handleAsyncApi(
    { method: 'GET', path: '/api/catalog/zai', body: null },
    { catalogs: registry(null) },
  )
  assert.equal(res?.status, 404)
})
