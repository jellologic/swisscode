import type { ProviderDescriptor } from '../../ports/provider.ts'

export const modelscope = {
  id: 'modelscope',
  label: 'ModelScope (魔搭)',
  // BARE HOST. The `/v1` that appears on the same documentation page is the
  // OpenAI-compatible route; appending it here yields /v1/v1/messages.
  baseUrl: 'https://api-inference.modelscope.cn',
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  // No presets: ModelScope's line-up moves, and the public catalog below lets
  // the picker show what is actually being served rather than a guess baked in
  // at release time.
  defaultModels: {},
  catalogId: 'modelscope',
  hints: {
    // Widely repeated advice says to strip the ms- prefix from the token.
    // It is false and it breaks auth.
    keyHint: 'paste the token exactly as issued — keep the ms- prefix',
    modelHint: 'no prompt caching; tool calling varies per model',
    note:
      'A bad token does not return an auth error. Claude Code always streams, ' +
      'and ModelScope answers a bad token with HTTP 200 and an SSE stream that ' +
      'dies silently — it looks like a hang.',
  },
} satisfies ProviderDescriptor
