// Display formatting. Pure, so the picker's rendering rules are testable
// without a terminal.

// `Pricing` is per-token USD, not per million — this module does the scaling.
// It arrives from the port now rather than being mirrored locally: the local
// copy existed only because the architecture test rejected every ".." specifier
// in core/, which that test now decides on the POST-ERASURE graph instead. A
// type-only import is provably not a runtime dependency, so core/ stays as pure
// as it ever was and there is one definition of the shape rather than two.
import type { Pricing } from '../ports/catalog.ts'

type CostTokens = {
  promptTokens?: number
  completionTokens?: number
}

/**
 * Per-token USD -> a per-million-token string. `null` is UNKNOWN, not free.
 * `null | undefined` is in the signature because absent pricing is a real,
 * expected input here, not a defect to be typed away.
 */
export function formatPrice(perToken: number | null | undefined): string {
  if (perToken === null || perToken === undefined) return '—'
  if (!Number.isFinite(perToken)) return '—'
  if (perToken === 0) return 'free'
  const perMillion = perToken * 1e6
  // Sub-cent prices need the extra digits; everything else reads better as
  // plain currency ($0.50, not $0.500).
  return `$${perMillion >= 0.01 ? perMillion.toFixed(2) : perMillion.toFixed(4)}`
}

export function formatContext(n: number | null | undefined): string {
  if (!n) return '—'
  if (n >= 1e6) return `${(n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`
  return String(n)
}

/** Rough cost of one exchange, for the picker's summary line. */
export function formatCost(
  pricing: Pricing | null | undefined,
  { promptTokens = 100_000, completionTokens = 2_000 }: CostTokens = {},
): string | null {
  if (!pricing) return null
  const total = pricing.prompt * promptTokens + pricing.completion * completionTokens
  if (!Number.isFinite(total)) return null
  if (total === 0) return 'free'
  return total < 0.01 ? `<$0.01` : `$${total.toFixed(2)}`
}

/**
 * Tri-state tool support -> a label. Unknown and confirmed-absent differ, and
 * the `boolean | null` parameter is what keeps them from collapsing.
 */
export function formatToolSupport(tools: boolean | null | undefined): string {
  if (tools === true) return 'tools'
  if (tools === false) return 'no tools'
  return 'tools unknown'
}
