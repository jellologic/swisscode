import type { ProviderDescriptor } from '../../ports/provider.ts'

/**
 * Ollama's hosted models, at ollama.com.
 *
 * Same Anthropic Messages API as the local server, with one difference that
 * decides this descriptor: the cloud endpoint authenticates, and as of
 * ollama/ollama#16922 it accepts ONLY `Authorization: Bearer <key>` — the
 * x-api-key header Anthropic's own API uses is not honoured yet (a fix is in
 * flight). ANTHROPIC_AUTH_TOKEN is the spelling that produces a bearer header,
 * so this works today; ANTHROPIC_API_KEY would not.
 */
export const ollamaCloud = {
  id: 'ollama-cloud',
  label: 'Ollama Cloud',
  // Bare host again: the documented endpoint is https://ollama.com/v1/messages.
  baseUrl: 'https://ollama.com',
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  // A real key, unlike the local server. Left unset deliberately — a
  // defaultCredential here would turn "you forgot your key" into a 401 much
  // further downstream.
  defaultModels: {},
  subagentFollowsOpus: true,
  // The local /api/tags catalog lists what THIS machine has pulled, which says
  // nothing about the hosted line-up, and the cloud listing needs the
  // credential the catalog layer has no way to pass. Typing the id is honest;
  // a picker showing the wrong list is not.
  catalogId: null,
  hints: {
    keyHint: 'an Ollama API key from ollama.com — sent as a bearer token',
    modelHint: 'cloud model ids carry a :cloud suffix, e.g. glm-4.7:cloud',
    note:
      'Cloud models run at the window the service provides, so the local ' +
      'OLLAMA_CONTEXT_LENGTH setting does not apply here.',
  },
} satisfies ProviderDescriptor
