// Turn a selected profile into the one account + agent profile a launch uses.
//
// `core/profile.ts` answers WHICH profile (positional / flag / binding /
// default). This answers what that profile actually resolves to, which since v3
// means dereferencing an agent profile and choosing among one or more accounts.
//
// Pure, and pure on purpose: strategy selection is the step that decides WHICH
// ACCOUNT PAYS, so it must be exhaustively testable without a store, a clock or
// a network.
//
// EVERY STRATEGY RESOLVES ONCE, BEFORE execve. swisscode ceases to exist at
// handoff, so there is no per-request rotation and no mid-session failover here
// — those need a process in the data path, which is the proxy this tool is not.

import type {
  ProviderAccount,
  ResolvedProfile,
  SelectionStrategy,
  State,
} from '../ports/config-store.ts'

/**
 * What the launch path needs, or why it cannot be produced.
 *
 * A discriminated union rather than a nullable result: on the error branch
 * there is genuinely no resolved profile, and `reason` is a message that names
 * the fix — the same contract `LaunchError` messages hold themselves to.
 */
export type Resolution =
  | { ok: true; resolved: ResolvedProfile; warnings: string[] }
  | { ok: false; reason: string }

/**
 * Where a rotation cursor is remembered between launches.
 *
 * Injected rather than read here, because this module is pure and because the
 * cursor deliberately does NOT live in config.json — the launch path writes no
 * config, and a rotation counter is not configuration. See
 * `adapters/store/fs-cursor-store.ts`.
 *
 * `read` returning null (no cursor yet, unreadable file, whatever) is a normal
 * state and simply starts the rotation at zero.
 */
export type CursorPort = {
  read: (profileName: string) => number | null
  /** best effort; a failed write must never block a launch */
  advance: (profileName: string, next: number) => void
}

/**
 * A cached usage snapshot, refreshed at CONFIGURATION time (doctor, web UI).
 *
 * Never fetched here. The launch path may not reach the network, so `usage`
 * selection reads what was last measured and reports how old it is rather than
 * pretending to know the current figure.
 */
export type UsageSnapshot = {
  /** account name -> remaining capacity, higher is more */
  remaining: Record<string, number>
  /** epoch ms when it was measured */
  checkedAt: number
}

export type ResolveOptions = {
  cursor?: CursorPort | null
  usage?: UsageSnapshot | null
  /** for reporting snapshot age; injected so this stays pure */
  now?: number
}

/** Flatten an account and an agent profile into the shape a launch consumes. */
function flatten(
  accountName: string,
  account: ProviderAccount,
  agentProfileName: string,
  state: State,
): ResolvedProfile {
  const agentProfile = state.agentProfiles?.[agentProfileName] ?? {}
  const resolved: ResolvedProfile = {
    accountName,
    agentProfileName,
    provider: account.provider,
  }
  // Assigned conditionally throughout: `exactOptionalPropertyTypes` makes
  // "absent" and "present but undefined" different types, and the env builder
  // branches on presence — `apiKey: undefined` would not mean the same thing as
  // no apiKey at all.
  if (account.baseUrl !== undefined) resolved.baseUrl = account.baseUrl
  if (account.apiKey !== undefined) resolved.apiKey = account.apiKey
  if (account.apiKeyFromEnv !== undefined) resolved.apiKeyFromEnv = account.apiKeyFromEnv

  if (agentProfile.agent !== undefined) resolved.agent = agentProfile.agent
  if (agentProfile.models !== undefined) resolved.models = agentProfile.models
  if (agentProfile.skipPermissions !== undefined) {
    resolved.skipPermissions = agentProfile.skipPermissions
  }
  if (agentProfile.env !== undefined) resolved.env = agentProfile.env
  if (agentProfile.compat !== undefined) resolved.compat = agentProfile.compat
  if (agentProfile.contextWindows !== undefined) {
    resolved.contextWindows = agentProfile.contextWindows
  }
  return resolved
}

/**
 * Pick one account name from the profile's list.
 *
 * Returns the choice AND any warning the choice deserves, because two of the
 * three strategies can silently degrade — a rotation with no cursor store, or
 * `usage` with no snapshot — and degrading quietly about WHICH ACCOUNT PAYS is
 * the failure this whole codebase is arranged to prevent.
 */
