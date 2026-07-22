import type { AgentCliPort, AgentRegistryPort } from '../../ports/agent.ts'
import { claudeCode } from './claude-code/index.ts'
import { kilo } from './kilo/index.ts'
import { opencode } from './opencode/index.ts'

/**
 * Order is the order the wizard offers them in. Claude Code is first and is the
 * default when a profile names no agent.
 *
 * `readonly`, because Object.freeze actually froze it.
 */
export const AGENTS: readonly AgentCliPort[] = Object.freeze([claudeCode, kilo, opencode])

/** The id a profile falls back to when it names no agent (or an unknown one). */
export const DEFAULT_AGENT_ID = 'claude-code'

export function byId(id: string | null | undefined): AgentCliPort | null {
  return AGENTS.find((a) => a.id === id) ?? null
}

/**
 * `satisfies`, so port conformance is asserted HERE, at the definition, rather
 * than only where a consumer happens to annotate.
 */
export const registry = Object.freeze({
  all: () => AGENTS,
  byId,
}) satisfies AgentRegistryPort
