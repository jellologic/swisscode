import type { ProviderDescriptor } from '../../ports/provider.ts'

export const custom = {
  id: 'custom',
  label: 'Custom (any Anthropic-compatible endpoint)',
  baseUrl: null,
  askBaseUrl: true,
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  defaultModels: {},
  catalogId: null,
  hints: {
    modelHint: 'blank = let Claude Code choose its own defaults',
  },
} satisfies ProviderDescriptor
