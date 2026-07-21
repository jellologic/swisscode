// Argument routing.
//
// Deliberately tiny. Every token that is not in the table below belongs to
// Claude Code verbatim, so the wrapper stays a drop-in replacement instead of a
// competing arg parser.
//
// RESERVED NAMESPACE, in full:
//
//   config | setup      argv[0] only
//   --safe | --yolo     anywhere before `--`
//   --                  terminator; everything after it is Claude Code's
//   --cc-*              a single reserved PREFIX (this phase's one addition)
//   argv[0] matching    dynamic and user-created: gated by the profile-name
//   an existing profile grammar plus the soft-reserved and common-word lists in
//                       core/migrate.ts, so it can only match a name someone
//                       deliberately made
//
// The prefix was checked against the real binary before being claimed:
// `claude --help | grep -c -- '--cc'` is 0, and the only `--c*` flag is
// --chrome. Everything reserved here is escapable with `--`, which the binary
// tolerates in prompt position.
//
// Nothing else is reserved, and nothing else may be added.

import { TIERS, isTier } from './tiers.ts'
import type { Profile, ProfileOverrides } from '../ports/config-store.ts'
import type { Tier } from '../ports/provider.ts'

export const SKIP_FLAG = '--dangerously-skip-permissions'
export const CONFIG_COMMANDS = Object.freeze(['config', 'setup'])
export const CC_PREFIX = '--cc-'

/**
 * The complete set of --cc-* options. Anything else carrying the prefix is a
 * HARD ERROR rather than a passthrough token: the prefix is reserved, so a
 * typo'd `--cc-porfile` must not reach Claude Code as prompt text while the
 * launch quietly uses the wrong profile.
 */
export const CC_FLAGS = Object.freeze([
  '--cc-profile',
  '--cc-provider',
  '--cc-model',
  '--cc-base-url',
  '--cc-env',
])

export type ParsedArgv = {
  /** 'config' | 'setup' */
  command: string | null
  commandArgs: string[]
  /** --cc-* already stripped; claude never sees them */
  passthrough: string[]
  skipOverride: boolean | null
  /** --cc-profile NAME */
  profileFlag: string | null
  /** argv[0], if it could name a profile */
  positional: string | null
  overrides: ProfileOverrides
  /** set => exit 2 with this message */
  error: string | null
}

