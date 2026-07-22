// Port: persistence for ~/.config/swisscode/config.json.
//
// SYNCHRONOUS on purpose. It is one small local file, and the launch path
// should not pay for an await + microtask turn to read it.
//
// The file holds an API key: mode 0600 inside a 0700 directory, always. That is
// an adapter obligation (fs-config-store re-asserts both on every write) and
// `ConfigModes` below is how `config doctor` reads it back to check.

import type { ClaudeCodeCompatFlags } from './claude-code.ts'
import type { Tier } from './provider.ts'

/**
 * A named profile.
 *
 * THE '' CONVENTION: in `models` and `env`, an empty string means UNSET THE
 * VARIABLE — not set-it-to-empty. It is a user-facing contract documented in
 * the README, and it is why those values are `string` rather than
 * `string | null`: the sentinel IS a string. Descriptors may never use it (they
 * carry an explicit env/unsetEnv split instead); this is the profile side,
 * where a user needs a way to say "clear whatever my shell put there".
 */
export type Profile = {
  /** id from the provider registry */
  provider: string
  /**
   * id from the agent registry — which coding CLI to launch. Absent means the
   * default, 'claude-code', so every profile written before this field existed
   * keeps launching Claude Code with no migration. A profile naming an agent
   * this build does not know still launches Claude Code (launch-root refuses
   * only an explicit --cc-agent for an unknown id).
   */
  agent?: string
  label?: string
  baseUrl?: string
  /** inline; the file is 0600 */
  apiKey?: string
  /** read from the ambient env instead, so no secret sits in the file */
  apiKeyFromEnv?: string
  /** BARE ids. '' means UNSET the tier. Partial: pinning no models is valid. */
  models?: Partial<Record<Tier, string>>
  skipPermissions?: boolean
  /** '' means UNSET the variable */
  env?: Record<string, string>
  /**
   * Overrides the provider's gateway compatibility defaults, key by key.
   * `false` here is an explicit "off" and CLEARS the variable; omit a key to
   * accept the provider default. Those are different states, which is why this
   * is `Partial<Record<flag, boolean>>` and not a set of flag names.
   */
  compat?: ClaudeCodeCompatFlags
  /**
   * bare model id -> real context length in tokens, captured from a catalog
   * when the model was picked. Used to set the auto-compact window. A model
   * absent from this map and from the provider's extendedContext is UNKNOWN and
   * never guessed at.
   */
  contextWindows?: Record<string, number>
}

/** Per-run overrides carried on a directory binding. */
export type ProfileOverrides = {
  baseUrl?: string
  provider?: string
  /** which agent CLI to launch for this run — --cc-agent NAME */
  agent?: string
  /** a bare string sets ALL FOUR tiers — see core/overrides.ts for why */
  models?: string | Partial<Record<Tier, string>>
  env?: Record<string, string>
}

/**
 * A bindings entry. The object form was accepted on read from day one so that
 * adding per-binding overrides needed no schema version bump.
 */
export type BindingValue = string | { profile: string; overrides?: ProfileOverrides }

export type Settings = {
  quiet?: boolean
  bindingWalkDepth?: number
}

/**
 * The v2 config shape: named profiles. This is what `State` means everywhere
 * else in the codebase, and `SUPPORTED_VERSION` is 2.
 */
export type State = {
  version: number
  profiles: Record<string, Profile>
  defaultProfile: string | null
  bindings: Record<string, BindingValue>
  settings: Settings
}

/**
 * The v1 shape: ONE flat config object, a top-level `provider` string, and no
 * `version` key. Still shipped in the wild, still read.
 *
 * v1 is detected by ABSENCE of `version` plus PRESENCE of a top-level
 * `provider` string. Migration output always has version 2 and no top-level
 * `provider`, so migrate(migrate(x)) === migrate(x) holds structurally rather
 * than by a flag someone has to remember to set. That is why v1 keeps the name
 * "v1" instead of being retroactively called v0.
 *
 * The index signature is not slop — it is rule M1. Unrecognized v1 keys ride
 * along onto the migrated profile VERBATIM rather than being dropped, so a key
 * written by a newer swisscode survives a round-trip through an older one.
 */
export type ConfigV1 = {
  provider: string
  baseUrl?: string
  apiKey?: string
  models?: Partial<Record<Tier, string>>
  skipPermissions?: boolean
  env?: Record<string, string>
  [key: string]: unknown
}

/** The version ladder, as a type. Only these two shapes have ever shipped. */
export type ConfigV2 = State

/**
 * What the migration ladder reports.
 *
 * `migratedFrom` is the ONLY thing that authorizes a write on load. Filling in
 * a missing `settings` key is not a migration and must not cause a launch that
 * merely read the file to touch the disk. It is `1 | null` rather than
 * `number | null` because v1 is the only version that has ever been migrated
 * FROM — a newer-than-supported file is `readOnly` instead.
 */
export type MigrateResult = {
  state: State
  migratedFrom: 1 | null
  /** the file existed but could not be understood */
  corrupt: boolean
  /** the file is a NEWER schema; every write path is disabled */
  readOnly: boolean
  warnings: string[]
}

/** What `load()` reports on top of the state itself. */
export type LoadResult = {
  state: State
  /** file existed but could not be understood */
  corrupt: boolean
  /** file is a NEWER schema; writes are refused */
  readOnly: boolean
  /** the shape changed on load */
  migrated: boolean
  warnings: string[]
}

/**
 * Permission bits, masked to 0o777, or null when the path does not exist yet.
 * Read by `config doctor`, which is the only consumer.
 */
export type ConfigModes = {
  dir: number | null
  file: number | null
}

export type ConfigStorePort = {
  load: () => LoadResult
  /** returns the path written; THROWS if the file is readOnly */
  save: (state: State) => string
  path: () => string
  /**
   * An opaque token for the file's current CONTENT, or null when there is no
   * file yet. Optional in the same genuine sense as `modes`: a store that cannot
   * derive one is still a valid store, and callers degrade rather than break.
   *
   * Exists for LOST-UPDATE detection, which only became reachable when a
   * long-lived editor arrived. Every writer until now was a single short-lived
   * command, so last-writer-wins was indistinguishable from correct. A web UI
   * sitting open in a tab while `swisscode config work` runs in a terminal makes
   * silent clobbering ordinary, and the clobbered field could be an API key.
   *
   * Honest about what it is: a check, not a lock. The window between comparing
   * and writing is not closed by this — closing it needs an exclusive lock this
   * project does not otherwise want. It reliably catches the interleaving people
   * actually hit (read, think, write minutes later) and does not pretend to
   * serialize concurrent writers.
   */
  revision?: () => string | null
  /**
   * OPTIONAL, and genuinely so. The JSDoc contract this replaces did not list
   * `modes` at all, but composition/doctor-root.js probes for it
   * (`store.modes ? store.modes() : ...`) and the fs adapter implements it. It
   * is optional here because that guard is the real contract: a store that
   * cannot stat anything is still a valid store, and doctor degrades to
   * reporting the permission checks as unknown.
   */
  modes?: () => ConfigModes
}

export {}
