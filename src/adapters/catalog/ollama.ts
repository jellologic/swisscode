import type {
  CatalogCapabilities,
  ModelCatalogPort,
  NormalizedModel,
} from '../../ports/catalog.ts'
import { createCachedCatalog, type CatalogDeps } from './cached-catalog.ts'

/**
 * The local model list. This is Ollama's NATIVE api, not the Anthropic-
 * compatible route the launch uses, and not the /v1 OpenAI one either — the
 * same distinction modelscope.ts draws. Appending /v1 to the provider's base
 * URL would 404; listing models is a different endpoint entirely.
 *
 * Hard-coded to the default host. A user who moved Ollama with OLLAMA_HOST, or
 * pointed a profile at a remote one, gets an empty picker and types the id by
 * hand — which is the honest failure, and better than a picker confidently
 * listing some other machine's models.
 */
export const OLLAMA_ENDPOINT = 'http://localhost:11434/api/tags'

/**
 * Ollama publishes names, sizes, quantisation and — since the `capabilities`
 * array landed — tool support. It publishes no prices (there are none) and no
 * benchmarks.
 *
 * `toolSupportKnown: true` is the load-bearing one, and it is safe even against
 * an older Ollama that omits `capabilities`: `filterModels` hides a row only on
 * a CONFIRMED absence (`tools === false`), so rows that come back UNKNOWN stay
 * visible rather than emptying the picker. Claude Code cannot work without tool
 * calling, so knowing this for real is worth having.
 */
export const OLLAMA_CAPABILITIES = Object.freeze({
  pricing: false,
  benchmarks: false,
  toolSupportKnown: true,
  requiresAuth: false,
}) satisfies CatalogCapabilities

/**
 * A capability flag, read off the `capabilities` array Ollama 0.3x publishes.
 *
 * TRI-STATE on purpose: an older Ollama omits the array entirely, and "this
 * server does not tell us" is not the same fact as "this model cannot".
 */
function capability(caps: unknown, name: string): boolean | null {
  if (!Array.isArray(caps)) return null
  return caps.includes(name)
}

/** Narrows `unknown` to something indexable, and nothing more. */
function isObjectLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/**
 * A row with a usable name. `name` is the tagged id (`qwen3-coder:30b`) and is
 * what has to reach ANTHROPIC_DEFAULT_*_MODEL — `model` alongside it is the
 * same string, and `details` is decoration.
 */
function hasUsableName(
  m: unknown,
): m is { name: string; details?: unknown; size?: unknown; capabilities?: unknown } {
  return isObjectLike(m) && typeof m.name === 'string' && m.name.length > 0
}

/** Human-sized bytes, for the row description. Ollama reports plain bytes. */
function humanSize(bytes: unknown): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null
  const gb = bytes / 1_000_000_000
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${Math.round(bytes / 1_000_000)}MB`
}

/**
 * Ollama's /api/tags payload -> NormalizedModel[].
 *
 * Returns `NormalizedModel[]` rather than `unknown[]` because, like the
 * ModelScope normalizer, it genuinely proves it: `id`/`name` is the checked
 * string and every other field is a literal written here.
 *
 * `context: null` is the important literal, and it is a DELIBERATE refusal of
 * data that is right there. /api/tags does publish `details.context_length`
 * (40960 for qwen3:0.6b, verified) — but that is the model's ceiling, not the
 * window the server will serve. The same machine, started with no
 * OLLAMA_CONTEXT_LENGTH at all, loaded that model at 32768.
 *
 * A catalog `context` flows into `contextWindows` when a model is picked and
 * from there into CLAUDE_CODE_AUTO_COMPACT_WINDOW. Publishing the ceiling would
 * therefore tell Claude Code to compact at a boundary the server does not
 * actually serve, and a window set too large means the conversation overflows
 * instead of compacting — the precise failure the auto-compact rule exists to
 * avoid. The doctor asks /api/ps for the window that is genuinely loaded.
 */
export function normalizeOllama(body: unknown): NormalizedModel[] {
  const models = isObjectLike(body) ? body.models : undefined
  const rows: unknown[] | null = Array.isArray(models) ? models : null
  if (!rows) throw new Error('unexpected response shape')
  return rows.filter(hasUsableName).map((m) => {
    const details = isObjectLike(m.details) ? m.details : {}
    const parts = [
      typeof details.parameter_size === 'string' ? details.parameter_size : null,
      typeof details.quantization_level === 'string' ? details.quantization_level : null,
      humanSize(m.size),
    ].filter((s): s is string => Boolean(s))
    return {
      id: m.name,
      name: m.name,
      description: parts.length > 0 ? `Local model · ${parts.join(' · ')}` : 'Local model.',
      context: null,
      maxOutput: null,
      pricing: null,
      benchmarks: null,
      tools: capability(m.capabilities, 'tools'),
      reasoning: capability(m.capabilities, 'thinking'),
    }
  })
}

export function createOllamaCatalog({ net, cache, clock }: CatalogDeps): ModelCatalogPort {
  return createCachedCatalog({
    id: 'ollama',
    label: 'Ollama (local)',
    capabilities: OLLAMA_CAPABILITIES,
    endpoint: OLLAMA_ENDPOINT,
    normalize: normalizeOllama,
    net,
    cache,
    clock,
  })
}
