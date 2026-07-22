// Per-run profile overrides.
//
// INVARIANT: this path never writes. Overrides produce a modified copy that
// lives for exactly one launch; the only writers in the codebase are the wizard
// and the `config *` subcommands. test/core/overrides.test.ts asserts zero
// store writes across a matrix of override shapes.
//
// The `--cc-*` PARSER that produces these override objects belongs to the UX
// phase. The merge itself is pure and lands here now.

import { TIERS, isTier } from './tiers.ts'
import type { Profile, ProfileOverrides, State } from '../ports/config-store.ts'
import type { ProviderDescriptor, Tier } from '../ports/provider.ts'
import type { EnvMap } from '../ports/process.ts'

/**
 * Returns a NEW profile; the input is never mutated.
 *
 * `profile` is a plain `Profile`, not nullable: both call sites (launch-root
 * and doctor-root) refuse to proceed when selection produced no profile, so the
 * `?? {}` below is defence rather than a supported mode. A `Profile | null`
 * signature would push a phantom null through every consumer downstream.
 */
export function applyOverrides(profile: Profile, overrides: ProfileOverrides = {}): Profile {
  const next = structuredClone(profile ?? {})

  if (typeof overrides.provider === 'string') next.provider = overrides.provider
  if (typeof overrides.agent === 'string') next.agent = overrides.agent
  if (typeof overrides.baseUrl === 'string') next.baseUrl = overrides.baseUrl

  if (overrides.models !== undefined) {
    // A bare `--cc-model X` sets ALL FOUR tiers, deliberately. `[1m]` is read
    // per variable, so a one-tier override is the exact shape of the silent
    // 200K bug. The safe thing should be the easy thing.
    if (typeof overrides.models === 'string') {
      const all = overrides.models
      next.models = Object.fromEntries(TIERS.map((t): [Tier, string] => [t, all]))
    } else if (overrides.models && typeof overrides.models === 'object') {
      const models: Partial<Record<Tier, string>> = { ...(next.models ?? {}) }
      for (const [tier, value] of Object.entries(overrides.models)) {
        // The type guard is what makes `models[tier]` legal on the next line:
        // `tier` arrives from Object.entries as a plain string, and only a real
        // tier may index the record.
        if (!isTier(tier)) continue
        models[tier] = value
      }
      next.models = models
    }
  }

  if (overrides.env && typeof overrides.env === 'object') {
    // Merged AFTER profile.env, and '' still means UNSET.
    next.env = { ...(next.env ?? {}), ...overrides.env }
  }

  return next
}

/**
 * Never send a credential to a host it was not entered for.
 *
 * Order: keep the key when the provider is unchanged; otherwise borrow the
 * credential and base URL from another profile that already uses the target
 * provider; otherwise accept one already present in the ambient env; otherwise
 * refuse. There is no "just send the key we have" branch — that is how a z.ai
 * token ends up POSTed to OpenRouter.
 *
 * MODEL IDS ARE DROPPED for the same reason the credential is. `glm-5.2` was
 * chosen for z.ai; forwarding it to OpenRouter is a guaranteed 404 wearing the
 * costume of a working config. Clearing them lets the target provider's own
 * defaults apply, and a `--cc-model` on the same command line still wins
 * because it is merged after this runs.
 */
export function retargetProvider(
  profile: Profile,
  targetProviderId: string | null | undefined,
  state: State | null | undefined,
  descriptor: ProviderDescriptor | null | undefined,
  ambientEnv: EnvMap = {},
): { ok: true; profile: Profile; borrowedFrom: string | null } | { ok: false; reason: string } {
  if (!targetProviderId || profile?.provider === targetProviderId) {
    return { ok: true, profile, borrowedFrom: null }
  }

  const next = structuredClone(profile ?? {})
  next.provider = targetProviderId
  delete next.baseUrl
  delete next.models
  // Keyed by model id from the old provider's catalog, so meaningless here.
  delete next.contextWindows

  for (const [name, candidate] of Object.entries(state?.profiles ?? {})) {
    if (candidate?.provider !== targetProviderId) continue
    if (!candidate.apiKey && !candidate.apiKeyFromEnv) continue
    delete next.apiKey
    delete next.apiKeyFromEnv
    if (candidate.apiKey) next.apiKey = candidate.apiKey
    if (candidate.apiKeyFromEnv) next.apiKeyFromEnv = candidate.apiKeyFromEnv
    if (candidate.baseUrl) next.baseUrl = candidate.baseUrl
    // That profile is already configured FOR this provider, so its models are
    // the best available answer — better than the descriptor defaults.
    if (candidate.models) next.models = structuredClone(candidate.models)
    if (candidate.contextWindows) next.contextWindows = structuredClone(candidate.contextWindows)
    return { ok: true, profile: next, borrowedFrom: name }
  }

  // The credential variable is the provider's own (ANTHROPIC_AUTH_TOKEN etc.).
  // Its name lives in the descriptor, never spelled here — core stays neutral.
  const credentialEnv = descriptor?.credentialEnv
  if (credentialEnv && ambientEnv[credentialEnv]) {
    delete next.apiKey
    next.apiKeyFromEnv = credentialEnv
    return { ok: true, profile: next, borrowedFrom: null }
  }

  if (descriptor?.credentialOptional) {
    delete next.apiKey
    delete next.apiKeyFromEnv
    return { ok: true, profile: next, borrowedFrom: null }
  }

  return {
    ok: false,
    reason:
      `no credential for provider "${targetProviderId}". The current profile's key was ` +
      `entered for "${profile?.provider}" and will not be sent somewhere else. Add a ` +
      `profile for "${targetProviderId}"` +
      (credentialEnv ? `, or set ${credentialEnv} in your environment.` : '.'),
  }
}
