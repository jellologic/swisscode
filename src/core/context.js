// Extended-context model-id suffix.
//
// Claude Code reads `[1m]` PER ENV VARIABLE, not per model. A config that
// suffixes three tiers and forgets the fourth runs that fourth tier at the
// assumed window with no error and no warning. That is why nothing in this
// codebase types the suffix by hand: descriptors carry bare ids plus a list of
// which of them genuinely support the wider window, and the suffix is derived
// here, for every tier, from that one list.

export const SUFFIX = '[1m]'

/** Strip the suffix if present. Safe on ids that never had it. */
export function bareModelId(modelId) {
  if (typeof modelId !== 'string') return modelId
  return modelId.endsWith(SUFFIX) ? modelId.slice(0, -SUFFIX.length) : modelId
}

/**
 * Derive the model id to put in an ANTHROPIC_DEFAULT_*_MODEL variable.
 *
 * Idempotent, and it STRIPS as well as appends: a suffix a user hand-wrote for
 * a provider that does not support the wider window is removed rather than
 * forwarded, because sending an id the endpoint does not know is a hard failure
 * where dropping the suffix is merely a narrower window.
 *
 * Normalization happens here, at the boundary, rather than in stored config —
 * so an existing config file gains the fix at launch with no data rewrite.
 *
 * @param {string|undefined|null} modelId
 * @param {import('../ports/provider.js').ExtendedContext} [ec]
 */
export function withExtendedContext(modelId, ec) {
  if (!modelId || typeof modelId !== 'string') return modelId
  const bare = bareModelId(modelId)
  if (!ec?.supported) return bare
  return ec.models?.includes(bare) ? bare + SUFFIX : bare
}

/** True when every non-empty resolved model got the suffix. */
export function allTiersExtended(resolvedModels, ec) {
  if (!ec?.supported) return false
  const values = Object.values(resolvedModels).filter(Boolean)
  if (values.length === 0) return false
  return values.every((v) => String(v).endsWith(SUFFIX))
}

/** Does this provider claim the wider window for this bare id? */
export function supportsExtendedContext(modelId, ec) {
  if (!modelId || !ec?.supported) return false
  return Boolean(ec.models?.includes(bareModelId(modelId)))
}

/**
 * The real context window for one model, in tokens, or null for UNKNOWN.
 *
 * Two sources, most-specific first, and NEITHER of them guesses:
 *
 *   1. `knownWindows` — captured from a catalog's published context_length at
 *      the moment the user picked the model, and stored on the profile. This is
 *      measured data about the exact endpoint being called.
 *   2. `extendedContext` — the documented window for a model the descriptor
 *      explicitly declares as extended-context capable.
 *
 * A model absent from both is UNKNOWN and stays UNKNOWN. Returning a default
 * here would be guessing, and a guessed window that is too large silently
 * defeats auto-compaction — the conversation overflows instead of summarising.
 *
 * @param {string|undefined|null} modelId
 * @param {import('../ports/provider.js').ExtendedContext} [ec]
 * @param {Record<string,number>} [knownWindows] bare id -> tokens
 * @returns {number|null}
 */
export function contextWindowFor(modelId, ec, knownWindows) {
  if (!modelId || typeof modelId !== 'string') return null
  const bare = bareModelId(modelId)

  const captured = knownWindows?.[bare]
  if (Number.isFinite(captured) && captured > 0) return captured

  if (supportsExtendedContext(bare, ec)) {
    const perModel = ec.windows?.[bare]
    if (Number.isFinite(perModel) && perModel > 0) return perModel
    if (Number.isFinite(ec.window) && ec.window > 0) return ec.window
  }

  return null
}

/**
 * One auto-compact window for a launch that has four tiers but only one
 * variable to say it in.
 *
 * Returns null unless EVERY configured tier has a known window. A partial
 * answer is the dangerous one: taking the min over the tiers we happen to know
 * would quietly apply a small model's window to a large one, or worse, apply a
 * large one to a small one and overflow it.
 *
 * When all four are known, the MINIMUM is the only safe single number — it is
 * the point past which the smallest-context tier starts truncating.
 *
 * @param {Record<string,string>} resolvedModels tier -> model id (may be empty)
 * @returns {number|null}
 */
export function autoCompactWindow(resolvedModels, ec, knownWindows) {
  const configured = Object.values(resolvedModels ?? {}).filter(Boolean)
  if (configured.length === 0) return null

  let min = Infinity
  for (const id of configured) {
    const w = contextWindowFor(id, ec, knownWindows)
    if (w === null) return null // never guess for a model we have no data on
    if (w < min) min = w
  }
  return Number.isFinite(min) ? min : null
}
