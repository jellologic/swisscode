// Port: the agent CLI seam (issue #19).
//
// The core computes a NEUTRAL `LaunchIntent` from (profile, provider, ambient)
// and hands it to whichever `AgentCliPort` the profile selected. Each adapter
// lowers that intent into its own CLI's environment + arguments. Claude Code is
// the reference adapter; Kilo and OpenCode are peers.
//
// NEUTRAL: nothing here spells an ANTHROPIC_* or CLAUDE_CODE_* string. Those
// live only in ports/claude-code.ts and adapters/agents/claude-code/.
//
// Type-only, like every port: `export {}` at runtime.

import type { ExtendedContext, ProviderDescriptor, Tier, TierRecord } from './provider.ts'
import type { ResolvedProfile } from './config-store.ts'
import type { AgentBinarySpec, EnvMap } from './process.ts'

/**
 * Warning severity. `high` and `medium` surface on stderr; `info` is reported
 * but never treated as a conflict (core/doctor.ts maps it to an `ok` check
 * rather than a warning, so the distinction is load-bearing for the exit code).
 */
export type WarningSeverity = 'high' | 'medium' | 'info'

export type EnvWarning = {
  severity: WarningSeverity
  code: string
  message: string
}

/**
 * The finished environment mutation. `set` and `unset` are DISJOINT by
 * construction (see core/env-plan.ts `makeEnvWriter`), which is why they can be
 * two collections rather than one map with a sentinel. This is the neutral half
 * every adapter produces; how each variable is CHOSEN is the adapter's business.
 */
export type EnvPlan = {
  set: Record<string, string>
  unset: string[]
}

/**
 * What the core resolves for any agent, before a single Anthropic (or Kilo, or
 * OpenCode) variable is named. The issue's neutral intent, made concrete.
 *
 *   baseUrl          Anthropic-compatible endpoint, or null for "agent default"
 *   credential       the resolved token/key VALUE ('' clears)
 *   models           BARE ids per tier ('' = explicit opt-out); no [1m] here
 *   skipPermissions  the neutral permission intent; each CLI has its own flag
 *   extendedContext  a fact about the MODEL's window (neutral capability)
 *   contextWindows   measured windows captured when the model was picked
 */
export type LaunchIntent = {
  baseUrl: string | null
  credential: string
  models: TierRecord<string | undefined>
  skipPermissions: boolean
  extendedContext?: ExtendedContext | null
  contextWindows?: Record<string, number>
  /**
   * A directory holding a login the agent already performed, or absent.
   *
   * The NEUTRAL half of session-mode authentication. An account can present a
   * key, or it can point at somewhere the agent keeps its own credential — a
   * Claude Code subscription being the shipped case. Which environment variable
   * carries it is the adapter's business, exactly as it is for the credential.
   *
   * Spelled "session directory" rather than after any agent's variable because
   * core/ builds this intent, and test/architecture.test.ts forbids core/ from
   * naming an agent's dialect in emitted code.
   */
  sessionDir?: string | null
}

/**
 * What an agent CLI can express, so the core can WARN (never silently drop)
 * when a profile asks for something it cannot.
 *
 *   models            'tiers'         four independent slots (Claude Code)
 *                     'primary+small' a main model plus a lightweight one (OpenCode)
 *                     'single'        one model slot (Kilo)
 *   skipPermissions   can it run without per-action approval?
 *   extendedContext   does it honour the [1m] id suffix? (Claude Code only)
 *   compatFlags       does it consume the gateway compat switches? (Claude Code only)
 */
export type AgentCapabilities = {
  models: 'tiers' | 'primary+small' | 'single'
  skipPermissions: boolean
  extendedContextSuffix: boolean
  compatFlags: boolean
  /**
   * Can this CLI be pointed at an existing login directory?
   *
   * Claude Code can (CLAUDE_CONFIG_DIR). Kilo and OpenCode take a credential
   * inline and have no equivalent, so an account in session mode gives them
   * nothing to authenticate with — which they must WARN about rather than
   * launch unauthenticated, the same rule tier-collapse already follows.
   */
  sessionDir: boolean
}

/**
 * Everything an adapter's `translate` receives. The neutral `intent` is the
 * contract; `profile`/`provider`/`ambient` are available for the reference
 * adapter, whose lowering predates the intent and is provider/profile-shaped.
 * Non-Claude-Code adapters read only `intent` and `passthrough`.
 */
export type TranslateInput = {
  intent: LaunchIntent
  profile: ResolvedProfile
  provider: ProviderDescriptor | null
  passthrough: string[]
  ambient: EnvMap
}

/** An adapter's answer: the env mutation, the final argv, and any warnings. */
export type Translation = {
  plan: EnvPlan
  args: string[]
  warnings: EnvWarning[]
}

/**
 * One agent CLI, as a port. `binary` is DECLARATIVE data (name + fallbacks +
 * override env var); the process adapter, which owns node:fs, resolves it via
 * `ProcessPort.resolveBinary(spec)` and applies the shared self-alias guard.
 * That keeps adapters/agents free of filesystem access and on the launch path.
 */
export type AgentCliPort = {
  id: string
  label: string
  capabilities: AgentCapabilities
  binary: AgentBinarySpec
  translate: (input: TranslateInput) => Translation
}

/**
 * Lookup over the shipped agent adapters. Mirrors `ProviderRegistryPort`:
 * `byId` returns null for an unknown id (a config written by a newer swisscode,
 * or a hand-edited one) and the caller decides whether it is fatal.
 */
export type AgentRegistryPort = {
  all: () => readonly AgentCliPort[]
  byId: (id: string | null | undefined) => AgentCliPort | null
}

export {}
