import type { ProviderDescriptor } from '../../ports/provider.ts'

/**
 * `satisfies`, not `: ProviderDescriptor`.
 *
 * Both check conformance; `satisfies` additionally keeps the literal types, so
 * `anthropic.credentialEnv` stays `'ANTHROPIC_API_KEY'` rather than widening to
 * the union, and `defaultModels` keeps its exact keys. An annotation would
 * throw that away for no gain — the checking is identical either way.
 */
export const anthropic = {
  id: 'anthropic',
  label: 'Anthropic (direct)',
  // null, not '' — this actively CLEARS ANTHROPIC_BASE_URL. Picking
  // "Anthropic (direct)" while a gateway URL sits in your shell has to mean
  // Anthropic direct, not "Anthropic unless something else got there first".
  baseUrl: null,
  credentialEnv: 'ANTHROPIC_API_KEY',
  credentialOptional: true,
  // No defaults: every tier variable is cleared so Claude Code uses its own.
  defaultModels: {},
  catalogId: null,
  hints: {
    keyHint: 'leave blank to keep using your existing claude login',
    modelHint: 'blank = let Claude Code choose its own defaults',
  },
} satisfies ProviderDescriptor
