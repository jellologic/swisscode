import { createCachedCatalog } from './cached-catalog.js'

export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/models'
const DESC_LIMIT = 600

/** @type {import('../../ports/catalog.js').CatalogCapabilities} */
export const OPENROUTER_CAPABILITIES = Object.freeze({
  pricing: true,
  benchmarks: true,
  // OpenRouter publishes supported_parameters per model, so an absent `tools`
  // is a real absence rather than a gap in the catalog.
  toolSupportKnown: true,
  requiresAuth: false,
})

/**
 * OpenRouter's /v1/models payload -> NormalizedModel[]. Pure, so
 * test/adapters/catalog-openrouter.test.js can run it over a captured fixture.
 */
export function normalizeOpenRouter(body) {
  if (!Array.isArray(body?.data)) throw new Error('unexpected response shape')
  return body.data.map((m) => {
    const aa = m.benchmarks?.artificial_analysis ?? null
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : []
    const prompt = num(m.pricing?.prompt)
    const completion = num(m.pricing?.completion)
    return {
      id: m.id,
      name: m.name ?? m.id,
      description: (m.description ?? '').slice(0, DESC_LIMIT),
      context: m.context_length ?? m.top_provider?.context_length ?? null,
      maxOutput: m.top_provider?.max_completion_tokens ?? null,
      // A model whose price OpenRouter does not publish gets null, not 0. Free
      // and unpriced must stay distinguishable all the way to the screen.
      pricing:
        prompt === null || completion === null
          ? null
          : { prompt, completion, cacheRead: num(m.pricing?.input_cache_read) },
      benchmarks: aa
        ? {
            intelligence: nullableNum(aa.intelligence_index),
            coding: nullableNum(aa.coding_index),
            agentic: nullableNum(aa.agentic_index),
          }
        : null,
      tools: params.includes('tools'),
      reasoning: params.includes('reasoning'),
    }
  })
}

function num(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Number.parseFloat(v)
  return Number.isFinite(n) ? n : null
}

const nullableNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function createOpenRouterCatalog({ net, cache, clock }) {
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
