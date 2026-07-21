// Pure catalog logic: validate, filter, rank. Array in, array out — no fetch,
// no cache, no filesystem.

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const CACHE_VERSION = 1

/**
 * A cache entry is attacker-adjacent data: it is a plain JSON file in the
 * user's config dir, and whatever `id` it contains flows into config.json and
 * from there into ANTHROPIC_DEFAULT_*_MODEL. Validate every row rather than
 * trusting `Array.isArray`.
 */
export function isNormalizedModel(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false
  if (typeof m.id !== 'string' || m.id.length === 0) return false
  if (typeof m.name !== 'string') return false
  if (!isNullableNumber(m.context) || !isNullableNumber(m.maxOutput)) return false
  if (!isTriState(m.tools) || !isTriState(m.reasoning)) return false
  if (m.pricing !== null) {
    if (!m.pricing || typeof m.pricing !== 'object') return false
    if (!Number.isFinite(m.pricing.prompt) || !Number.isFinite(m.pricing.completion)) return false
    if (!isNullableNumber(m.pricing.cacheRead)) return false
  }
  if (m.benchmarks !== null) {
    if (!m.benchmarks || typeof m.benchmarks !== 'object') return false
    for (const k of ['intelligence', 'coding', 'agentic']) {
      if (!isNullableNumber(m.benchmarks[k])) return false
    }
  }
  return true
}

function isNullableNumber(v) {
  return v === null || (typeof v === 'number' && Number.isFinite(v))
}

function isTriState(v) {
  return v === null || typeof v === 'boolean'
}

/** Drop rows that do not conform. A partly-bad cache is still useful. */
export function sanitizeModels(models) {
  if (!Array.isArray(models)) return []
  return models.filter(isNormalizedModel)
}

/**
 * A non-numeric or future `fetchedAt` used to yield `NaN > TTL` === false,
 * which pinned a cache as fresh forever. Anything that is not a sane past
 * timestamp is stale.
 */
export function isStale(fetchedAt, now, ttlMs = CACHE_TTL_MS) {
  if (!Number.isFinite(fetchedAt)) return true
  if (!Number.isFinite(now)) return true
  if (fetchedAt > now) return true
  return now - fetchedAt > ttlMs
}

/**
 * Best coding models first — that is what the picker is for. Anything without
 * a benchmark sorts after, alphabetically, so the tail stays browsable.
 */
export function rank(a, b) {
  const ca = a.benchmarks?.coding ?? null
  const cb = b.benchmarks?.coding ?? null
  if (ca != null && cb != null && ca !== cb) return cb - ca
  if (ca != null && cb == null) return -1
  if (ca == null && cb != null) return 1
  return a.id.localeCompare(b.id)
}

/**
 * `capabilities` decides which filters are even meaningful, so the picker
 * branches on a declared fact instead of sniffing nulls:
 *
 *  - toolSupportKnown false => the tools filter is inert. Defaulting it on
 *    against a catalog that publishes no parameter list would empty the list.
 *  - pricing false => the free-only filter is inert, and a model with UNKNOWN
 *    pricing never counts as free.
 */
export function filterModels(models, { query = '', toolsOnly = true, freeOnly = false } = {}, capabilities = null) {
  const toolsFilterActive = toolsOnly && (capabilities?.toolSupportKnown ?? true)
  const freeFilterActive = freeOnly && (capabilities?.pricing ?? true)
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)

  return models.filter((m) => {
    // Only a CONFIRMED absence hides a row; unknown stays visible.
    if (toolsFilterActive && m.tools === false) return false
    if (freeFilterActive && !(m.pricing && m.pricing.prompt === 0)) return false
    if (terms.length === 0) return true
    const hay = `${m.id} ${m.name}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
}
