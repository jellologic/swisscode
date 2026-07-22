// Adapter conformance, checked by the COMPILER.
//
// This file has no runtime tests and is never executed. It is deliberately not
// named `*.test.ts`, so `node --test` skips it — the assertions here are made by
// `tsc`, and `pnpm typecheck` is what runs them.
//
// It exists because "ports-and-adapters in a language without interfaces is the
// weakest form of the pattern": before this, a port could only DESCRIBE a
// contract in a comment and nothing checked that an adapter met it. Every
// binding below is a structural assertion that a real adapter satisfies a real
// port. Break a port or an adapter and this file stops compiling.
//
// It lives in test/ rather than src/ for one specific reason: tsconfig.build
// emits `src` to `dist`, and a file whose only purpose is compile-time checking
// must not ship in the published artifact. tsconfig.json includes `test`, so it
// is typechecked and never emitted.
//
// Adapters also state their ports at definition sites (`satisfies`, explicit
// return types). This file is the ONE place the whole adapter surface is listed
// against the whole port surface, so a port that acquires a member no adapter
// implements fails here even if every adapter individually compiles.
// `_tierEnv` below is not reachable from any adapter at all.

import type {
  ProviderDescriptor,
  ProviderRegistryPort,
  TierRecord,
} from '../src/ports/provider.ts'
import type { ClockPort } from '../src/ports/clock.ts'
import type { NetPort } from '../src/ports/net.ts'
import type { ProcessPort } from '../src/ports/process.ts'
import type { ConfigStorePort } from '../src/ports/config-store.ts'
import type {
  CatalogCapabilities,
  CatalogRegistryPort,
  ModelCacheStorePort,
  ModelCatalogPort,
} from '../src/ports/catalog.ts'
import type { AnthropicMessagesProbePort } from '../src/ports/doctor.ts'
import type { AgentCliPort, AgentRegistryPort } from '../src/ports/agent.ts'

import { anthropic } from '../src/adapters/providers/anthropic.ts'
import { zai } from '../src/adapters/providers/zai.ts'
import { openrouter as openrouterProvider } from '../src/adapters/providers/openrouter.ts'
import { modelscope as modelscopeProvider } from '../src/adapters/providers/modelscope.ts'
import { siliconflow } from '../src/adapters/providers/siliconflow.ts'
import { custom } from '../src/adapters/providers/custom.ts'
import { registry as providerRegistry } from '../src/adapters/providers/registry.ts'
import { TIER_ENV } from '../src/adapters/agents/claude-code/tiers.ts'
import { claudeCode } from '../src/adapters/agents/claude-code/index.ts'
import { kilo } from '../src/adapters/agents/kilo/index.ts'
import { opencode } from '../src/adapters/agents/opencode/index.ts'
import { registry as agentRegistry } from '../src/adapters/agents/registry.ts'
import { systemClock } from '../src/adapters/clock/system-clock.ts'
import { fetchNet } from '../src/adapters/net/fetch-net.ts'
import { createNodeProcess } from '../src/adapters/process/node-process.ts'
import { createFsConfigStore } from '../src/adapters/store/fs-config-store.ts'
import { createFsCacheStore } from '../src/adapters/store/fs-cache-store.ts'
import {
  OPENROUTER_CAPABILITIES,
  createOpenRouterCatalog,
} from '../src/adapters/catalog/openrouter.ts'
import {
  MODELSCOPE_CAPABILITIES,
  createModelScopeCatalog,
} from '../src/adapters/catalog/modelscope.ts'
import { createCatalogRegistry } from '../src/adapters/catalog/registry.ts'
import { createProbe } from '../src/adapters/doctor/probe.ts'

// provider

// Every shipped descriptor. A misspelled compat flag, a credentialEnv that is
// not one of the two Anthropic spellings, or a `defaultModels` key that is not
// a tier is now a compile error in the descriptor itself.
export const _anthropic: ProviderDescriptor = anthropic
export const _zai: ProviderDescriptor = zai
export const _openrouter: ProviderDescriptor = openrouterProvider
export const _modelscope: ProviderDescriptor = modelscopeProvider
export const _siliconflow: ProviderDescriptor = siliconflow
export const _custom: ProviderDescriptor = custom

export const _providerRegistry: ProviderRegistryPort = providerRegistry

// agent CLIs — every adapter against the AgentCliPort, and the registry.
// A capability field that is not in the union, or a `translate`/`binary` that
// drifts from the port, is a compile error in the adapter's own file; this is
// where the whole set is listed against the whole port.
export const _claudeCode: AgentCliPort = claudeCode
export const _kilo: AgentCliPort = kilo
export const _opencode: AgentCliPort = opencode
export const _agentRegistry: AgentRegistryPort = agentRegistry

/**
 * THE 0.1.0 BUG, AS A COMPILE ERROR.
 *
 * `TierRecord` is exhaustive over the four tiers, so deleting the `fable` line
 * from core/tiers.ts stops the project compiling. That is the whole point: the
 * shipped bug was one tier missing from a table, `[1m]` being read PER
 * VARIABLE, and the fourth tier silently running at the assumed 200K window
 * with no error and no warning.
 */
export const _tierEnv: TierRecord<string> = TIER_ENV

// clock / net / process

export const _clock: ClockPort = systemClock
export const _net: NetPort = fetchNet
export const _proc: ProcessPort = createNodeProcess()

// config store

export const _store: ConfigStorePort = createFsConfigStore()

// catalog

export const _openrouterCaps: CatalogCapabilities = OPENROUTER_CAPABILITIES
export const _modelscopeCaps: CatalogCapabilities = MODELSCOPE_CAPABILITIES

const catalogDeps = {
  net: fetchNet,
  cache: createFsCacheStore({ clock: systemClock }),
  clock: systemClock,
}

export const _cache: ModelCacheStorePort = createFsCacheStore({ clock: systemClock })
export const _openrouterCatalog: ModelCatalogPort = createOpenRouterCatalog(catalogDeps)
export const _modelscopeCatalog: ModelCatalogPort = createModelScopeCatalog(catalogDeps)
export const _catalogRegistry: CatalogRegistryPort = createCatalogRegistry(catalogDeps)

// doctor probe

export const _probe: AnthropicMessagesProbePort = createProbe()

// the lazy UI boundary
//
// src/cli.ts declares `UiModule` STRUCTURALLY rather than as
// `typeof import('../src/composition/ui-root.ts')`. It has to: anything under
// src/ that names the UI — even in type space — pulls the component tree into
// tsconfig.build.json's program and ships a second, unbundled copy of React
// inside the package. (`exclude` only filters the `include` globs; a module
// reached through an import joins the program regardless.)
//
// That leaves cli.ts asserting a shape it cannot see. This is where the claim
// is checked against the real thing. test/ is never emitted and never packed,
// so naming ui-root HERE is free — and if `runUi`'s signature ever drifts from
// what cli.ts calls, this line stops compiling.
//
// Verified to bite: renaming runUi's `state` parameter type produced
//   TS2322: Type 'typeof import(".../ui-root")' is not assignable to type 'UiModule'.
import type { UiModule } from '../src/cli.ts'
import * as uiRoot from '../src/composition/ui-root.ts'

export const _ui: UiModule = uiRoot
