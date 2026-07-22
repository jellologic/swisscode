// Shared lowering for the non-Claude-Code agents.
//
// Kilo and OpenCode both reach a provider through the AI SDK's Anthropic
// provider (@ai-sdk/anthropic) pointed at a custom baseURL + apiKey — which is
// exactly what every swisscode provider preset already is (an Anthropic-
// compatible endpoint). Registering it under our own provider KEY with an
// explicit model declaration means any model id works, claude-shaped or not
// (glm-5.2, qwen-*), instead of relying on each CLI's built-in model list.
//
// Every string a CLI's config schema pins is a named constant here or in the
// adapter, so verifying against a live CLI is a one-line change with a test to
// catch it.

import { TIERS } from '../../core/tiers.ts'
import type { EnvWarning, LaunchIntent } from '../../ports/agent.ts'
import type { Tier } from '../../ports/provider.ts'

/** The AI SDK package both CLIs load for an Anthropic-compatible endpoint. */
export const ANTHROPIC_SDK_NPM = '@ai-sdk/anthropic'

/** The provider key we register under, so a model reads `swisscode/<id>`. */
export const PROVIDER_KEY = 'swisscode'

export type AnthropicOptions = { baseURL?: string; apiKey?: string }

/** The `options` block for the generated provider. Omits what the intent clears. */
export function anthropicOptions(intent: LaunchIntent): AnthropicOptions {
  const options: AnthropicOptions = {}
  if (intent.baseUrl) options.baseURL = intent.baseUrl
  if (intent.credential) options.apiKey = intent.credential
  return options
}

/** A provider `models` map declaring each referenced id, so the CLI resolves it. */
export function modelsBlock(ids: Array<string | undefined>): Record<string, { name: string }> {
  const out: Record<string, { name: string }> = {}
  for (const id of ids) {
    if (id && !(id in out)) out[id] = { name: id }
  }
  return out
}

/** `swisscode/<id>` — how both CLIs reference a model on a named provider. */
export function modelRef(id: string): string {
  return `${PROVIDER_KEY}/${id}`
}

/**
 * Warn when the agent has fewer model slots than the profile pinned — never
 * silently drop (issue #19). `keptTiers[0]` is the primary; a dropped tier only
 * warns if it pins a DIFFERENT model, since collapsing four identical ids to one
 * loses nothing.
 */
export function collapsedTierWarning(
  intent: LaunchIntent,
  keptTiers: Tier[],
  agentLabel: string,
): EnvWarning | null {
  const primaryTier = keptTiers[0]
  const primary = primaryTier ? intent.models[primaryTier] : undefined
  const dropped = TIERS.filter((t) => !keptTiers.includes(t))
  const distinct = dropped.filter((t) => intent.models[t] && intent.models[t] !== primary)
  if (distinct.length === 0) return null
  return {
    severity: 'medium',
    code: 'tier-collapsed',
    message:
      `${agentLabel} does not use the four-tier model. ` +
      (primary ? `Using '${primary}' for ${keptTiers.join('/')}; ` : '') +
      `these pinned tiers are ignored: ${distinct
        .map((t) => `${t}=${intent.models[t]}`)
        .join(', ')}.`,
  }
}

/**
 * Warn when a 1M-capable provider is reached without Claude Code's `[1m]`
 * signal, which only Claude Code sends. The model still runs; its window is
 * whatever the endpoint serves by default.
 */
export function extendedContextWarning(
  intent: LaunchIntent,
  primary: string | undefined,
  agentLabel: string,
): EnvWarning | null {
  const ec = intent.extendedContext
  if (!ec?.supported || !primary || !ec.models?.includes(primary)) return null
  const window = ec.window ? `${Math.round(ec.window / 1000)}K` : 'wider'
  return {
    severity: 'medium',
    code: 'extended-context-unavailable',
    message:
      `${agentLabel} reaches '${primary}' at its standard context window. The ` +
      `extended (${window}) window this provider offers is negotiated through a ` +
      `Claude-Code-specific model suffix that ${agentLabel} does not send.`,
  }
}
