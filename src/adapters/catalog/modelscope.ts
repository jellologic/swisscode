import type {
  CatalogCapabilities,
  ModelCatalogPort,
  NormalizedModel,
} from '../../ports/catalog.ts'
import { createCachedCatalog, type CatalogDeps } from './cached-catalog.ts'

// Public, no auth. This IS the /v1 OpenAI-compatible route, which is correct
// for a model listing — and is exactly the path that must NOT be appended to
// the provider's base URL, where /v1/v1/messages would 404.
export const MODELSCOPE_ENDPOINT = 'https://api-inference.modelscope.cn/v1/models'

/**
 * ModelScope publishes an OpenAI-style id list: no prices, no benchmarks, no
 * per-model parameter list. Declaring that up front is what stops the picker
 * rendering "$0.00 / free" over data it simply does not have.
 */
export const MODELSCOPE_CAPABILITIES = Object.freeze({
  pricing: false,
  benchmarks: false,
  toolSupportKnown: false,
  requiresAuth: false,
}) satisfies CatalogCapabilities

/**
 * Models probed and confirmed to lack tool calling on this endpoint. Claude
 * Code cannot operate without tools, so these are worth flagging even though
 * the catalog itself says nothing about capability.
 *
 * Everything not on this list stays `null` — UNKNOWN, not "fine". The two
 * states must not be collapsed.
 */
export const NO_TOOL_SUPPORT: readonly string[] = Object.freeze(['deepseek-v3.1', 'kimi-k2'])

/** Narrows `unknown` to something indexable, and nothing more. */
function isObjectLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/**
 * A row with a usable id. The ONLY thing this adapter validates, and the only
 * thing it needs to: every other field of the model it emits is a constant.
 *
 * Identical to the inline `typeof m?.id === 'string' && m.id.length > 0` filter
 * it replaces — a primitive row has no `id`, so both reject it.
 */
function hasUsableId(m: unknown): m is { id: string; owned_by?: unknown } {
  return isObjectLike(m) && typeof m.id === 'string' && m.id.length > 0
}

/**
 * ModelScope's /v1/models payload -> NormalizedModel[].
 *
 * This return type is `NormalizedModel[]` and not `unknown[]` — unlike the
 * OpenRouter normalizer — because this adapter genuinely PROVES it. `id` is
 * checked by `hasUsableId`, `name` is that same checked string, and every
 * remaining field is a literal written right here.
 *
 * Those literals are the honest-blanks requirement, enforced by the compiler
 * rather than by review: `pricing: null` and `benchmarks: null` mean UNKNOWN,
 * and because the port declares them `Pricing | null` / `Benchmarks | null`,
 * a renderer that reaches for `.prompt` or `.coding` on a ModelScope row
 * DOES NOT COMPILE. That is what makes "$0.00 over data we do not have"
 * unreachable here instead of merely tested for. `tools` is tri-state for the
 * same reason: `null` is UNKNOWN, and only the hand-confirmed deny-list below
 * ever produces `false`.
 */
export function normalizeModelScope(body: unknown): NormalizedModel[] {
  const data = isObjectLike(body) ? body.data : undefined
  const rows: unknown[] | null = Array.isArray(data) ? data : null
  if (!rows) throw new Error('unexpected response shape')
  return rows.filter(hasUsableId).map((m) => ({
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

function knownToolSupport(id: string): boolean | null {
  const tail = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  return NO_TOOL_SUPPORT.includes(tail.toLowerCase()) ? false : null
}

export function createModelScopeCatalog({ net, cache, clock }: CatalogDeps): ModelCatalogPort {
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
