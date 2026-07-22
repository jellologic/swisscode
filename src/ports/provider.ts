// Port: what a provider preset has to tell the launcher.
//
// Ports are type-only modules (`export {}` at runtime). Descriptors are plain
// data; conformance is structural at compile time. test/architecture.test.ts
// asserts the residue is exactly `export {}`.
//
// This module is NEUTRAL: it must not spell an ANTHROPIC_* or CLAUDE_CODE_*
// string. The Claude-Code-shaped types a descriptor needs (which variable
// carries the credential, the gateway compat switches) live in
// ports/claude-code.ts and are imported below. `credentialEnv` and `compat`
// stay on the descriptor because a provider preset IS an Anthropic-compatible
// endpoint; a non-Claude-Code agent adapter simply ignores them and reads the
// neutral LaunchIntent instead (see ports/agent.ts).

import type { ClaudeCodeCompatFlags, ClaudeCodeCredentialEnv } from './claude-code.ts'

/**
 * The four model tiers a profile can pin.
 *
 * NEUTRAL vocabulary: this is how a swisscode PROFILE expresses models,
 * independent of which agent CLI runs. The Claude Code adapter maps each tier
 * 1:1 to an ANTHROPIC_DEFAULT_*_MODEL variable (its own table); a single-slot
 * CLI like Kilo maps opus to its one model and warns about the rest. The
 * neutral LaunchIntent (ports/agent.ts) carries a `TierRecord` of resolved ids.
 *
 * FOUR, exhaustively. A missing tier is the bug that shipped in 0.1.0: `[1m]`
 * is read PER VARIABLE, so one unsuffixed tier silently runs at the assumed
 * 200K window with no error and no warning. `TierRecord` below is what makes
 * that unreachable by omission.
 */
export type Tier = 'opus' | 'sonnet' | 'haiku' | 'fable'

/**
 * An EXHAUSTIVE record over the tiers. Omitting one is a compile error.
 *
 * This is the type that kills the 0.1.0 bug. Any table that must answer for
 * every tier — the env-var map, the resolved-model map — is a `TierRecord`, so
 * "three tiers handled by three hand-written ifs and the fourth quietly isn't"
 * stops being a thing a reviewer has to catch.
 *
 * Use `Partial<Record<Tier, T>>` (not this) where absence is genuinely
 * meaningful, e.g. a descriptor that pins no models at all.
 */
export type TierRecord<T> = { [K in Tier]: T }

/**
 * A model family that genuinely supports an extended context window.
 * `models` lists BARE ids; the `[1m]` suffix is derived at env-build time by
 * the Claude Code adapter and must never be typed into a descriptor.
 *
 * DELIBERATELY NEUTRAL. This declares a fact about a MODEL ("these ids serve a
 * 1M window"), not a fact about Claude Code. The `[1m]` spelling is the
 * Claude-Code-shaped half and it lives in the Claude Code adapter's context.ts,
 * which is the only module that renders it. Keeping the split here is what lets
 * a different agent adapter reuse the capability declaration unchanged while
 * bringing its own way of asking for the wider window.
 *
 * This is a CAPABILITY DECLARATION, not a string transformation. A model earns
 * the suffix by being named here, which is why "apply [1m] only where the model
 * genuinely supports 1M" is enforceable rather than aspirational: adding a
 * model to `models` is a deliberate act a reviewer sees, and
 * test/registry.test.ts cross-checks the claim against `defaultModels`.
 *
 * Verified against vendor documentation. Do NOT add a model on the strength of
 * a blog post — an id carrying [1m] that the endpoint does not recognise is a
 * hard failure, and one that silently does not honour it is a 200K window
 * wearing a 1M label.
 */
export type ExtendedContext = {
  supported: boolean
  /** bare ids that genuinely support the wider window */
  models: string[]
  /** documented window shared by `models`, e.g. 1000000 */
  window?: number
  /**
   * per-model override where the family does not agree on one number
   * (kimi-k3 documents 1048576, not 1e6).
   */
  windows?: Record<string, number>
}

