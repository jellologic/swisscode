import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONFIG_DIR } from './config.js'

const CACHE_PATH = join(CONFIG_DIR, 'models-openrouter.json')
const ENDPOINT = 'https://openrouter.ai/api/v1/models'
const TTL_MS = 24 * 60 * 60 * 1000
const DESC_LIMIT = 600

// Claude Code cannot operate without tool calling, so a model missing `tools`
// isn't merely worse — it's unusable. 71 of OpenRouter's 342 models are in
// that bucket, which is why the picker filters them out by default.
export const REQUIRED_PARAM = 'tools'

function compact(m) {
  const aa = m.benchmarks?.artificial_analysis ?? null
  const params = m.supported_parameters ?? []
  return {
    id: m.id,
    name: m.name ?? m.id,
    description: (m.description ?? '').slice(0, DESC_LIMIT),
    context: m.context_length ?? m.top_provider?.context_length ?? null,
    maxOutput: m.top_provider?.max_completion_tokens ?? null,
    prompt: Number.parseFloat(m.pricing?.prompt ?? '0'),
    completion: Number.parseFloat(m.pricing?.completion ?? '0'),
    cacheRead: m.pricing?.input_cache_read
      ? Number.parseFloat(m.pricing.input_cache_read)
      : null,
    tools: params.includes(REQUIRED_PARAM),
    reasoning: params.includes('reasoning'),
    modality: m.architecture?.modality ?? null,
    aa: aa
      ? {
          intelligence: aa.intelligence_index ?? null,
          coding: aa.coding_index ?? null,
          agentic: aa.agentic_index ?? null,
        }
      : null,
  }
}

// Best coding models first — that's what this picker is for. Anything without
// a benchmark sorts after, alphabetically, so the tail stays browsable.
function rank(a, b) {
  const ca = a.aa?.coding ?? null
  const cb = b.aa?.coding ?? null
  if (ca != null && cb != null && ca !== cb) return cb - ca
  if (ca != null && cb == null) return -1
  if (ca == null && cb != null) return 1
  return a.id.localeCompare(b.id)
}

export function readCache() {
  if (!existsSync(CACHE_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    if (!Array.isArray(raw.models) || raw.models.length === 0) return null
    return { models: raw.models, fetchedAt: raw.fetchedAt ?? 0 }
  } catch {
    return null
  }
}

function writeCache(models) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(
      CACHE_PATH,
      JSON.stringify({ fetchedAt: Date.now(), models }, null, 0),
    )
  } catch {
    // A read-only config dir shouldn't break the picker; we just refetch later.
  }
}

export function isStale(cache) {
  return !cache || Date.now() - cache.fetchedAt > TTL_MS
}

/**
 * Returns { models, fromCache, stale, error }. Never throws: an offline box
 * with a warm cache still gets a working picker, and a cold one falls back to
 * typing the model id by hand.
 */
export async function loadModels({ force = false } = {}) {
  const cache = readCache()
  if (!force && cache && !isStale(cache)) {
    return { models: cache.models, fromCache: true, stale: false, error: null }
  }

  try {
    const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`registry returned HTTP ${res.status}`)
    const body = await res.json()
    if (!Array.isArray(body?.data)) throw new Error('unexpected response shape')
    const models = body.data.map(compact).sort(rank)
    writeCache(models)
    return { models, fromCache: false, stale: false, error: null }
  } catch (err) {
    if (cache) {
      return { models: cache.models, fromCache: true, stale: true, error: err.message }
    }
    return { models: [], fromCache: false, stale: false, error: err.message }
  }
}

export function filterModels(models, { query = '', toolsOnly = true, freeOnly = false }) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  return models.filter((m) => {
    if (toolsOnly && !m.tools) return false
    if (freeOnly && m.prompt !== 0) return false
    if (terms.length === 0) return true
    const hay = `${m.id} ${m.name}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
}

export function formatPrice(perToken) {
  if (perToken === 0) return 'free'
  const perMillion = perToken * 1e6
  // Sub-cent prices need the extra digits; everything else reads better as
  // plain currency ($0.50, not $0.500).
  return `$${perMillion >= 0.01 ? perMillion.toFixed(2) : perMillion.toFixed(4)}`
}

export function formatContext(n) {
  if (!n) return '—'
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`
  return String(n)
}
