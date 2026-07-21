// Provider registry. Each entry describes how to point Claude Code at a
// backend: which base URL, which env var carries the credential, sensible
// default models, and any provider-specific env quirks.
//
// In `env`, an empty string means "unset this variable" rather than "set it to
// empty" — OpenRouter needs ANTHROPIC_API_KEY out of the way entirely.

export const PROVIDERS = [
  {
    id: 'anthropic',
    label: 'Anthropic (direct)',
    baseUrl: null,
    keyEnv: 'ANTHROPIC_API_KEY',
    keyOptional: true,
    keyHint: 'leave blank to keep using your existing claude login',
    models: { opus: '', sonnet: '', haiku: '' },
    modelHint: 'blank = let Claude Code choose its own defaults',
    env: {},
  },
  {
    id: 'zai',
    label: 'z.ai (GLM)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    keyEnv: 'ANTHROPIC_AUTH_TOKEN',
    models: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.2' },
    env: { API_TIMEOUT_MS: '3000000' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api',
    keyEnv: 'ANTHROPIC_AUTH_TOKEN',
    models: {
      opus: 'openrouter/fusion',
      sonnet: 'openrouter/fusion',
      haiku: 'openrouter/fusion',
    },
    env: {
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1',
    },
    // OpenRouter has no notion of the opus/sonnet/haiku tiers, so subagents
    // need to be pinned explicitly or they fall back to a model that 404s.
    subagentFollowsOpus: true,
  },
  {
    id: 'custom',
    label: 'Custom (any Anthropic-compatible endpoint)',
    baseUrl: '',
    askBaseUrl: true,
    keyEnv: 'ANTHROPIC_AUTH_TOKEN',
    models: { opus: '', sonnet: '', haiku: '' },
    env: {},
  },
]

export function byId(id) {
  return PROVIDERS.find((p) => p.id === id) ?? null
}
