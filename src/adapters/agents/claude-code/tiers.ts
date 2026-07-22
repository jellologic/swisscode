// Claude Code's per-tier env-var names.
//
// Each of the four neutral tiers (core/tiers.ts) maps 1:1 to one
// ANTHROPIC_DEFAULT_*_MODEL variable. This is Claude-Code-shaped by definition,
// which is why it lives in the adapter and not in core.

import { TIERS } from '../../../core/tiers.ts'
import type { Tier, TierRecord } from '../../../ports/provider.ts'

/**
 * `satisfies`, not a type annotation: it enforces exhaustiveness over `Tier` —
 * a missing tier is an error HERE, at the declaration — while still inferring
 * each value's literal type, so `TIER_ENV[tier]` stays a known variable name
 * instead of widening to `string`.
 */
export const TIER_ENV = Object.freeze({
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
}) satisfies TierRecord<string>

export const TIER_ENV_VARS = Object.freeze(TIERS.map((t: Tier) => TIER_ENV[t]))
