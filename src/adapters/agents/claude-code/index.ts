// The Claude Code adapter — the reference AgentCliPort.
//
// It lowers a launch into Claude Code's ANTHROPIC_*/CLAUDE_CODE_* environment
// (env.ts) and prepends the one permission flag Claude Code understands. Its
// `translate` reads profile/provider directly rather than the neutral intent:
// this lowering predates the intent and is provider/profile-shaped, and keeping
// it verbatim is what lets test/golden.test.ts prove behavior is unchanged.

import { join } from 'node:path'
import { buildEnvPlan } from './env.ts'
import type { AgentCliPort, TranslateInput, Translation } from '../../../ports/agent.ts'
import type { AgentBinarySpec } from '../../../ports/process.ts'

/** The permission flag Claude Code exposes. */
export const SKIP_FLAG = '--dangerously-skip-permissions'

/**
 * Prepend the skip flag unless the user already typed it anywhere on the line.
 * `skipPermissions` is the resolved neutral intent (--yolo/--safe already folded
 * in with the profile default), so this only decides the flag, not the policy.
 */
export function buildArgs(skipPermissions: boolean, passthrough: string[]): string[] {
  const alreadyPresent = passthrough.includes(SKIP_FLAG)
  return skipPermissions && !alreadyPresent ? [SKIP_FLAG, ...passthrough] : [...passthrough]
}

/** Where Claude Code installs when it is not on PATH. */
const binary: AgentBinarySpec = {
  name: 'claude',
  overrideEnv: 'SWISSCODE_CLAUDE_BIN',
  fallbacks: (home: string) => [
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ],
}

/**
 * `satisfies`, not `: AgentCliPort` — keeps the literal `id`/capabilities so
 * ports.conformance.ts and the registry can rely on them.
 */
export const claudeCode = {
  id: 'claude-code',
  label: 'Claude Code',
  capabilities: {
    models: 'tiers',
    skipPermissions: true,
    extendedContextSuffix: true,
    compatFlags: true,
    // CLAUDE_CONFIG_DIR. The whole reason session mode exists: a subscription
    // login lives in a directory rather than in a variable we could carry.
    sessionDir: true,
  },
  binary,
  translate(input: TranslateInput): Translation {
    const plan = buildEnvPlan(input.profile, input.provider, input.ambient)
    return {
      plan: { set: plan.set, unset: plan.unset },
      args: buildArgs(input.intent.skipPermissions, input.passthrough),
      warnings: plan.warnings,
    }
  },
} satisfies AgentCliPort
