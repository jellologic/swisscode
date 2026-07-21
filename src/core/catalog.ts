// Pure catalog logic: validate, filter, rank. Array in, array out — no fetch,
// no cache, no filesystem.

import type { CatalogCapabilities, NormalizedModel } from '../ports/catalog.ts'

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const CACHE_VERSION = 1

/**
 * Narrows `unknown` to something indexable, and nothing more.
 *
 * Exactly `!!v && typeof v === 'object'` — the same test the checks below
 * already made inline, INCLUDING the fact that it lets arrays through. That
 * matters: `isNormalizedModel` rejects a top-level array explicitly, but a
 * `pricing: []` was always allowed past the object check and then failed on
 * `Number.isFinite(undefined)`. Preserving that path rather than tightening it
 * on the way past is what keeps this a types-only change.
 */
function isObjectLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object'
}

/**
 * What `Number.isFinite` already guarantees, said so the compiler can use it.
 * `Number.isFinite` does not coerce, so this is the identical runtime test —
 * see the fuller note on the copy in context.ts. Duplicated rather than shared,
 * because core/ has no util module and inventing one would be restructuring.
 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * A cache entry is attacker-adjacent data: it is a plain JSON file in the
 * user's config dir, and whatever `id` it contains flows into config.json and
 * from there into ANTHROPIC_DEFAULT_*_MODEL. Validate every row rather than
 * trusting `Array.isArray`.
 *
 * The `m is NormalizedModel` predicate is EARNED, not asserted: every field of
 * the port type is checked below. This is the one place in core/ where
 * `unknown` is allowed to become a domain type, and it is what lets the rest of
 * the catalog path be typed honestly.
 */
export function isNormalizedModel(m: unknown): m is NormalizedModel {
  if (!isObjectLike(m) || Array.isArray(m)) return false
  if (typeof m.id !== 'string' || m.id.length === 0) return false
  if (typeof m.name !== 'string') return false
  if (!isNullableNumber(m.context) || !isNullableNumber(m.maxOutput)) return false
  if (!isTriState(m.tools) || !isTriState(m.reasoning)) return false
  if (m.pricing !== null) {
    if (!isObjectLike(m.pricing)) return false
    if (!Number.isFinite(m.pricing.prompt) || !Number.isFinite(m.pricing.completion)) return false
    if (!isNullableNumber(m.pricing.cacheRead)) return false
  }
  if (m.benchmarks !== null) {
    if (!isObjectLike(m.benchmarks)) return false
    for (const k of ['intelligence', 'coding', 'agentic']) {
      if (!isNullableNumber(m.benchmarks[k])) return false
    }
  }
  return true
}

function isNullableNumber(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v))
}

function isTriState(v: unknown): v is boolean | null {
  return v === null || typeof v === 'boolean'
}

/** Drop rows that do not conform. A partly-bad cache is still useful. */
export function sanitizeModels(models: unknown): NormalizedModel[] {
  if (!Array.isArray(models)) return []
  return models.filter(isNormalizedModel)
}

/**
 * A non-numeric or future `fetchedAt` used to yield `NaN > TTL` === false,
 * which pinned a cache as fresh forever. Anything that is not a sane past
 * timestamp is stale.
 *
 * `fetchedAt` is `unknown` because that is exactly what it is:
 * `CatalogCacheEntry` declares it untrusted, and this function is the thing
 * that decides otherwise.
 */
export function isStale(fetchedAt: unknown, now: number, ttlMs: number = CACHE_TTL_MS): boolean {
  if (!isFiniteNumber(fetchedAt)) return true
  if (!isFiniteNumber(now)) return true
  if (fetchedAt > now) return true
  return now - fetchedAt > ttlMs
}

/**
 * Best coding models first — that is what the picker is for. Anything without
 * a benchmark sorts after, alphabetically, so the tail stays browsable.
 */
export function rank(a: NormalizedModel, b: NormalizedModel): number {
  const ca = a.benchmarks?.coding ?? null
  const cb = b.benchmarks?.coding ?? null
  if (ca != null && cb != null && ca !== cb) return cb - ca
  if (ca != null && cb == null) return -1
  if (ca == null && cb != null) return 1
  return a.id.localeCompare(b.id)
}

export type FilterOptions = {
  query?: string
  toolsOnly?: boolean
  freeOnly?: boolean
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
export function filterModels(
  models: NormalizedModel[],
  { query = '', toolsOnly = true, freeOnly = false }: FilterOptions = {},
  capabilities: CatalogCapabilities | null = null,
): NormalizedModel[] {
  const toolsFilterActive = toolsOnly && (capabilities?.toolSupportKnown ?? true)
  const freeFilterActive = freeOnly && (capabilities?.pricing ?? true)
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)

  return models.filter((m) => {
    // Only a CONFIRMED absence hides a row; unknown stays visible.
    if (toolsFilterActive && m.tools === false) return false
    // `m.pricing &&` is not defensive style. `pricing` is `Pricing | null`, and
    // UNKNOWN pricing must never count as free — without the null check this
    // line does not compile, which is precisely what the port typing it
    // nullable is for.
    if (freeFilterActive && !(m.pricing && m.pricing.prompt === 0)) return false
    if (terms.length === 0) return true
    const hay = `${m.id} ${m.name}`.toLowerCase()
    return terms.every((t) => hay.includes(t))
  })
}
