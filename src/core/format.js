// Display formatting. Pure, so the picker's rendering rules are testable
// without a terminal.

/** Per-token USD -> a per-million-token string. `null` is UNKNOWN, not free. */
export function formatPrice(perToken) {
  if (perToken === null || perToken === undefined) return '—'
  if (!Number.isFinite(perToken)) return '—'
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

/** Rough cost of one exchange, for the picker's summary line. */
export function formatCost(pricing, { promptTokens = 100_000, completionTokens = 2_000 } = {}) {
  if (!pricing) return null
  const total = pricing.prompt * promptTokens + pricing.completion * completionTokens
  if (!Number.isFinite(total)) return null
  if (total === 0) return 'free'
  return total < 0.01 ? `<$0.01` : `$${total.toFixed(2)}`
}

/** Tri-state tool support -> a label. Unknown and confirmed-absent differ. */
export function formatToolSupport(tools) {
  if (tools === true) return 'tools'
  if (tools === false) return 'no tools'
  return 'tools unknown'
}
