// A ProviderRegistryPort over the shipped presets PLUS the user's own.
//
// This is the hexagon doing what it was drawn for. Nothing in core/ changes,
// no consumer changes, and neither the launch path nor the doctor learns that
// providers can now come from a config file — they all still ask a
// `ProviderRegistryPort` for a `ProviderDescriptor` and get one. Swapping the
// implementation behind the port is the whole mechanism.

import { PROVIDERS } from './registry.ts'
import type { CustomProvider, State } from '../../ports/config-store.ts'
import type { ProviderDescriptor, ProviderRegistryPort } from '../../ports/provider.ts'

/**
 * A stored provider, as a descriptor.
 *
 * `extendedContext` and `catalogId` are pinned here rather than merely omitted.
 * Leaving them absent would let a future default supply them behind the user's
 * back; stating them says the capability is genuinely absent, which is the
 * fact — nothing verified those claims for a hand-entered endpoint.
 */
export function toDescriptor(custom: CustomProvider): ProviderDescriptor {
  const descriptor: ProviderDescriptor = {
    id: custom.id,
    label: custom.label,
    baseUrl: custom.baseUrl,
    credentialEnv: custom.credentialEnv ?? 'ANTHROPIC_AUTH_TOKEN',
    defaultModels: custom.defaultModels ?? {},
    catalogId: null,
  }
  // Assigned conditionally, never as `undefined`: exactOptionalPropertyTypes
  // makes "absent" and "present but undefined" different types, and the
  // env-builder branches on presence.
  if (custom.credentialOptional !== undefined) descriptor.credentialOptional = custom.credentialOptional
  if (custom.defaultCredential !== undefined) descriptor.defaultCredential = custom.defaultCredential
  if (custom.subagentFollowsOpus !== undefined) {
    descriptor.subagentFollowsOpus = custom.subagentFollowsOpus
  }
  if (custom.env) descriptor.env = custom.env
  if (custom.unsetEnv) descriptor.unsetEnv = custom.unsetEnv
  if (custom.compat) descriptor.compat = custom.compat
  return descriptor
}

/** The shipped ids, which a user provider may not shadow. */
export const RESERVED_PROVIDER_IDS: readonly string[] = Object.freeze(PROVIDERS.map((p) => p.id))

/**
 * Wrap a registry so it also serves the state's custom providers.
 *
 * Takes a BASE registry rather than reaching for the shipped constant, which is
 * what keeps it composable: every consumer already receives a
 * `ProviderRegistryPort` through `LaunchDeps`, and tests inject fakes there. A
 * version that hard-coded `PROVIDERS` would quietly ignore the fake and make
 * those tests assert against the wrong registry.
 *
 * BASE WINS, unconditionally. A stored provider claiming a base id is dropped
 * rather than merged or preferred — validation refuses to create one, so
 * reaching this branch means a hand-edited or hostile config file, and the safe
 * reading of "openrouter now points somewhere else" is an attempt to redirect a
 * credential to a host it was not entered for.
 *
 * Order puts the user's own first: they are what a picker iterates, and a list
 * that buries them under eight presets is a worse list.
 */
export function withCustomProviders(
  base: ProviderRegistryPort,
  state: State | null | undefined,
): ProviderRegistryPort {
  const reserved = new Set(base.all().map((p) => p.id))
  const custom: ProviderDescriptor[] = []

  for (const [key, value] of Object.entries(state?.providers ?? {})) {
    if (!value || typeof value !== 'object') continue
    // The map KEY is authoritative. A record whose inner `id` disagrees with
    // the key it is filed under would resolve differently depending on which
    // one a caller happened to use.
    const descriptor = toDescriptor({ ...value, id: key })
    if (reserved.has(descriptor.id)) continue
    custom.push(descriptor)
  }

  if (custom.length === 0) return base

  const all: readonly ProviderDescriptor[] = Object.freeze([...custom, ...base.all()])

  return Object.freeze({
    all: () => all,
    // Base lookup first, so a shadowing entry that somehow survived above still
    // cannot win.
    byId: (id: string | null | undefined) => base.byId(id) ?? custom.find((p) => p.id === id) ?? null,
  }) satisfies ProviderRegistryPort
}
