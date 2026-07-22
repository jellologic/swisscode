// Which profile is this launch using?
//
// Resolution order:
//
//   tier 1a  positional argv[0] profile match
//   tier 1b  --cc-profile NAME
//   tier 2   nearest-ancestor directory binding
//   tier 3   defaultProfile
//   tier 4   nothing -> the wizard
//
// 1a and 1b are the SAME tier, not a fallback chain. Two explicit selectors
// naming different profiles is a conflict, and conflicts about which account
// pays are not resolved by precedence — see R-CONFLICT below.

import { resolveBinding } from './binding.ts'
import type { Profile, ProfileOverrides, State } from '../ports/config-store.ts'

/**
 * How the active profile was chosen. Mirrors `DoctorReport.source` in
 * ports/doctor.ts, which reports this value straight through.
 */
export type ProfileSource = 'positional' | 'flag' | 'binding' | 'default'

export type ProfileSelection = {
  name: string | null
  profile: Profile | null
  source: ProfileSource | null
  bindingKey?: string
  overrides: ProfileOverrides
  warnings: string[]
  ambiguous: boolean
  consumedPositional: boolean
  /** set => the caller refuses the launch and prints this */
  error: string | null
}

export type ResolveProfileOptions = {
  cwd?: string | null
  platform?: string
  positional?: string | null
  profileFlag?: string | null
}

const has = (obj: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(obj, key)

export function resolveProfile(
  state: State,
  {
    cwd = null,
    platform = 'linux',
    positional = null,
    profileFlag = null,
  }: ResolveProfileOptions = {},
): ProfileSelection {
  const profiles = state?.profiles ?? {}
  const names = Object.keys(profiles)
  const warnings: string[] = []
  const none: ProfileSelection = {
    name: null,
    profile: null,
    source: null,
    overrides: {},
    warnings,
    ambiguous: false,
    consumedPositional: false,
    error: null,
  }

  // The `?? null` is unreachable: every call below is guarded by a `has()`
  // check on the same name, so the lookup always hits. It is there because
  // `hasOwnProperty` does not narrow a later index access for the compiler, and
  // a one-token coalesce is a better answer than an assertion that switches off
  // the check `noUncheckedIndexedAccess` exists to make. `null` rather than
  // `undefined` because `null` is what this field already means everywhere.
  const hit = (
    name: string,
    source: ProfileSource,
    extra: Partial<ProfileSelection> = {},
  ): ProfileSelection => ({
    ...none,
    name,
    profile: profiles[name] ?? null,
    source,
    ...extra,
  })

  // A positional token only counts once it MATCHES a real profile. An unknown
  // one is almost always the first word of a prompt.
  const positionalHit = positional && has(profiles, positional) ? positional : null

  // tier 1b: the flag.
  // R-ASYMMETRY: an unknown --cc-profile is a hard error while an unknown
  // positional falls through. The flag is an unambiguous assertion of intent;
  // quietly ignoring it is how a launch ends up billed to the wrong account.
  if (profileFlag !== null) {
    if (!has(profiles, profileFlag)) {
      return {
        ...none,
        error:
          `--cc-profile "${profileFlag}" is not a profile. ` +
          (names.length > 0
            ? `Known profiles: ${names.join(', ')}.`
            : 'No profiles exist yet — run `cuckoocode config` first.'),
      }
    }
    // R-CONFLICT: both selectors present and disagreeing. Do not guess.
    if (positionalHit && positionalHit !== profileFlag) {
      return {
        ...none,
        error:
          `conflicting profiles: "${positionalHit}" was given positionally and ` +
          `"${profileFlag}" via --cc-profile. Pick one.`,
      }
    }
    return hit(profileFlag, 'flag', { consumedPositional: positionalHit !== null })
  }

  // tier 1a: the positional.
  if (positionalHit) return hit(positionalHit, 'positional', { consumedPositional: true })

  if (names.length === 0) return none

  // tier 2: the binding.
  // Short-circuited entirely when tier 1 produced anything: the walk above
  // returned before reaching here.
  if (cwd) {
    const bound = resolveBinding(cwd, state?.bindings, state?.settings, platform)
    if (bound) {
      if (has(profiles, bound.name)) {
        return hit(bound.name, 'binding', {
          bindingKey: bound.key,
          overrides: bound.overrides ?? {},
        })
      }
      // A binding pointing at a deleted profile is not worth blocking a launch
      // over; fall through and say so once.
      warnings.push(
        `binding for ${bound.key} points at profile "${bound.name}", which no longer exists.`,
      )
    }
  }

  // tier 3: the default.
  if (state?.defaultProfile && has(profiles, state.defaultProfile)) {
    return hit(state.defaultProfile, 'default')
  }

  // More than one profile and nothing chose between them. Picking the
  // alphabetically first one would silently select an account to bill.
  if (names.length > 1) return { ...none, ambiguous: true }

  return none
}
