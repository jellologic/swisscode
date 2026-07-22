// Ollama's native introspection, used by `swisscode config doctor`.
//
// Every shape below was read off a live Ollama 0.32.0 with a model pulled and
// resident, not from documentation:
//
//   GET  /api/ps    -> {"models":[{"name":"qwen3:0.6b", … ,"context_length":32768}]}
//   POST /api/show  -> {"model_info":{"qwen3.context_length":40960}, …}
//
// The two numbers are different on purpose and the difference IS the diagnosis:
// that server was started with no OLLAMA_CONTEXT_LENGTH at all and loaded the
// model at 32768, while the model itself tops out at 40960.
//
// No inference happens here, so unlike the messages probe this costs nothing.

import type { OllamaContext, OllamaIntrospectPort } from '../../ports/doctor.ts'

/**
 * The window below which a coding agent stops being usable, per Ollama's own
 * Claude Code guidance ("set the context length to 64k or higher" for larger
 * repositories, with 32K the floor). A number, not a feeling — but it is a
 * threshold for a WARNING, never for a refusal.
 */
export const CONTEXT_FLOOR = 32_768

/** The window Ollama's guide recommends once a repository is non-trivial. */
export const CONTEXT_RECOMMENDED = 65_536

const DEFAULT_TIMEOUT_MS = 3_000

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/** A positive integer, or null. Anything else from a third party is not a number. */
function positiveInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null
}

/**
 * The resident model's loaded window, from /api/ps.
 *
 * Matches on `name` OR `model` because Ollama echoes both and they can differ
 * once a model has been `ollama cp`'d to an alias — the docs suggest exactly
 * that for making ids look Anthropic-shaped.
 */
export function loadedContextOf(body: unknown, model: string): number | null {
  const rows = isObjectLike(body) && Array.isArray(body.models) ? body.models : []
  for (const row of rows) {
    if (!isObjectLike(row)) continue
    if (row.name !== model && row.model !== model) continue
    return positiveInt(row.context_length)
  }
  return null
}

/**
 * The model's ceiling, from /api/show.
 *
 * The key is ARCHITECTURE-PREFIXED — `qwen3.context_length`, `llama.context_length`
 * — so it is found by suffix rather than by a family list that would go stale
 * the first time someone pulls an architecture nobody here has heard of.
 */
export function ceilingContextOf(body: unknown): number | null {
  const info = isObjectLike(body) && isObjectLike(body.model_info) ? body.model_info : null
  if (!info) return null
  for (const [key, value] of Object.entries(info)) {
    if (!key.endsWith('.context_length')) continue
    const n = positiveInt(value)
    if (n) return n
  }
  return null
}

/** `${baseUrl}/${path}` with no doubled slash, matching the probe's URL rule. */
function url(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path}`
}

export function createOllamaIntrospect(): OllamaIntrospectPort {
  async function getJson(target: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(target, { ...init, signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async context({ baseUrl, model, timeoutMs = DEFAULT_TIMEOUT_MS }): Promise<OllamaContext> {
      // Independent on purpose: a model that is not resident yields no /api/ps
      // row, which is a normal state rather than a failure, and the ceiling is
      // still worth reporting. One call failing must not blank the other.
      const [ps, show] = await Promise.allSettled([
        getJson(url(baseUrl, 'api/ps'), { method: 'GET' }, timeoutMs),
        getJson(
          url(baseUrl, 'api/show'),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model }),
          },
          timeoutMs,
        ),
      ])

      const loaded = ps.status === 'fulfilled' ? loadedContextOf(ps.value, model) : null
      const ceiling = show.status === 'fulfilled' ? ceilingContextOf(show.value) : null

      // Only report an error when NOTHING was learned. A resident-model lookup
      // that came back empty is a finding, not a fault.
      let error: string | null = null
      if (ps.status === 'rejected' && show.status === 'rejected') {
        error = (ps.reason as { message?: string })?.message ?? 'introspection failed'
      }
      return { loaded, ceiling, error }
    },
  }
}

/** What the doctor should say. Pure, so every branch is testable without a server. */
export type ContextVerdict = {
  status: 'ok' | 'warn' | 'skip'
  detail: string
  fix?: string
}

const k = (n: number): string => `${Math.round(n / 1024)}K`

/**
 * Turn the two numbers into a verdict.
 *
 * The rule that matters: a WARNING requires a `loaded` window we actually
 * measured. A ceiling alone never warns — it is an upper bound, and failing a
 * model for a window the server may well not be using would be the same
 * guessing this check exists to replace.
 */
export function interpretOllamaContext(
  ctx: OllamaContext,
  { model, floor = CONTEXT_FLOOR }: { model: string; floor?: number },
): ContextVerdict {
  if (ctx.error) {
    return { status: 'skip', detail: `could not ask Ollama about ${model} (${ctx.error})` }
  }

  if (ctx.loaded === null) {
    const ceiling = ctx.ceiling ? `, ceiling ${k(ctx.ceiling)}` : ''
    return {
      status: 'skip',
      detail:
        `${model} is not loaded${ceiling}, so the window it will actually serve is not ` +
        'knowable yet',
      fix:
        'Run the model once (`ollama run ' +
        model +
        '`) and re-run the doctor to see the window Ollama gives it.',
    }
  }

  if (ctx.loaded < floor) {
    return {
      status: 'warn',
      detail:
        `${model} is loaded with a ${k(ctx.loaded)} window; Claude Code assumes 200K and ` +
        'will not be told otherwise, so it silently forgets the start of long conversations',
      fix:
        `Restart Ollama with OLLAMA_CONTEXT_LENGTH=${CONTEXT_RECOMMENDED} (${k(
          CONTEXT_RECOMMENDED,
        )}). A Modelfile \`PARAMETER num_ctx\` overrides that variable, so check it too` +
        (ctx.ceiling && ctx.ceiling < CONTEXT_RECOMMENDED
          ? `; this model's own ceiling is ${k(ctx.ceiling)}.`
          : '.'),
    }
  }

  const ceiling = ctx.ceiling ? ` (model ceiling ${k(ctx.ceiling)})` : ''
  return { status: 'ok', detail: `${model} loaded with a ${k(ctx.loaded)} window${ceiling}` }
}
