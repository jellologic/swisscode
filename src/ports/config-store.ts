// Port: persistence for ~/.config/swisscode/config.json.
//
// SYNCHRONOUS on purpose. It is one small local file, and the launch path
// should not pay for an await + microtask turn to read it.
//
// The file holds an API key: mode 0600 inside a 0700 directory, always. That is
// an adapter obligation (fs-config-store re-asserts both on every write) and
// `ConfigModes` below is how `config doctor` reads it back to check.

import type { ClaudeCodeCompatFlags, ClaudeCodeCredentialEnv } from './claude-code.ts'
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
/**
 * WHO PAYS. A provider, a credential, and where to send it.
 *
 * First-class because a credential is not a property of one launch
 * configuration — the same OpenRouter key can back a dozen profiles, and an
 * Anthropic subscription is a thing you HAVE rather than a thing a profile
 * owns. Before v3 these fields lived on the profile, which is why
 * `core/overrides.ts` had to go scavenging through other profiles for a key
 * when `--cc-provider` retargeted: a lookup written as a search, because there
 * was nothing to look up.
 *
 * The credential-safety rule becomes STRUCTURAL here rather than a discipline:
 * an account names exactly one provider, so a key cannot reach a host it was
 * not entered for without someone rewriting the account.
 */
export type ProviderAccount = {
  /** id from the provider registry (shipped preset or custom) */
  provider: string
  label?: string
  /** overrides the descriptor's endpoint */
  baseUrl?: string
  /** inline; the file is 0600 */
  apiKey?: string
  /** read from the ambient env instead, so no secret sits in the file */
  apiKeyFromEnv?: string
  /**
   * SESSION MODE: a directory holding a login the agent already performed.
   *
   * The third way to authenticate, and the odd one out — there is no secret
   * here at all, only a path to somewhere the agent keeps its own credential.
   * A Claude Code subscription works this way: you log in once with the
   * official OAuth flow inside this directory, and every launch that names the
   * account points the agent back at it.
   *
   * MUTUALLY EXCLUSIVE with `apiKey`/`apiKeyFromEnv`. An account carrying both
   * is refused rather than resolved by precedence: "which credential did this
   * actually use" is exactly the question that must never have a subtle answer.
   *
   * Neutral on purpose. Which environment variable expresses it belongs to the
   * agent adapter — see `LaunchIntent.sessionDir` in ports/agent.ts — because
   * core/ may not name an agent's dialect, and this port is read by core.
   */
  configDir?: string
}

/**
 * WHAT RUNS. A coding CLI plus how it should behave.
 *
 * Independent of who pays, so one setup ("Claude Code, yolo, glm on every
 * tier") can be pointed at several accounts, and one account can back several
 * setups.
 *
 * `models` stays the FOUR Claude Code tiers rather than becoming agent-shaped.
 * That is deliberate and unchanged from v2: agents with fewer slots collapse it
 * and warn (see `collapsedTierWarning` in adapters/agents/shared.ts), which is
 * a documented, tested behaviour. Reshaping it is a separate decision that
 * should not ride along with a schema migration.
 */