/** UI-only copy. Never read by the launch path. */
export type ProviderHints = {
  keyHint?: string
  modelHint?: string
  note?: string
}

/**
 * A provider preset, as plain data.
 *
 * Descriptors use the explicit env / unsetEnv split and may NEVER use '' to
 * mean unset — registry.test.ts fails any descriptor that does. The
 * ''-means-unset convention is a user-facing contract (profile.env,
 * profile.models) and stays exactly as documented in the README.
 */
export type ProviderDescriptor = {
  id: string
  label: string
  /** null = actively CLEAR the base URL rather than inherit the shell's */
  baseUrl: string | null
  /** the wizard prompts for the URL */
  askBaseUrl?: boolean
  credentialEnv: ClaudeCodeCredentialEnv
  credentialOptional?: boolean
  /**
   * The credential to send when the profile carries none.
   *
   * For endpoints that require the field to be POPULATED but do not check it —
   * a local Ollama accepts any token, a wrong token and no token identically.
   * The alternative is telling every user to type a fake key into the wizard
   * and storing that fiction in config.json, where it looks like a secret.
   *
   * NOT a secret and never treated as one: it ships in the source. A provider
   * that needs a real credential must leave this unset, so that "no key" stays
   * an error rather than silently becoming a placeholder that 401s later.
   * Pairs with `credentialOptional`, which is what stops the wizard demanding
   * one in the first place.
   */
  defaultCredential?: string
  /**
   * BARE ids, never [1m].
   *
   * `Partial`, not `TierRecord`: a descriptor pinning NO models is a real and
   * correct state (anthropic-direct and `custom` both ship `{}`, so the agent
   * picks its own). Exhaustiveness is required of the RESOLVED map that the
   * Claude Code adapter builds — see `ResolvedModels` — because that is the one
   * that has to answer for every variable.
   */
  defaultModels: Partial<Record<Tier, string>>
  /** vars to SET */
  env?: Record<string, string>
  /** vars to REMOVE */
  unsetEnv?: string[]
  /** defaults; a profile may override any key */
  compat?: ClaudeCodeCompatFlags
  extendedContext?: ExtendedContext
  /** id of a ModelCatalogPort, or null when this provider publishes no catalog */
  catalogId?: string | null
  subagentFollowsOpus?: boolean
  hints?: ProviderHints
}

/**
 * The env-var assignment the Claude Code adapter resolves for every tier.
 *
 * EXHAUSTIVE keys, nullable values — and the two are not the same statement.
 * Every tier must be ANSWERED FOR (that is the 0.1.0 fix); the answer is
 * allowed to be "nothing pinned, clear the variable", which is what
 * `undefined` means here. A `Partial` would let a tier go unmentioned, which is
 * precisely the shape of the bug.
 */
export type ResolvedModels = TierRecord<string | undefined>

/**
 * Lookup over the shipped presets.
 *
 * `byId` returns null rather than throwing: an unknown provider id is a normal
 * state (a config file written by a newer swisscode, or a hand-edited one) and
 * the caller decides whether it is fatal. See launch-root.ts, which only refuses
 * the launch when the profile ALSO has no baseUrl of its own.
 *
 * `null | undefined` is accepted for the same reason `CatalogRegistryPort.byId`
 * accepts it, and the two now agree. "Nothing is selected yet" is a normal state
 * with a normal answer — the wizard calls this on every render before a provider
 * has been chosen — and the implementation has always handled it, since
 * `PROVIDERS.find(p => p.id === id)` simply matches nothing. The narrower
 * `(id: string)` described neither the implementation nor any real caller; it
 * would have forced an assertion at the one call site that most needed the
 * honest answer.
 */
export type ProviderRegistryPort = {
  all: () => readonly ProviderDescriptor[]
  byId: (id: string | null | undefined) => ProviderDescriptor | null
}

export {}
