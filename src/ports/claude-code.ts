// Port: the Claude-Code-shaped contract types.
//
// This file is the designated home for types that SPELL an ANTHROPIC_* or
// CLAUDE_CODE_* string. It is part of the Claude Code adapter's contract
// surface, and test/architecture.test.ts EXEMPTS it (and the adapter itself)
// from the "no Anthropic literals in core/ or ports/" purity check for exactly
// that reason. Nothing neutral belongs here; nothing here belongs in the neutral
// domain (ports/provider.ts, ports/agent.ts).
//
// Type-only, like every port: `export {}` at runtime.

/**
 * Which variable carries the credential.
 *
 * Both spellings are Anthropic's. The choice is load-bearing rather than
 * cosmetic — ANTHROPIC_API_KEY triggers Claude Code's one-time interactive
 * approval prompt, which is why most gateway presets use the auth token.
 */
export type ClaudeCodeCredentialEnv = 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY'

/**
 * Gateway compatibility switches. Each maps to exactly one env var; the mapping
 * lives in the Claude Code adapter (adapters/agents/claude-code/env.ts) so a
 * descriptor never spells a variable name and a typo'd name cannot become a
 * silent no-op.
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
 * than a silent no-op that the adapter's env table skips because the lookup
 * missed.
 */
export type ClaudeCodeCompatFlags = Partial<Record<ClaudeCodeCompatFlag, boolean>>

export {}
