import type { ProviderDescriptor } from '../../ports/provider.ts'

export const openrouter = {
  id: 'openrouter',
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api',
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  defaultModels: {
    opus: 'openrouter/fusion',
    sonnet: 'openrouter/fusion',
    haiku: 'openrouter/fusion',
    fable: 'openrouter/fusion',
  },
  compat: {
    // fast mode otherwise reports itself "disabled by organization"
    skipFastModeOrgCheck: true,
  },
  // Has a queryable catalog, so the wizard offers a browsable picker instead of
  // asking you to type model ids from memory.
  catalogId: 'openrouter',
  // OpenRouter has no notion of the opus/sonnet/haiku tiers, so subagents need
  // to be pinned explicitly or they fall back to a model that 404s.
  subagentFollowsOpus: true,
} satisfies ProviderDescriptor
