import type {
  Benchmarks,
  CatalogCapabilities,
  ModelCatalogPort,
  Pricing,
} from '../../ports/catalog.ts'
import { createCachedCatalog, type CatalogDeps } from './cached-catalog.ts'

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/models'
const DESC_LIMIT = 600

export const OPENROUTER_CAPABILITIES = Object.freeze({
  pricing: true,
  benchmarks: true,
  // OpenRouter publishes supported_parameters per model, so an absent `tools`
  // is a real absence rather than a gap in the catalog.
  toolSupportKnown: true,
  requiresAuth: false,
}) satisfies CatalogCapabilities

/**
 * Narrows `unknown` to something indexable, and nothing more.
 */
function isObjectLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/**
 * `v[key]`, exactly as JavaScript evaluates it for the keys this adapter reads.
 *
 * The expressions this replaces were optional chains over untyped values —
 * `m.pricing?.prompt`, `m.top_provider?.context_length`. Those yield `undefined`
 * for null, for undefined, and for a primitive that has no such property, and
 * so does this. None of the keys read here (`prompt`, `completion`,
 * `context_length`, `artificial_analysis`, …) exists on a string, a number or a
 * boolean, so the two agree on every value `JSON.parse` can produce.
 */
function prop(v: unknown, key: string): unknown {
  return isObjectLike(v) ? v[key] : undefined
}

/**
 * A row this adapter produced: SHAPED like a `NormalizedModel`, not yet proven
 * to be one.
 *
 * The fields typed `unknown` are the ones this adapter copies through without
 * checking — OpenRouter's `id` could be a number and nothing here would notice.
 * `sanitizeModels` is what rejects such a row, and typing these as `string` or
 * `number | null` would be a claim this code does not earn.
 *
 * The fields typed concretely are the ones that ARE proven here: `pricing` and
 * `benchmarks` go through `num`/`nullableNum`, and `tools`/`reasoning` are the
 * result of an `Array.prototype.includes`. Spelling both halves keeps the field
 * NAMES checked against the port — a typo'd `pricng` still fails to compile —
 * while leaving the unvalidated half visibly unvalidated.
 */
type CandidateModel = {
  id: unknown
  name: unknown
  description: unknown
  context: unknown
  maxOutput: unknown
  pricing: Pricing | null
  benchmarks: Benchmarks | null
  tools: boolean
  reasoning: boolean
}

/**
 * OpenRouter's /v1/models payload -> candidate rows. Pure, so
 * test/adapters/catalog.test.js can run it over a captured fixture.
 */
export function normalizeOpenRouter(body: unknown): CandidateModel[] {
  const data = prop(body, 'data')
  if (!Array.isArray(data)) throw new Error('unexpected response shape')
  const rows: unknown[] = data
  return rows.map((row): CandidateModel => {
    // Read straight off the row, as this adapter always has. A null row throws
    // here exactly as it did before the migration, and the throw is caught by
    // createCachedCatalog and reported as a catalog error. Guarding instead
    // would silently keep the rest of a malformed payload, which is a
    // behaviour change this slice does not get to make.
    const m = row as Record<string, unknown>
    const aa = prop(m.benchmarks, 'artificial_analysis') ?? null
    const supported = m.supported_parameters
    const params: unknown[] = Array.isArray(supported) ? supported : []
    const prompt = num(prop(m.pricing, 'prompt'))
    const completion = num(prop(m.pricing, 'completion'))
    return {
      id: m.id,
      name: m.name ?? m.id,
      // `.slice` on a non-string throws, exactly as it did before. The
      // assertion buys the method call and nothing else: the result lands in a
      // field typed `unknown` and is re-checked by `sanitizeModels`. Narrowing
      // to `typeof === 'string'` here would swallow the throw and change what a
      // malformed payload does.
      description: ((m.description ?? '') as string).slice(0, DESC_LIMIT),
      context: m.context_length ?? prop(m.top_provider, 'context_length') ?? null,
      maxOutput: prop(m.top_provider, 'max_completion_tokens') ?? null,
      // A model whose price OpenRouter does not publish gets null, not 0. Free
      // and unpriced must stay distinguishable all the way to the screen.
      pricing:
        prompt === null || completion === null
          ? null
          : { prompt, completion, cacheRead: num(prop(m.pricing, 'input_cache_read')) },
      benchmarks: aa
        ? {
            intelligence: nullableNum(prop(aa, 'intelligence_index')),
            coding: nullableNum(prop(aa, 'coding_index')),
            agentic: nullableNum(prop(aa, 'agentic_index')),
          }
        : null,
      tools: params.includes('tools'),
      reasoning: params.includes('reasoning'),
    }
  })
}

/**
 * `Number.parseFloat(String(v))`, not a cast.
 *
 * `parseFloat` performs ToString on its argument per spec, so wrapping it in an
 * explicit `String(v)` is the SAME computation for every input the old untyped
 * `Number.parseFloat(v)` received — including the numeric prices OpenRouter
 * sometimes sends instead of strings — while needing no assertion at all.
 */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number.parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

const nullableNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

export function createOpenRouterCatalog({ net, cache, clock }: CatalogDeps): ModelCatalogPort {
  return createCachedCatalog({
    id: 'openrouter',
    label: 'OpenRouter',
    capabilities: OPENROUTER_CAPABILITIES,
    endpoint: OPENROUTER_ENDPOINT,
    normalize: normalizeOpenRouter,
    net,
    cache,
    clock,
  })
}
