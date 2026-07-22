// Per-run overrides, applied to the RESOLVED profile.
//
// INVARIANT: this path never writes CONFIG. Overrides produce a modified copy
// that lives for exactly one launch; the only config writers in the codebase
// are the wizard and the `config *` subcommands. test/core/overrides.test.ts
// asserts zero `store.save` calls across a matrix of override shapes.
//
// (A round-robin cursor is not config and does not go through the store — see
// core/resolve.ts and adapters/store/fs-cursor-store.ts.)

import { TIERS, isTier } from './tiers.ts'
import type { ProfileOverrides, ResolvedProfile, State } from '../ports/config-store.ts'
import type { ProviderDescriptor, Tier } from '../ports/provider.ts'
import type { EnvMap } from '../ports/process.ts'

/**
 * Returns a NEW resolved profile; the input is never mutated.
 *
 * Operates on the flattened view rather than on stored objects, which is what
 * keeps `--cc-*` from having to know that a profile is now three objects: an
 * override changes what THIS LAUNCH does, not what is filed where.
 */
export function applyOverrides(
  profile: ResolvedProfile,
  overrides: ProfileOverrides = {},
): ResolvedProfile {
  const next = structuredClone(profile ?? {}) as ResolvedProfile

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
    // Merged AFTER the agent profile's env, and '' still means UNSET.
    next.env = { ...(next.env ?? {}), ...overrides.env }
  }

  return next
}

/**
 * Never send a credential to a host it was not entered for.
 *
 * SINCE v3 THIS IS A LOOKUP, NOT A SEARCH — and that change is most of why the
 * schema was split. The v2 version had to rummage through every other profile
 * hoping to find one that happened to hold a key for the target provider, and
 * then copy the key, endpoint and models back out of it. Credentials were
 * trapped inside profiles, so retargeting meant scavenging.
 *
 * Now an account names exactly one provider, so "which credential may go to
 * this host" is `providerAccounts` filtered by `provider`. The safety rule is
 * unchanged and is now STRUCTURAL rather than a copying discipline.
 *
 * Order: keep the account when the provider is unchanged; otherwise adopt an
 * account that already belongs to the target provider; otherwise accept a
 * credential already present in the ambient env; otherwise refuse. There is no
 * "just send the key we have" branch — that is how a z.ai token ends up POSTed
 * to OpenRouter.
 *
 * MODEL IDS ARE DROPPED for the same reason the credential is. `glm-5.2` was
 * chosen for z.ai; forwarding it to OpenRouter is a guaranteed 404 wearing the
 * costume of a working config. Clearing them lets the target provider's own
 * defaults apply, and a `--cc-model` on the same command line still wins
 * because it is merged after this runs.
 */
export function retargetProvider(
  profile: ResolvedProfile,
  targetProviderId: string | null | undefined,
  state: State | null | undefined,
  descriptor: ProviderDescriptor | null | undefined,
  ambientEnv: EnvMap = {},
): {
  ok: true
  profile: ResolvedProfile
  borrowedFrom: string | null
} | { ok: false; reason: string } {
  if (!targetProviderId || profile?.provider === targetProviderId) {
    return { ok: true, profile, borrowedFrom: null }
  }

  const next = structuredClone(profile ?? {}) as ResolvedProfile
  next.provider = targetProviderId
  delete next.baseUrl
  delete next.models
  // Keyed by model id from the old provider's catalog, so meaningless here.
  delete next.contextWindows

  // The lookup the old scavenge was imitating.
  for (const [name, account] of Object.entries(state?.providerAccounts ?? {})) {
    if (account?.provider !== targetProviderId) continue
    if (!account.apiKey && !account.apiKeyFromEnv) continue
    delete next.apiKey
    delete next.apiKeyFromEnv
    if (account.apiKey) next.apiKey = account.apiKey
    if (account.apiKeyFromEnv) next.apiKeyFromEnv = account.apiKeyFromEnv
    if (account.baseUrl) next.baseUrl = account.baseUrl
    next.accountName = name
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
      `no account for provider "${targetProviderId}". The current account's key was ` +
      `entered for "${profile?.provider}" and will not be sent somewhere else. Add an ` +
      `account with \`swisscode config accounts\`` +
      (credentialEnv ? `, or set ${credentialEnv} in your environment.` : '.'),
  }
}
