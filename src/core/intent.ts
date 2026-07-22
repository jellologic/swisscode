// Build the neutral LaunchIntent from (profile, provider, ambient).
//
// This is the core's whole contribution to a launch: resolve WHAT to run —
// endpoint, credential, per-tier models, permissions — without naming a single
// agent-specific variable. Each agent adapter lowers this into its own CLI.
//
// Pure and neutral: it names no ANTHROPIC_*/CLAUDE_CODE_* variable. The one
// Claude-Code artifact it knows about is the `[1m]` extended-context marker,
// which a hand-edited config might carry on a stored id; it is stripped here so
// the neutral intent hands every adapter a bare model id. (The Claude Code
// adapter re-derives the suffix itself from provider.extendedContext.)

import { TIERS } from './tiers.ts'
import { definedEntriesOf, resolveCredential } from './env-plan.ts'
import type { LaunchIntent } from '../ports/agent.ts'
import type { Profile } from '../ports/config-store.ts'
import type { ProviderDescriptor, Tier, TierRecord } from '../ports/provider.ts'
import type { EnvMap } from '../ports/process.ts'

const EXTENDED_MARKER = '[1m]'

function stripExtendedMarker(id: string | undefined): string | undefined {
  if (typeof id !== 'string') return id
  return id.endsWith(EXTENDED_MARKER) ? id.slice(0, -EXTENDED_MARKER.length) : id
}

export type IntentOptions = {
  /** --yolo/--safe for this run; folded in over the profile's skipPermissions. */
  skipOverride?: boolean | null
}

export function buildIntent(
  profile: Profile | null | undefined,
  provider: ProviderDescriptor | null | undefined,
  ambientEnv: EnvMap = {},
  opts: IntentOptions = {},
): LaunchIntent {
  // Same overlay as the Claude Code env-build: provider defaults, then the
  // profile's pins. `models` is exhaustive over the tiers, values bare.
  const effective: Partial<Record<Tier, string>> = {
    ...(provider?.defaultModels ?? {}),
    ...definedEntriesOf(profile?.models),
  }
  const models = Object.fromEntries(
    TIERS.map((t) => [t, stripExtendedMarker(effective[t])]),
  ) as TierRecord<string | undefined>

  const intent: LaunchIntent = {
    baseUrl: profile?.baseUrl ?? provider?.baseUrl ?? null,
    // `||`, not `??`: resolveCredential returns '' for "no key", and a keyless
    // provider's placeholder has to fill that. Applied here so every agent gets
    // it — Kilo and OpenCode reach a local endpoint through the same intent.
    credential: resolveCredential(profile, ambientEnv) || (provider?.defaultCredential ?? ''),
    models,
    skipPermissions: opts.skipOverride ?? profile?.skipPermissions ?? false,
    extendedContext: provider?.extendedContext ?? null,
  }
  // Under exactOptionalPropertyTypes, only present it when there is one.
  if (profile?.contextWindows) intent.contextWindows = profile.contextWindows
  return intent
}
