// Claude Code's four model tiers and the env var that carries each one.
//
// This table is the whole point. Everything that touches models iterates it, so
// a tier can never be forgotten by omission — the failure mode where three
// tiers are handled by three hand-written `if`s and the fourth quietly isn't.

/** @type {readonly import('../ports/provider.js').Tier[]} */
export const TIERS = Object.freeze(['opus', 'sonnet', 'haiku', 'fable'])

export const TIER_ENV = Object.freeze({
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
})

export const TIER_ENV_VARS = Object.freeze(TIERS.map((t) => TIER_ENV[t]))

export function isTier(name) {
  return TIERS.includes(name)
}

/** Only the four tier keys, in canonical order, dropping undefined/null. */
export function pickTiers(models) {
  const out = {}
  if (!models || typeof models !== 'object') return out
  for (const tier of TIERS) {
    const v = models[tier]
    if (v !== undefined && v !== null) out[tier] = v
  }
  return out
}
