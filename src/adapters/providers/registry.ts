import type { ProviderDescriptor, ProviderRegistryPort } from '../../ports/provider.ts'
import { anthropic } from './anthropic.ts'
import { zai } from './zai.ts'
import { openrouter } from './openrouter.ts'
import { modelscope } from './modelscope.ts'
import { siliconflow } from './siliconflow.ts'
import { ollama } from './ollama.ts'
import { ollamaCloud } from './ollama-cloud.ts'
import { custom } from './custom.ts'

/**
 * Order is the order the wizard offers them in.
 *
 * `readonly`, because Object.freeze actually froze it. The previous annotation
 * said `ProviderDescriptor[]` (mutable) and nothing checked, so the type and the
 * value had quietly disagreed since the array was written.
 */
export const PROVIDERS: readonly ProviderDescriptor[] = Object.freeze([
  anthropic,
  zai,
  openrouter,
  modelscope,
  siliconflow,
  ollama,
  ollamaCloud,
  custom,
])

export function byId(id: string | null | undefined): ProviderDescriptor | null {
  return PROVIDERS.find((p) => p.id === id) ?? null
}

/**
 * `satisfies`, so the port conformance is asserted HERE, at the definition,
 * rather than only where a consumer happens to annotate. Drift between this
 * object and `ProviderRegistryPort` is now a compile error in this file.
 */
export const registry = Object.freeze({
  all: () => PROVIDERS,
  byId,
}) satisfies ProviderRegistryPort

/** A provider that was investigated and deliberately not shipped. */
export type RejectedProvider = { id: string; reason: string }

/**
 * Providers deliberately NOT shipped, with the reason, so nobody re-adds one
 * from a blog post. Each of these was investigated and rejected on a specific
 * finding, not on a hunch.
 *
 *   iFlow            API keys expire after seven days, and the Anthropic route
 *                    is undocumented and could not be confirmed. A preset whose
 *                    credential dies every week is a support burden, not a
 *                    convenience.
 *
 *   Volcengine       Documentation reportedly warns that driving these
 *                    endpoints from your own scripts risks account suspension.
 *                    Routing could not be confirmed, and the configuration that
 *                    circulates widely is stale. Not worth someone's account.
 *
 *   DeepSeek direct  api.deepseek.com/anthropic returns 400 unknown variant
 *   (api.deepseek   "system" on Claude Code >= 2.1.154: Opus 4.8 emits
 *    .com/anthropic) mid-conversation role:"system" messages that DeepSeek's
 *                    compatibility layer rejects. There is no verified
 *                    workaround — in particular
 *                    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS does NOT fix it,
 *                    since that targets beta headers and tool-schema fields
 *                    rather than the structure of the message array.
 *                    DeepSeek weights reached through OpenRouter are fine.
 */
export const REJECTED_PROVIDERS: Readonly<RejectedProvider[]> = Object.freeze([
  {
    id: 'iflow',
    reason: 'API keys expire after 7 days; the Anthropic route is undocumented and unconfirmed.',
  },
  {
    id: 'volcengine',
    reason:
      'docs reportedly warn that driving these endpoints from your own scripts risks account ' +
      'suspension; routing unconfirmed and the widely-circulated config is stale.',
  },
  {
    id: 'deepseek-direct',
    reason:
      'returns 400 unknown variant "system" on Claude Code >= 2.1.154; no verified workaround. ' +
      'Use DeepSeek weights through OpenRouter instead.',
  },
])
