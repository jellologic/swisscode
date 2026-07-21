import { createCachedCatalog } from './cached-catalog.js'

// Public, no auth. This IS the /v1 OpenAI-compatible route, which is correct
// for a model listing — and is exactly the path that must NOT be appended to
// the provider's base URL, where /v1/v1/messages would 404.
export const MODELSCOPE_ENDPOINT = 'https://api-inference.modelscope.cn/v1/models'

/**
 * ModelScope publishes an OpenAI-style id list: no prices, no benchmarks, no
 * per-model parameter list. Declaring that up front is what stops the picker
 * rendering "$0.00 / free" over data it simply does not have.
 *
 * @type {import('../../ports/catalog.js').CatalogCapabilities}
 */
export const MODELSCOPE_CAPABILITIES = Object.freeze({
  pricing: false,
  benchmarks: false,
  toolSupportKnown: false,
  requiresAuth: false,
})

/**
 * Models probed and confirmed to lack tool calling on this endpoint. Claude
 * Code cannot operate without tools, so these are worth flagging even though
 * the catalog itself says nothing about capability.
 *
 * Everything not on this list stays `null` — UNKNOWN, not "fine". The two
 * states must not be collapsed.
 */
export const NO_TOOL_SUPPORT = Object.freeze(['deepseek-v3.1', 'kimi-k2'])

export function normalizeModelScope(body) {
  const rows = Array.isArray(body?.data) ? body.data : null
  if (!rows) throw new Error('unexpected response shape')
  return rows
    .filter((m) => typeof m?.id === 'string' && m.id.length > 0)
    .map((m) => ({
      id: m.id,
      name: m.id,
      description: typeof m.owned_by === 'string' ? `Served by ${m.owned_by}.` : '',
      context: null,
      maxOutput: null,
      pricing: null,
      benchmarks: null,
      tools: knownToolSupport(m.id),
      reasoning: null,
    }))
}

function knownToolSupport(id) {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return NO_TOOL_SUPPORT.includes(tail.toLowerCase()) ? false : null
}

export function createModelScopeCatalog({ net, cache, clock }) {
  return createCachedCatalog({
    id: 'modelscope',
    label: 'ModelScope',
    capabilities: MODELSCOPE_CAPABILITIES,
    endpoint: MODELSCOPE_ENDPOINT,
    normalize: normalizeModelScope,
    net,
    cache,
    clock,
  })
}
