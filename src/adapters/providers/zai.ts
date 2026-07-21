import type { ProviderDescriptor } from '../../ports/provider.ts'

export const zai = {
  id: 'zai',
  label: 'z.ai (GLM)',
  baseUrl: 'https://api.z.ai/api/anthropic',
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  // BARE ids. The [1m] suffix is derived from extendedContext below, per
  // variable, by core/context.ts — never typed here.
  defaultModels: {
    opus: 'glm-5.2',
    sonnet: 'glm-5.2',
    haiku: 'glm-5.2',
    fable: 'glm-5.2',
  },
  // THE LIVE BUG THIS PHASE EXISTS TO FIX. Shipping bare `glm-5.2` ran every
  // tier at the standard window: Claude Code assumes 200K for any base URL that
  // is not first-party, and the documented way to say otherwise is the [1m]
  // suffix on the model id. That suffix is read per ANTHROPIC_DEFAULT_*_MODEL
  // variable, so declaring the capability once here and deriving it in the tier
  // loop is what makes "three tiers suffixed, one forgotten" unreachable.
  extendedContext: {
    supported: true,
    models: ['glm-5.2'],
    window: 1_000_000,
  },
  env: { API_TIMEOUT_MS: '3000000' },
  catalogId: null,
} satisfies ProviderDescriptor
