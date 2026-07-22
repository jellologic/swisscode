import type { ProviderDescriptor } from '../../ports/provider.ts'

/**
 * Ollama, running on this machine.
 *
 * Ollama v0.14.0+ implements the Anthropic Messages API directly — this is a
 * native endpoint, not an OpenAI shim being translated. Verified against 0.32.0:
 * POST /v1/messages returns a genuine Anthropic error envelope
 * (`{"type":"error","error":{"type":"not_found_error",…},"request_id":"req_…"}`),
 * and tool calling plus streaming are both supported, which is the hard
 * requirement — Claude Code cannot operate without tools.
 */
export const ollama = {
  id: 'ollama',
  label: 'Ollama (local)',
  // BARE HOST. Ollama's docs write the endpoint as /v1/messages, so the /v1
  // belongs to the path Claude Code appends, not here — the same trap
  // ModelScope and SiliconFlow carry. http://, and deliberately: the cleartext
  // guard in core/url-safety.ts exempts loopback, so this warns for nobody
  // while a remote http:// Ollama still does.
  baseUrl: 'http://localhost:11434',
  credentialEnv: 'ANTHROPIC_AUTH_TOKEN',
  // Verified on 0.32.0: no auth header, a wrong key, and an Authorization
  // bearer token all produce identical responses. Local Ollama does not check
  // the credential at all — so asking the user for one would be theatre.
  credentialOptional: true,
  // …but the variable still has to carry something, which is what Ollama's own
  // Claude Code guide is really saying when it tells you to export
  // ANTHROPIC_AUTH_TOKEN=ollama. The descriptor supplies it so the user does
  // not store a fake secret in config.json.
  defaultCredential: 'ollama',
  // No presets. Which models exist is a property of what this user has pulled,
  // which is exactly what the catalog below answers — a baked-in default would
  // name a model most people do not have and 404.
  defaultModels: {},
  // The one compat flag with a symptom that names this case outright: "stalls
  // on slow or locally hosted models". A 30B model on consumer hardware can sit
  // well past the default idle timeout before its first token.
  compat: { forceIdleTimeoutOff: true },
  // Ollama has no notion of the four tiers, so a subagent would otherwise ask
  // for a model this machine has not pulled.
  subagentFollowsOpus: true,
  // NO extendedContext. Ollama's window is whatever the user configured, not a
  // property of the model id, so there is nothing here to declare — see the
  // note below, which is the real story.
  catalogId: 'ollama',
  hints: {
    keyHint: 'leave blank — a local Ollama ignores the credential entirely',
    modelHint: 'must support tool calling, or Claude Code cannot work at all',
    note:
      'The window Ollama serves is set by the SERVER (OLLAMA_CONTEXT_LENGTH, or a ' +
      'Modelfile `PARAMETER num_ctx` that overrides it), not by the model id — and ' +
      'Claude Code assumes 200K regardless. Nothing errors when they disagree; the ' +
      'model just silently forgets the start of the conversation. Run ' +
      '`swisscode config doctor`, which reads the window actually loaded and warns ' +
      'below 32K. swisscode never guesses it at launch, because a window set too ' +
      'large means the conversation overflows instead of compacting.',
  },
} satisfies ProviderDescriptor
