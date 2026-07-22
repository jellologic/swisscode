// Extended-context model-id suffix — Claude Code's `[1m]` mechanism.
//
// Claude Code reads `[1m]` PER ENV VARIABLE, not per model. A config that
// suffixes three tiers and forgets the fourth runs that fourth tier at the
// assumed window with no error and no warning. That is why nothing in this
// codebase types the suffix by hand: descriptors carry bare ids plus a list of
// which of them genuinely support the wider window, and the suffix is derived
// here, for every tier, from that one list.
//
// This is Claude-Code-shaped (the `[1m]` spelling is a client-side signal), so
// it lives in the adapter. The neutral capability declaration it reads
// (`ExtendedContext`) stays in ports/provider.ts.

import type { ExtendedContext } from '../../../ports/provider.ts'

export const SUFFIX = '[1m]'

/**
 * What `Number.isFinite` already guarantees, said in a way the compiler can
 * use. `typeof v === 'number' && Number.isFinite(v)` is EXACTLY the same runtime
 * test; the only thing gained is narrowing, without which every window lookup
 * below stays `number | undefined` and the `> 0` comparison does not compile.
 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Strip the suffix if present. Safe on ids that never had it.
 *
 * The `typeof` guard is unreachable through the types — every caller holds a
 * `string` by this point — but it is the last line of defence for a hand-edited
 * config whose model id is not a string (see the note on `isV1` in migrate.ts).
 */
export function bareModelId(modelId: string): string {
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
 * OVERLOADED because this function RETURNS WHAT IT WAS GIVEN when the input is
 * not a usable id: null in, null out; undefined in, undefined out. Collapsing
 * that into one nullable return type would push a `null` that cannot actually
 * occur into `ResolvedModels`, whose values are `string | undefined`, and the
 * only ways to silence THAT would be a cast or a runtime `?? undefined`. The
 * overloads state the real contract instead, and erase to nothing.
 */
export function withExtendedContext(modelId: string, ec?: ExtendedContext | null): string
export function withExtendedContext(
  modelId: string | undefined,
  ec?: ExtendedContext | null,
): string | undefined
export function withExtendedContext(
  modelId: string | null | undefined,
  ec?: ExtendedContext | null,
): string | null | undefined
export function withExtendedContext(
  modelId: string | null | undefined,
  ec?: ExtendedContext | null,
): string | null | undefined {
  if (!modelId || typeof modelId !== 'string') return modelId
  const bare = bareModelId(modelId)
  if (!ec?.supported) return bare
  return ec.models?.includes(bare) ? bare + SUFFIX : bare
}

/** Does this provider claim the wider window for this bare id? */
export function supportsExtendedContext(
  modelId: string | null | undefined,
  ec?: ExtendedContext | null,
): boolean {
  if (!modelId || !ec?.supported) return false
  return Boolean(ec.models?.includes(bareModelId(modelId)))
}

/**
 * The real context window for one model, in tokens, or null for UNKNOWN.
 *
 * Two sources, most-specific first, and NEITHER of them guesses:
 *
 *   1. `knownWindows` — captured from a catalog's published context_length at
 *      the moment the user picked the model, and stored on the profile.
 *   2. `extendedContext` — the documented window for a model the descriptor
 *      explicitly declares as extended-context capable.
 *
 * A model absent from both is UNKNOWN and stays UNKNOWN. Returning a default
 * here would be guessing, and a guessed window that is too large silently
 * defeats auto-compaction — the conversation overflows instead of summarising.
 */
export function contextWindowFor(
  modelId: string | null | undefined,
  ec?: ExtendedContext | null,
  knownWindows?: Record<string, number> | null,
): number | null {
  if (!modelId || typeof modelId !== 'string') return null
  const bare = bareModelId(modelId)

  const captured = knownWindows?.[bare]
  if (isFiniteNumber(captured) && captured > 0) return captured

  if (supportsExtendedContext(bare, ec)) {
    const perModel = ec?.windows?.[bare]
    if (isFiniteNumber(perModel) && perModel > 0) return perModel
    if (isFiniteNumber(ec?.window) && ec.window > 0) return ec.window
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
 */
export function autoCompactWindow(
  resolvedModels: Record<string, string | undefined> | null | undefined,
  ec?: ExtendedContext | null,
  knownWindows?: Record<string, number> | null,
): number | null {
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
