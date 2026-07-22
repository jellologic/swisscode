// The four model tiers — the NEUTRAL vocabulary a profile uses to pin models.
//
// This table is the whole point. Everything that touches models iterates it, so
// a tier can never be forgotten by omission — the failure mode where three
// tiers are handled by three hand-written `if`s and the fourth quietly isn't.
//
// The env-var NAMES each tier lowers to (ANTHROPIC_DEFAULT_*_MODEL) are Claude
// Code's, and live in the Claude Code adapter (adapters/agents/claude-code/
// tiers.ts). This module stays neutral.

import type { Tier } from '../ports/provider.ts'

export const TIERS = Object.freeze(['opus', 'sonnet', 'haiku', 'fable'] as const)

/**
 * THE 0.1.0 BUG, AS A COMPILE ERROR — the array half.
 *
 * `TIERS` is what every loop in this codebase iterates (the adapter's env-build,
 * args.ts), so a tier present in the `Tier` union and missing from the array
 * would be skipped at launch — the same silent 200K window, wearing a
 * complete-looking table.
 *
 * These two aliases close that in both directions and cost nothing at runtime:
 * `AssertNever` fails to instantiate unless its argument is `never`, so a tier
 * missing from the array, or a typo'd entry that is not a tier, stops the
 * project compiling. Pure type level; erased entirely.
 */
type AssertNever<T extends never> = T
type _EveryTierIsListed = AssertNever<Exclude<Tier, (typeof TIERS)[number]>>
type _EveryEntryIsATier = AssertNever<Exclude<(typeof TIERS)[number], Tier>>

export function isTier(name: string): name is Tier {
  // `readonly Tier[]`.includes(string) is rejected by design (TS#26255): the
  // array's element type narrows the parameter, so the very call that would
  // WIDEN a string into a tier cannot be made. Widening the READ side to
  // `readonly string[]` is an ordinary assignment — no assertion, no `as` — and
  // `includes` keeps exactly its original semantics.
  const names: readonly string[] = TIERS
  return names.includes(name)
}

/**
 * Only the four tier keys, in canonical order, dropping undefined/null.
 *
 * The parameter is the DECLARED v1 shape rather than `unknown`. This function
 * filters KEYS, not values — it has never validated that a value is a string —
 * so typing it as though it did would be a claim the compiler then enforces on
 * every caller. The place that decides an unvalidated JSON blob may be called a
 * `ConfigV1` is `isV1` in migrate.ts, and it is documented there.
 */
export function pickTiers(
  models: Partial<Record<Tier, string>> | null | undefined,
): Partial<Record<Tier, string>> {
  const out: Partial<Record<Tier, string>> = {}
  if (!models || typeof models !== 'object') return out
  for (const tier of TIERS) {
    const v = models[tier]
    if (v !== undefined && v !== null) out[tier] = v
  }
  return out
}
