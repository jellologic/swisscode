// Port: a browsable model catalog.
//
// The whole reason this port exists is that catalogs disagree about what they
// publish. OpenRouter publishes prices, benchmarks and per-model parameter
// lists. ModelScope publishes an OpenAI-style id list and nothing else. A port
// that pretended otherwise would render "$0.00 / free" for models whose price
// is simply unknown, which is worse than rendering nothing.
//
// Two things carry that weight and neither may be collapsed:
//   1. `tools` is TRI-STATE. null means UNKNOWN, false means CONFIRMED ABSENT.
//   2. `capabilities` is declared up front, so the UI branches on a stated fact
//      rather than sniffing nulls out of the rows.
//
// The nullability below is not decoration. `Pricing | null` means a renderer
// that reaches for `.prompt` without a null check DOES NOT COMPILE, which is
// the single highest-value thing types buy this codebase: the "$0.00 over data
// we do not have" bug is now unreachable rather than merely tested for.

/**
 * Per-token prices in USD. Not per million — core/format.ts scales for display.
 *
 * `cacheRead` is separately nullable INSIDE a non-null Pricing: a catalog can
 * know a model's prompt and completion price while the provider simply does no
 * prompt caching. That is a different fact from "this catalog publishes no
 * prices at all", which is `Pricing | null` on the model.
 */
export type Pricing = {
  prompt: number
  completion: number
  /** null = provider does no prompt caching */
  cacheRead: number | null
}

/**
 * Third-party benchmark scores. Every field independently nullable: a catalog
 * that publishes a benchmarks object at all may still be missing any one index.
 */
export type Benchmarks = {
  intelligence: number | null
  coding: number | null
  agentic: number | null
}

/**
 * One row, after the adapter has normalized whatever the upstream JSON looked
 * like. Everything a catalog might not publish is nullable, and nothing is
 * defaulted to a number that would read as fact.
 */
export type NormalizedModel = {
  id: string
  name: string
  description?: string
  /** null = UNKNOWN. ModelScope publishes no context length. */
  context: number | null
  maxOutput: number | null
  /** null = this catalog publishes NO pricing. Never 0, which means free. */
  pricing: Pricing | null
  /** null = this catalog publishes NO benchmarks. */
  benchmarks: Benchmarks | null
  /** TRI-STATE. null = UNKNOWN, false = CONFIRMED ABSENT. Do not collapse. */
  tools: boolean | null
  /** TRI-STATE, same rule as `tools`. */
  reasoning: boolean | null
  extendedContext?: boolean
}

/**
 * What this catalog is able to publish AT ALL, declared up front.
 *
 * This is what lets the picker branch on a stated fact instead of inferring
 * from a page of nulls — and what makes a filter inert rather than wrong:
 * defaulting the tools filter on against a catalog with no parameter list would
 * empty the list entirely. See core/catalog.ts `filterModels`.
 */
export type CatalogCapabilities = {
  pricing: boolean
  benchmarks: boolean
  /**
   * false => `tools` is null for all rows except hand-confirmed deny-list
   * entries.
   */
  toolSupportKnown: boolean
  requiresAuth: boolean
}

/**
 * The four facts a `list()` call reports. `models` is always an array — never
 * null — because "no models" and "failed" are already distinguished by `error`.
 */
export type CatalogResult = {
  models: NormalizedModel[]
  fromCache: boolean
  /** served from cache because the refetch failed */
  stale: boolean
  /** null = no error. Present alongside models when a stale cache was served. */
  error: string | null
}

export type CatalogListOptions = {
  /** bypass a fresh cache and refetch */
  force?: boolean
}

/**
 * `list()` NEVER throws. An offline box with a warm cache still gets a working
 * picker; a cold one gets an empty list plus an error string to display.
 *
 * That contract is why the return type has an `error` field instead of the
 * method being allowed to reject: a thrown error would have to be caught at
 * every call site, and one missed catch takes down the wizard.
 */
export type ModelCatalogPort = {
  id: string
  label: string
  capabilities: CatalogCapabilities
  list: (opts?: CatalogListOptions) => Promise<CatalogResult>
}

/**
 * Lazy, memoized lookup over the catalog adapters.
 *
 * `byId` returns null for an unknown id — a provider whose `catalogId` is null
 * (most of them) asks for exactly that, so it is a normal state, not an error.
 */
export type CatalogRegistryPort = {
  ids: () => readonly string[]
  has: (id: string) => boolean
  byId: (id: string | null | undefined) => ModelCatalogPort | null
}

/**
 * On-disk cache behind a network catalog.
 *
 * NOTE: this is a port that already existed in the code without a port file —
 * adapters/store/fs-cache-store.js implements it and adapters/catalog/
 * cached-catalog.js consumes it. It is written down here rather than invented:
 * the shape below is read off those two modules. It lives in this file because
 * a catalog is its only consumer.
 *
 * A cache entry is ATTACKER-ADJACENT DATA — a plain JSON file in the user's
 * config dir whose `id` flows into config.json and from there into
 * ANTHROPIC_DEFAULT_*_MODEL. That is why `read` is typed as returning unknown
 * payloads rather than `NormalizedModel[]`: the adapter checks the cache
 * VERSION and that `models` is an array, and nothing else. Every row is
 * re-validated by core/catalog.ts `sanitizeModels` before use, and `fetchedAt`
 * is re-validated by `isStale`, which treats anything that is not a sane past
 * timestamp as stale. Typing this as trusted data would erase exactly the
 * checks that make it safe.
 */
export type CatalogCacheEntry = {
  models: unknown[]
  fetchedAt: unknown
}

export type ModelCacheStorePort = {
  read: (id: string) => CatalogCacheEntry | null
  /** Best-effort. A read-only config dir must not break the picker. Never throws. */
  write: (id: string, models: NormalizedModel[]) => void
  path: (id: string) => string
}

export {}
