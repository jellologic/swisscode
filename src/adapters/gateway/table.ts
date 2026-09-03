// Turning profiles into a routing table.
//
// Pure: no I/O, no sockets. The gateway's whole configuration story is that it
// has none — every row here is derived from the profiles the user already
// maintains, through the same resolution the launcher uses. A second config
// format would be a second thing to keep true.

import { resolveProfileRefs } from '../../core/resolve.ts'
import { buildIntent } from '../../core/intent.ts'
import { TIERS } from '../../core/tiers.ts'
import type { Tier, TierRecord } from '../../ports/provider.ts'
import type { State } from '../../ports/config-store.ts'
import type { ProviderRegistryPort } from '../../ports/provider.ts'
import type { EnvMap } from '../../ports/process.ts'

/** Where the Anthropic API lives when a descriptor declines to say. */
const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com'

export type Route = {
  /** Profile name, used in logs and errors. */
  profile: string
  provider: string
  baseUrl: string
  /**
   * Empty means SESSION mode: the account authenticates with a login rather
   * than a key, so the caller's own credential header is forwarded untouched
   * and the gateway never substitutes one.
   */
  credential: string
  /** Which header carries the credential, when there is one. */
  header: 'x-api-key' | 'authorization'
  models: TierRecord<string | undefined>
}

export type TableResult =
  | { ok: true; routes: Route[] }
  | { ok: false; reason: string }

/**
 * Build the ordered chain: primary first, then each fallback.
 *
 * `cursor` is deliberately not threaded through. `resolveProfileRefs` advances
 * a round-robin cursor as a side effect of resolving, so passing one here would
 * rotate every account each time the table is built — once at startup, and
 * again on any future rebuild — silently changing which account a launch would
 * have used.
 */
export function buildTable(
  state: State,
  registry: ProviderRegistryPort,
  names: string[],
  ambientEnv: EnvMap = {},
): TableResult {
  if (names.length === 0) return { ok: false, reason: 'no profile named.' }

  const routes: Route[] = []
  for (const name of names) {
    const resolution = resolveProfileRefs(state, name)
    if (!resolution.ok) return { ok: false, reason: resolution.reason }

    const descriptor = registry.byId(resolution.resolved.provider)
    if (!descriptor) {
      return {
        ok: false,
        reason: `profile "${name}" uses provider "${resolution.resolved.provider}", which is not registered.`,
      }
    }

    const intent = buildIntent(resolution.resolved, descriptor, ambientEnv)

    // A null baseUrl means "the provider's own default endpoint", which for
    // Anthropic is the only case that reaches here — every other descriptor
    // states its host. The launcher expresses this by leaving the variable
    // unset; a proxy has to name the host it will actually dial.
    const baseUrl = intent.baseUrl ?? ANTHROPIC_DEFAULT_BASE

    routes.push({
      profile: name,
      provider: resolution.resolved.provider,
      credential: intent.credential,
      baseUrl: baseUrl.replace(/\/$/, ''),
      header: descriptor.credentialEnv === 'ANTHROPIC_API_KEY' ? 'x-api-key' : 'authorization',
      models: intent.models,
    })
  }

  return { ok: true, routes }
}

/**
 * Which tier an incoming model id belongs to, according to a route's own map.
 *
 * The gateway needs this to fail over honestly: a request for the primary's
 * opus-tier model should reach the fallback's opus-tier model, not the literal
 * string the client sent. Sending `claude-opus-5` to z.ai is a 404 wearing a
 * working request's clothes.
 */
export function tierOf(route: Route, model: string | undefined): Tier | null {
  if (!model) return null
  for (const tier of TIERS) {
    if (route.models[tier] === model) return tier
  }
  return null
}

/**
 * The model to request from `route`, given what the client asked the primary
 * for. Falls back to the client's own string when no tier matches — an unknown
 * model is forwarded verbatim rather than silently rewritten to something else.
 */
export function modelFor(route: Route, tier: Tier | null, requested: string | undefined): string | undefined {
  if (tier === null) return requested
  return route.models[tier] ?? requested
}
