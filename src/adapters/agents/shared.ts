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

/**
 * Anthropic ambient variables a non-Anthropic launch must STRIP from the child
 * env. This mirrors the Claude Code adapter's billing guard (env.ts step 4):
 * a custom baseURL means requests are NOT going to api.anthropic.com, so any
 * ANTHROPIC_* credential inherited from the shell must be cleared — otherwise
 * @ai-sdk/anthropic falls back to a real ANTHROPIC_API_KEY in the environment
 * and POSTs it to the third-party endpoint (the tool's highest-cost failure
 * mode). The generated config sets the intended credential itself, so clearing
 * these never removes the one we want.
 */
export const ANTHROPIC_AMBIENT_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const

/** Vars to unset for this launch: the Anthropic ambient set when a baseURL is pinned. */
export function ambientUnset(intent: LaunchIntent): string[] {
  return intent.baseUrl ? [...ANTHROPIC_AMBIENT_VARS] : []
}

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
 * silently drop (issue #19). `keptTiers` may name MORE THAN ONE slot (OpenCode
 * keeps opus->model and haiku->small_model), so a dropped tier is only "ignored"
 * when its model is served by NONE of the kept slots — collapsing tiers onto a
 * model that another kept slot already carries loses nothing.
 */
export function collapsedTierWarning(
  intent: LaunchIntent,
  keptTiers: Tier[],
  agentLabel: string,
): EnvWarning | null {
  const served = new Set(
    keptTiers.map((t) => intent.models[t]).filter((m): m is string => Boolean(m)),
  )
  const dropped = TIERS.filter((t) => !keptTiers.includes(t))
  const distinct = dropped.filter((t) => {
    const m = intent.models[t]
    return Boolean(m) && !served.has(m as string)
  })
  if (distinct.length === 0) return null
  const kept = keptTiers
    .filter((t) => intent.models[t])
    .map((t) => `${t}=${intent.models[t]}`)
    .join(', ')
  return {
    severity: 'medium',
    code: 'tier-collapsed',
    message:
      `${agentLabel} does not use the four-tier model. ` +
      (kept ? `Serving ${kept}; ` : '') +
      `these pinned tiers are ignored: ${distinct
        .map((t) => `${t}=${intent.models[t]}`)
        .join(', ')}.`,
  }
}

/**
 * Warn when a profile carries gateway compatibility flags that this agent does
 * not consume.
 *
 * The compat mechanism is Claude-Code-only (capabilities.compatFlags). A flag
 * toggled on for a Kilo or OpenCode setup changes nothing and, until this
 * existed, said so NOWHERE — not at edit, not at launch, not in the doctor.
 * That is the one capability mismatch with no net, and the
 * capability-gap-never-silently-dropped rule the tier and session warnings
 * already follow says it should have one. The flags are kept, not stripped, so
 * the setup still works when it runs Claude Code again.
 */
export function compatIgnoredWarning(
  compat: Record<string, boolean | undefined> | undefined,
  agentLabel: string,
): EnvWarning | null {
  const active = Object.entries(compat ?? {})
    .filter(([, on]) => on)
    .map(([id]) => id)
  if (active.length === 0) return null
  return {
    severity: 'medium',
    code: 'compat-ignored',
    message:
      `${agentLabel} does not use gateway compatibility flags; these are set but ignored: ` +
      `${active.join(', ')}.`,
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

/**
 * Warn when an account authenticates by SESSION and this agent cannot use one.
 *
 * A session-mode account carries no credential — only a path to a directory
 * where some agent already logged in. Claude Code can be pointed at it;
 * Kilo and OpenCode take their credential inline and have no equivalent, so
 * they would launch with nothing to authenticate with and fail at the first
 * request with a message about the endpoint rather than about the account.
 *
 * `high`, unlike the tier-collapse warning: a collapsed tier still launches
 * something useful, whereas this launch cannot work at all.
 */
export function sessionUnavailableWarning(
  intent: LaunchIntent,
  agentLabel: string,
): EnvWarning | null {
  if (!intent.sessionDir) return null
  return {
    severity: 'high',
    code: 'session-unsupported',
    message:
      `this account authenticates with an existing ${'`claude`'} login (a session directory), ` +
      `and ${agentLabel} cannot use one — it needs a credential of its own. Give the ` +
      `account an API key, or point this profile at an agent that supports sessions.`,
  }
}