export type AgentProfile = {
  /**
   * id from the agent registry — which coding CLI to launch. Absent means the
   * default, 'claude-code'. An agent profile naming an agent this build does
   * not know still launches the default (launch-root refuses only an explicit
   * --cc-agent for an unknown id).
   */
  agent?: string
  label?: string
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

/**
 * One account and one agent profile, flattened — what a launch actually needs.
 *
 * THIS IS THE SEAM THAT KEEPS THE v3 SPLIT CHEAP. It is deliberately the same
 * shape v2's `Profile` had, so everything downstream of resolution — the agent
 * adapters, `buildEnvPlan`, `buildIntent`, the golden maps — consumes exactly
 * what it always did and needed no change when the stored schema split in
 * three. The refactor lands entirely upstream of here.
 *
 * Produced only by `core/resolve.ts`. Never stored, never written: it is a view
 * over two persisted objects, and giving it a name is what stops consumers
 * reaching back into the store to re-derive it.
 */
export type ResolvedProfile = {
  /** which account was selected, so callers can report it */
  accountName: string
  agentProfileName: string
  // ── from the provider account ──
  provider: string
  baseUrl?: string
  apiKey?: string
  apiKeyFromEnv?: string
  /** session mode: a directory holding a login the agent already performed */
  configDir?: string
  // ── from the agent profile ──
  agent?: string
  models?: Partial<Record<Tier, string>>
  skipPermissions?: boolean
  env?: Record<string, string>
  compat?: ClaudeCodeCompatFlags
  contextWindows?: Record<string, number>
}

/**
 * How a profile picks among its accounts.
 *
 * Every one of these resolves ONCE, before `execve`. swisscode ceases to exist
 * at handoff, so there is no such thing here as per-request rotation, live
 * failover, or reacting to a 429 — those require sitting in the data path,
 * which is the proxy this tool is not.
 *
 *   single       the first account. No state, no surprises.
 *   round-robin  advances per LAUNCH, via a cursor kept outside config.json.
 *   usage        picks by remaining capacity from a CACHED snapshot, refreshed
 *                at configuration time (doctor / web UI). Never a live call:
 *                the launch path may not reach the network. Falls back to
 *                `single` and says so when there is no snapshot.
 */
export type SelectionStrategy = 'single' | 'round-robin' | 'usage'

/**
 * THE PAIRING. What `swisscode <name>` actually names.
 *
 * Holds no credential and no agent settings of its own — only references, plus
 * the rule for choosing among them.
 */
export type Profile = {
  label?: string
  /** key into `State.agentProfiles` */
  agentProfile: string
  /**
   * keys into `State.providerAccounts`, in preference order. Never empty in a
   * valid config; an empty list is a resolution error that names the fix rather
   * than a silent fallback to some other account.
   */
  accounts: string[]
  /** absent means `single` */
  strategy?: SelectionStrategy
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
/**
 * A provider the USER defined, stored in config.json.
 *
 * Deliberately a SUBSET of `ProviderDescriptor`, and the omissions are the
 * point. Shipped descriptors are guarded by test/registry.test.ts — no
 * hand-typed [1m], no /v1 suffix, extendedContext cross-checked against
 * defaultModels, compat flags proven real. None of those tests can reach a
 * value that arrives from a config file, so anything they cannot guard is
 * either validated at runtime (core/provider-def.ts) or not offered at all.
 *
 * NOT offered:
 *   catalogId       a catalog needs a shipped adapter that knows the upstream
 *                   JSON shape; there is nothing to point an id at.
 *   extendedContext the [1m] claim is exactly the one that must be VERIFIED.
 *                   An id carrying a suffix the endpoint does not recognise
 *                   fails hard, and one that silently ignores it is a 200K
 *                   window wearing a 1M label. A profile's `contextWindows`
 *                   already covers the honest need (auto-compaction) without
 *                   asserting a capability nobody checked.
 */
export type CustomProvider = {
  id: string
  label: string
  baseUrl: string
  credentialEnv?: ClaudeCodeCredentialEnv
  credentialOptional?: boolean
  defaultCredential?: string
  defaultModels?: Partial<Record<Tier, string>>
  env?: Record<string, string>
  unsetEnv?: string[]
  compat?: ClaudeCodeCompatFlags
  subagentFollowsOpus?: boolean
}

export type State = {
  version: number
  /** who pays */
  providerAccounts: Record<string, ProviderAccount>
  /** what runs */
  agentProfiles: Record<string, AgentProfile>
  /** the pairing — what `swisscode <name>` and every binding refer to */
  profiles: Record<string, Profile>
  defaultProfile: string | null
  bindings: Record<string, BindingValue>
  settings: Settings
  /** user-defined providers, alongside the shipped presets */
  providers?: Record<string, CustomProvider>
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

/**
 * The v2 profile: provider, credential, agent and agent settings on ONE object.
 *
 * Kept as a type because `fromV2` still has to read it. This is the shape v3
 * splits into `ProviderAccount` + `AgentProfile` + `Profile`, and writing it
 * down is what lets that migration be checked rather than guessed at.
 *
 * The index signature is rule M1 again, inherited from v1: unrecognized keys
 * ride along rather than being dropped, so a key written by a newer swisscode
 * survives a round-trip through an older one.
 */
export type ProfileV2 = {
  provider: string
  agent?: string
  label?: string
  baseUrl?: string
  apiKey?: string
  apiKeyFromEnv?: string
  models?: Partial<Record<Tier, string>>
  skipPermissions?: boolean
  env?: Record<string, string>
  compat?: ClaudeCodeCompatFlags
  contextWindows?: Record<string, number>
  [key: string]: unknown
}

/** The version ladder, as types. Three shapes have shipped. */
export type ConfigV2 = {
  version: number
  profiles: Record<string, ProfileV2>
  defaultProfile: string | null
  bindings: Record<string, BindingValue>
  settings: Settings
  providers?: Record<string, CustomProvider>
}

export type ConfigV3 = State

/**
 * What the migration ladder reports.
 *
 * `migratedFrom` is the ONLY thing that authorizes a write on load. Filling in
 * a missing `settings` key is not a migration and must not cause a launch that
 * merely read the file to touch the disk. It enumerates the versions that can
 * be migrated FROM — a newer-than-supported file is `readOnly` instead — so the
 * store can name the backup after the version it is preserving.
 */
export type MigrateResult = {
  state: State
  migratedFrom: 1 | 2 | null
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