export function parseArgv(argv: string[] = []): ParsedArgv {
  const base: ParsedArgv = {
    command: null,
    commandArgs: [],
    passthrough: [],
    skipOverride: null,
    profileFlag: null,
    positional: null,
    overrides: {},
    error: null,
  }

  // Hoisted out of the original `argv.length > 0 && CONFIG_COMMANDS.includes(
  // argv[0])` so that one `!== undefined` covers both the membership test and
  // the assignment below. Equivalent for any array argv can actually be — a
  // dense `process.argv.slice(2)` — and `noUncheckedIndexedAccess` will not
  // accept `.length` as proof that index 0 is populated.
  const first = argv[0]
  if (first !== undefined && CONFIG_COMMANDS.includes(first)) {
    return { ...base, command: first, commandArgs: argv.slice(1) }
  }

  const passthrough: string[] = []
  const overrides: ProfileOverrides = {}
  let skipOverride: boolean | null = null
  let profileFlag: string | null = null
  let providerFlag: string | null = null
  let baseUrlFlag: string | null = null
  // Overrides apply strictly left to right, so a bare `--cc-model X` resets all
  // four tiers and a later `--cc-model opus=Y` refines one of them.
  let models: Partial<Record<Tier, string>> | null = null
  let env: Record<string, string> | null = null

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    // Unreachable for a dense array, which is the only kind that reaches here.
    // Present because `i < argv.length` does not prove to the compiler that
    // `argv[i]` is populated, and `continue` is a truer answer than an
    // assertion: there is genuinely nothing to route for a hole in the argv.
    if (arg === undefined) continue

    // After a bare `--`, everything belongs to Claude Code verbatim — including
    // the terminator itself, which the real binary tolerates. This is the
    // documented escape hatch for any token that collides with the table above.
    if (arg === '--') {
      passthrough.push(...argv.slice(i))
      break
    }
    if (arg === '--safe') {
      skipOverride = false
      continue
    }
    if (arg === '--yolo') {
      skipOverride = true
      continue
    }

    if (!arg.startsWith(CC_PREFIX)) {
      passthrough.push(arg)
      continue
    }

    // --cc-flag=value and --cc-flag value are both accepted. The split is on the
    // FIRST '=', so `--cc-env FOO=BAR` and `--cc-env=FOO=BAR` both work.
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? null : arg.slice(eq + 1)

    if (!CC_FLAGS.includes(name)) {
      return {
        ...base,
        error:
          `unknown option "${name}". The --cc- prefix is reserved by cuckoocode; ` +
          `valid options are ${CC_FLAGS.join(', ')}. To send this token to claude ` +
          'anyway, put it after a bare --.',
      }
    }

    let value = inline
    if (value === null) {
      const next = argv[i + 1]
      // A '-'-leading token is a flag, not a value. Consuming one would
      // silently swallow the user's next argument.
      if (next === undefined || next.startsWith('-')) {
        return { ...base, error: `${name} needs a value.` }
      }
      value = next
      i++
    }

    if (name === '--cc-profile') {
      // Not last-wins. Two different answers to "which account pays for this"
      // is not something to settle by argument order.
      if (profileFlag !== null) return { ...base, error: '--cc-profile was given more than once.' }
      profileFlag = value
      continue
    }

    if (name === '--cc-provider') {
      if (providerFlag !== null) return { ...base, error: '--cc-provider was given more than once.' }
      providerFlag = value
      continue
    }

    if (name === '--cc-base-url') {
      if (baseUrlFlag !== null) return { ...base, error: '--cc-base-url was given more than once.' }
      baseUrlFlag = value
      continue
    }

    if (name === '--cc-model') {
      const split = value.indexOf('=')
      if (split === -1) {
        // Deliberate: a bare model sets ALL FOUR tiers. [1m] is read per
        // variable, so a one-tier override is the exact shape of the silent
        // 200K bug — the safe thing has to be the easy thing.
        //
        // `all` exists only because narrowing on a `let` does not survive into
        // a callback. Same value, one binding later.
        const all = value
        models = Object.fromEntries(TIERS.map((t): [Tier, string] => [t, all]))
        continue
      }
      const tier = value.slice(0, split)
      if (!isTier(tier)) {
        return { ...base, error: `"${tier}" is not a model tier. Valid tiers: ${TIERS.join('|')}.` }
      }
      models = { ...(models ?? {}), [tier]: value.slice(split + 1) }
      continue
    }

    // --cc-env
    const split = value.indexOf('=')
    if (split === -1) {
      return { ...base, error: `--cc-env takes KEY=VALUE (KEY= unsets KEY); got "${value}".` }
    }
    const key = value.slice(0, split)
    if (key.length === 0) return { ...base, error: '--cc-env needs a variable name before the =.' }
    // '' means UNSET, exactly as in profile.env — the same user-facing contract.
    env = { ...(env ?? {}), [key]: value.slice(split + 1) }
  }

  if (providerFlag !== null) overrides.provider = providerFlag
  if (baseUrlFlag !== null) overrides.baseUrl = baseUrlFlag
  if (models !== null) overrides.models = models
  if (env !== null) overrides.env = env

  return {
    ...base,
    passthrough,
    skipOverride,
    profileFlag,
    positional: profileCandidate(argv[0]),
    overrides,
  }
}

/**
 * argv[0] if it could plausibly name a profile.
 *
 * A profile name can never start with '-' (the creation-time grammar forbids
 * it), so a flag is rejected here before the profile table is consulted at all.
 * An unknown name still falls through to claude — it was probably the first
 * word of a prompt, and that asymmetry with --cc-profile is deliberate.
 *
 * argv[0] ONLY. `cuckoocode --yolo z` sends "z" to claude, because widening
 * this to "the first non-flag token" would make an ordinary prompt word start
 * selecting accounts.
 *
 * `unknown` rather than `string`: the `typeof` check below is the real
 * contract, and the caller hands it an index read that may be undefined.
 */
function profileCandidate(first: unknown): string | null {
  if (typeof first !== 'string' || first.length === 0) return null
  if (first.startsWith('-')) return null
  return first
}

/**
 * Deliberate: the scan for an already-present skip flag does NOT stop at `--`.
 * If the user typed the flag anywhere at all, prepending a second copy is
 * worse than honouring the one they wrote.
 */
export function buildArgs(
  profile: Profile | null | undefined,
  passthrough: string[] = [],
  skipOverride: boolean | null = null,
): string[] {
  const skip = skipOverride ?? profile?.skipPermissions ?? false
  const alreadyPresent = passthrough.includes(SKIP_FLAG)
  return skip && !alreadyPresent ? [SKIP_FLAG, ...passthrough] : [...passthrough]
}
