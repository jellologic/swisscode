// Port: what a provider preset has to tell the launcher.
//
// Ports are type-only modules (`export {}` at runtime). Descriptors are plain
// data; conformance is structural at compile time. test/architecture.test.ts
// asserts the residue is exactly `export {}`.

// AGENT-CLI SEAM (issue #19)
//
// Everything in THIS BLOCK is Claude-Code-shaped and only Claude-Code-shaped.
// It is named so, and grouped so, because issue #19 extracts an AgentCliPort to
// let other agent CLIs (opencode) be swapped in — and this block is where that
// cut falls. Nothing below this block, and nothing in core/, may assume these
// names.
//
// The rule this block exists to keep visible: a type that spells an ANTHROPIC_*
// or CLAUDE_CODE_* string belongs HERE, not in the neutral domain. A descriptor
// says "this gateway needs the adaptive-thinking workaround"; it never says
// "set CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1". The mapping from the former to
// the latter lives in core/env.ts and stays a single table.

/**
 * Claude Code's four model tiers.
 *
 * SEAM: these are Claude Code's names, and each maps 1:1 to an
 * ANTHROPIC_DEFAULT_*_MODEL variable (the table is core/tiers.ts). A different
 * agent CLI would bring its own set, so this union moves with the AgentCliPort.
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
 * Which variable carries the credential.
 *
 * SEAM: both spellings are Anthropic's. The choice is load-bearing rather than
 * cosmetic — ANTHROPIC_API_KEY triggers Claude Code's one-time interactive
 * approval prompt, which is why most gateway presets use the auth token.
 */
export type ClaudeCodeCredentialEnv = 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY'

/**
 * Gateway compatibility switches. Each maps to exactly one env var; the mapping
 * lives in core/env.ts so a descriptor never spells a variable name and a
 * typo'd name cannot become a silent no-op.
 *
 * SEAM: every one of these clears a symptom of running CLAUDE CODE against a
 * third-party gateway, and each maps to a `CLAUDE_CODE_` or `API_` variable.
 *
 * A provider ships these as defaults. A profile may override any single key —
 * `"compat": {"disableAdaptiveThinking": true}` in config.json — and a profile
 * setting one to `false` actively unsets the variable rather than leaving one
 * inherited from the shell.
 *
 * Each flag names the symptom it clears, because that is the only thing that
 * makes it possible to decide whether you need one:
 *
 *   disableExperimentalBetas  HTTP 400 "Extra inputs are not permitted"
 *   disableAdaptiveThinking   HTTP 400 "Input tag 'adaptive' found"
 *   skipFastModeOrgCheck      fast mode reports "disabled by organization"
 *   enableToolSearch          MCP tool search is off by default off-first-party
 *   forceIdleTimeoutOff       long stalls on slow or locally hosted models
 *   dropAttributionHeader     poor prompt-cache hit rate through a gateway
 *
 * There is deliberately NO flag for CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC.
 * It also disables gateway model discovery, so it must not be reachable from a
 * boolean that reads like a harmless compatibility switch.
 */
export type ClaudeCodeCompatFlag =
  | 'disableExperimentalBetas'
  | 'disableAdaptiveThinking'
  | 'skipFastModeOrgCheck'
  | 'enableToolSearch'
  | 'forceIdleTimeoutOff'
  | 'dropAttributionHeader'

/**
 * A set of compat switches. Every key optional and every key a known flag: a
 * misspelled flag in a descriptor or a profile is now a compile error rather
 * than a silent no-op that core/env.ts skips because the lookup missed.
 */
export type ClaudeCodeCompatFlags = Partial<Record<ClaudeCodeCompatFlag, boolean>>

// end AGENT-CLI SEAM

/**
 * A model family that genuinely supports an extended context window.
 * `models` lists BARE ids; the `[1m]` suffix is derived at env-build time by
 * core/context.ts and must never be typed into a descriptor.
 *
 * DELIBERATELY NEUTRAL, and it stays on this side of the seam. This declares a
 * fact about a MODEL ("these ids serve a 1M window"), not a fact about Claude
 * Code. The `[1m]` spelling is the Claude-Code-shaped half and it lives in
 * core/context.ts, which is the only module that renders it. Keeping the split
 * here is what lets a future AgentCliPort reuse the capability declaration
 * unchanged while bringing its own way of asking for the wider window.
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
  /** null = actively CLEAR ANTHROPIC_BASE_URL rather than inherit the shell's */
  baseUrl: string | null
  /** the wizard prompts for the URL */
  askBaseUrl?: boolean
  credentialEnv: ClaudeCodeCredentialEnv
  credentialOptional?: boolean
  /**
   * BARE ids, never [1m].
   *
   * `Partial`, not `TierRecord`: a descriptor pinning NO models is a real and
   * correct state (anthropic-direct and `custom` both ship `{}`, so Claude Code
   * picks its own). Exhaustiveness is required of the RESOLVED map that
   * core/env.ts builds — see `ResolvedModels` — because that is the one that
   * has to answer for every variable.
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
 * The env-var assignment core/env.ts resolves for every tier.
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
