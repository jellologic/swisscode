// Claude Code's four model tiers and the env var that carries each one.
//
// This table is the whole point. Everything that touches models iterates it, so
// a tier can never be forgotten by omission — the failure mode where three
// tiers are handled by three hand-written `if`s and the fourth quietly isn't.

import type { Tier, TierRecord } from '../ports/provider.ts'

export const TIERS = Object.freeze(['opus', 'sonnet', 'haiku', 'fable'] as const)

/**
 * THE 0.1.0 BUG, AS A COMPILE ERROR — the array half.
 *
 * `TIER_ENV` below is a `TierRecord`, so dropping a key from IT is already
 * rejected. But `TIERS` is what every loop in this codebase actually iterates
 * (env.ts, args.ts, doctor.ts), so a tier present in the record and missing
 * from the array would still be skipped at launch — the same silent 200K
 * window, wearing a complete-looking table.
 *
 * These two aliases close that in both directions and cost nothing at runtime:
 * `AssertNever` fails to instantiate unless its argument is `never`, so a tier
 * missing from the array, or a typo'd entry that is not a tier, stops the
 * project compiling. Pure type level; erased entirely.
 */
type AssertNever<T extends never> = T
type _EveryTierIsListed = AssertNever<Exclude<Tier, (typeof TIERS)[number]>>
type _EveryEntryIsATier = AssertNever<Exclude<(typeof TIERS)[number], Tier>>

/**
 * `satisfies`, not a type annotation: it enforces exhaustiveness over `Tier` —
 * a missing tier is an error HERE, at the declaration, rather than in a distant
 * conformance file — while still inferring each value's literal type, so
 * `TIER_ENV[tier]` stays a known variable name instead of widening to `string`.
 */
export const TIER_ENV = Object.freeze({
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
}) satisfies TierRecord<string>

export const TIER_ENV_VARS = Object.freeze(TIERS.map((t) => TIER_ENV[t]))

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