export function selectAccount(
  profileName: string,
  accounts: string[],
  strategy: SelectionStrategy,
  { cursor = null, usage = null, now = 0 }: ResolveOptions = {},
): { name: string; warnings: string[] } {
  const warnings: string[] = []
  // `accounts[0]` is checked by the caller before this runs; the `?? ''` is for
  // `noUncheckedIndexedAccess` and is unreachable.
  const first = accounts[0] ?? ''
  if (accounts.length === 1 || strategy === 'single') return { name: first, warnings }

  if (strategy === 'round-robin') {
    if (!cursor) {
      warnings.push(
        `profile "${profileName}" rotates between accounts, but no cursor store is ` +
          `available, so it used "${first}". Every launch will use the same account.`,
      )
      return { name: first, warnings }
    }
    const previous = cursor.read(profileName) ?? -1
    const index = (previous + 1) % accounts.length
    cursor.advance(profileName, index)
    return { name: accounts[index] ?? first, warnings }
  }

  // 'usage'
  if (!usage) {
    warnings.push(
      `profile "${profileName}" selects by remaining capacity, but nothing has measured ` +
        `it yet, so it used "${first}". Run \`swisscode config doctor\` to refresh usage.`,
    )
    return { name: first, warnings }
  }
  const known = accounts.filter((a) => typeof usage.remaining[a] === 'number')
  if (known.length === 0) {
    warnings.push(
      `profile "${profileName}" selects by remaining capacity, but none of its accounts ` +
        `reports any, so it used "${first}".`,
    )
    return { name: first, warnings }
  }
  // Highest remaining wins; ties keep the earlier-listed account, so the order
  // the user wrote is the tiebreak rather than object-key order.
  let best = known[0] ?? first
  for (const name of known) {
    if ((usage.remaining[name] ?? -1) > (usage.remaining[best] ?? -1)) best = name
  }
  const ageMinutes = Math.max(0, Math.round((now - usage.checkedAt) / 60_000))
  warnings.push(
    `selected "${best}" by remaining capacity, measured ${ageMinutes} minute(s) ago. ` +
      'swisscode cannot check this at launch, so the figure is as fresh as the last check.',
  )
  return { name: best, warnings }
}

/**
 * Resolve a profile by name.
 *
 * Every failure names the fix rather than reporting a shape mismatch: a config
 * that dangles is something a person has to repair, and "profile X references
 * agent profile Y, which does not exist" is the whole diagnosis.
 */
export function resolveProfileRefs(
  state: State,
  profileName: string,
  options: ResolveOptions = {},
): Resolution {
  const profile = state.profiles?.[profileName]
  if (!profile) return { ok: false, reason: `profile "${profileName}" does not exist.` }

  const agentProfileName = profile.agentProfile
  if (!agentProfileName || !state.agentProfiles?.[agentProfileName]) {
    return {
      ok: false,
      reason:
        `profile "${profileName}" uses agent profile "${agentProfileName ?? '—'}", which does ` +
        'not exist. Run `swisscode config ' + profileName + '` to repair it.',
    }
  }

  const accounts = Array.isArray(profile.accounts) ? profile.accounts.filter(Boolean) : []
  if (accounts.length === 0) {
    return {
      ok: false,
      reason:
        `profile "${profileName}" has no provider account, so there is nothing to ` +
        'authenticate with. Run `swisscode config ' + profileName + '` to add one.',
    }
  }

  // Dangling account references are dropped with a warning rather than being
  // fatal: a profile with three accounts and one stale reference should still
  // launch on the other two.
  const warnings: string[] = []
  const live = accounts.filter((name) => {
    if (state.providerAccounts?.[name]) return true
    warnings.push(
      `profile "${profileName}" references account "${name}", which no longer exists; skipping it.`,
    )
    return false
  })

  if (live.length === 0) {
    return {
      ok: false,
      reason:
        `profile "${profileName}" references ${accounts.length} provider account(s), none of ` +
        'which exist any more. Run `swisscode config accounts` to see what is left.',
    }
  }

  const strategy = profile.strategy ?? 'single'
  const picked = selectAccount(profileName, live, strategy, options)
  warnings.push(...picked.warnings)

  // Present: `live` was filtered on exactly this lookup.
  const account = state.providerAccounts?.[picked.name]
  if (!account) {
    return { ok: false, reason: `account "${picked.name}" disappeared during resolution.` }
  }

  return {
    ok: true,
    resolved: flatten(picked.name, account, agentProfileName, state),
    warnings,
  }
}
