import { anthropic } from './anthropic.js'
import { zai } from './zai.js'
import { openrouter } from './openrouter.js'
import { modelscope } from './modelscope.js'
import { siliconflow } from './siliconflow.js'
import { custom } from './custom.js'

/**
 * Order is the order the wizard offers them in.
 * @type {import('../../ports/provider.js').ProviderDescriptor[]}
 */
export const PROVIDERS = Object.freeze([
  anthropic,
  zai,
  openrouter,
  modelscope,
  siliconflow,
  custom,
])

export function byId(id) {
  return PROVIDERS.find((p) => p.id === id) ?? null
}

export const registry = Object.freeze({
  all: () => PROVIDERS,
  byId,
})

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
 *
 * @type {Readonly<Array<{id:string,reason:string}>>}
 */
export const REJECTED_PROVIDERS = Object.freeze([
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
