// Neutral env-plan mechanics, shared by every agent adapter.
//
// This is the generic half of what used to be core/env.ts: HOW an env mutation
// is accumulated and applied. WHICH variables get written is each adapter's
// business and lives under adapters/agents/. Nothing here spells an ANTHROPIC_*
// or CLAUDE_CODE_* string — that is the whole point of the split.

import type { EnvPlan } from '../ports/agent.ts'
import type { ResolvedProfile } from '../ports/config-store.ts'
import type { EnvMap } from '../ports/process.ts'

/**
 * The ONE write primitive, exposed as a small accumulator so adapters share it.
 *
 * `set` and `unset` are disjoint by construction rather than by convention:
 *   '' or null/undefined  => remove the variable from the child env
 *   anything else         => set it
 * Last write wins, so a later step can resurrect what an earlier one cleared.
 * `set` and `unset` are exposed as live maps because real lowerings read back
 * what they have written so far (a billing guard, a subagent pin).
 */
export type EnvWriter = {
  set: Map<string, string>
  unset: Set<string>
  write: (key: string, value: string | null | undefined) => void
  toPlan: () => EnvPlan
}

export function makeEnvWriter(): EnvWriter {
  const set = new Map<string, string>()
  const unset = new Set<string>()

  const write = (key: string, value: string | null | undefined): void => {
    if (value === '' || value === null || value === undefined) {
      set.delete(key)
      unset.add(key)
    } else {
      unset.delete(key)
      set.set(key, String(value))
    }
  }

  return {
    set,
    unset,
    write,
    toPlan: () => ({ set: Object.fromEntries(set), unset: [...unset] }),
  }
}

/** Entries whose value is neither undefined nor null. '' survives — it means UNSET. */
export function definedEntriesOf<T>(
  obj: Record<string, T | null | undefined> | null | undefined,
): Record<string, T> {
  const out: Record<string, T> = {}
  if (!obj || typeof obj !== 'object') return out
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v
  }
  return out
}

/**
 * The credential this profile should present, or '' to clear the variable.
 * `apiKeyFromEnv` lets a profile be fully specified with no secret in the file.
 * Neutral: it produces the VALUE; which variable carries it is the adapter's call.
 */
export function resolveCredential(
  profile: ResolvedProfile | null | undefined,
  ambientEnv: EnvMap | null | undefined,
): string {
  if (profile?.apiKeyFromEnv) return ambientEnv?.[profile.apiKeyFromEnv] ?? ''
  return profile?.apiKey ?? ''
}

/** Apply a plan to an ambient env, producing the child's environment. */
export function materializeEnv(ambientEnv: EnvMap, plan: EnvPlan): EnvMap {
  const env: EnvMap = { ...ambientEnv, ...plan.set }
  for (const key of plan.unset) delete env[key]
  // Read back by the recursion guard in adapters/process/node-process.ts.
  env.SWISSCODE = '1'
  return env
}
