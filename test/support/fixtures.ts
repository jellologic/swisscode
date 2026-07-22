// Fixture constructors for the test suite.
//
// WHY THIS FILE EXISTS
//
// Tests routinely pass DELIBERATELY INCOMPLETE domain objects: `{apiKey: 'k'}`
// where the type says `Profile`, `{profiles: {}}` where it says `State`. That is
// not sloppiness in the tests — it is the point of them. A unit test for
// buildEnvPlan has no business inventing a `provider` field that buildEnvPlan
// never reads, and filling those fields in to satisfy the compiler would change
// the input under test.
//
// So the incompleteness has to survive. The only question is how much checking
// survives WITH it.
//
//   `x as Profile`                  loses nothing on simple literals, but does
//                                   not compile once the fixture sets a field
//                                   typed Record<string, T> (`env`,
//                                   `contextWindows`): a fresh literal gets an
//                                   implicit index signature when ASSIGNED, and
//                                   does not when ASSERTED. TS2352.
//   `x as unknown as Profile`       compiles always, and checks nothing. A
//                                   typo'd or wrongly-typed field goes silently
//                                   into the fixture. Rejected.
//   `makeProfile({...})` (this)     the argument is checked in full against
//                                   Partial<Profile> in a fresh-literal
//                                   position: misspelled keys are TS2561, wrong
//                                   value types are TS2322, nested types are
//                                   checked too. ONLY missingness is waived.
//
// These are identity functions. They add no field, remove no field, and copy
// nothing — the object the test writes is the object the code under test
// receives, with the same identity. All they do is carry a type claim across a
// boundary the compiler cannot see across on its own.
import type {
  AgentProfile,
  Profile,
  ProviderAccount,
  ResolvedProfile,
  State,
} from '../../src/ports/config-store.ts'
import type { ProviderDescriptor } from '../../src/ports/provider.ts'
import type { ProfileSelection } from '../../src/core/profile.ts'

/**
 * A RESOLVED profile fixture — the flattened account + agent profile that
 * everything downstream of resolution consumes.
 *
 * Named `makeProfile` still, and deliberately: it is used by roughly twenty
 * suites that test `buildEnvPlan`, `buildIntent` and the agent adapters, none
 * of which changed when the stored schema split in three. Renaming it would
 * have implied those tests were testing something new. They are not — that is
 * the whole point, and `test/golden.test.ts` passing unchanged is the proof.
 *
 * `accountName`/`agentProfileName` are defaulted rather than required because
 * no consumer downstream of resolution reads them; they exist so a caller can
 * REPORT which account paid. A fixture that had to invent both every time would
 * add noise to twenty files for a field under test in none of them.
 */
export const makeProfile = (p: Partial<ResolvedProfile>): ResolvedProfile =>
  ({ accountName: 'acct', agentProfileName: 'agent', ...p }) as ResolvedProfile

/** A stored `Profile` — references only. For tests about the pairing itself. */
export const makeProfileRefs = (p: Partial<Profile>): Profile => p as Profile

/** A stored provider account. For tests about credentials and retargeting. */
export const makeAccount = (a: Partial<ProviderAccount>): ProviderAccount => a as ProviderAccount

/** A stored agent profile. For tests about models, permissions and compat. */
export const makeAgentProfile = (a: Partial<AgentProfile>): AgentProfile => a as AgentProfile

/**
 * A v3 state built from ONE profile's worth of flat v2-shaped fields.
 *
 * The migration produces exactly this 1:1:1 arrangement, and so does the
 * wizard, so a test that just needs "a state with a working profile named N"
 * can say so without spelling three objects. Tests that are ABOUT the split —
 * multi-account profiles, shared agent profiles — build the maps explicitly.
 */
export const makeSimpleState = (
  name: string,
  flat: Partial<ResolvedProfile>,
  rest: Partial<State> = {},
): State =>
  ({
    version: 3,
    providerAccounts: {
      [name]: {
        provider: flat.provider,
        ...(flat.baseUrl !== undefined ? { baseUrl: flat.baseUrl } : {}),
        ...(flat.apiKey !== undefined ? { apiKey: flat.apiKey } : {}),
        ...(flat.apiKeyFromEnv !== undefined ? { apiKeyFromEnv: flat.apiKeyFromEnv } : {}),
      },
    },
    agentProfiles: {
      [name]: {
        ...(flat.agent !== undefined ? { agent: flat.agent } : {}),
        ...(flat.models !== undefined ? { models: flat.models } : {}),
        ...(flat.skipPermissions !== undefined ? { skipPermissions: flat.skipPermissions } : {}),
        ...(flat.env !== undefined ? { env: flat.env } : {}),
        ...(flat.compat !== undefined ? { compat: flat.compat } : {}),
        ...(flat.contextWindows !== undefined ? { contextWindows: flat.contextWindows } : {}),
      },
    },
    profiles: { [name]: { agentProfile: name, accounts: [name], strategy: 'single' } },
    defaultProfile: name,
    bindings: {},
    settings: {},
    ...rest,
  }) as unknown as State

/**
 * A State fixture that omits fields the code under test does not read.
 *
 * Worth knowing while reading these: core/profile.ts's `resolveProfile` opens
 * with `state?.profiles ?? {}`, so the implementation has always tolerated far
 * less than `State` promises. The tests exercise that tolerance deliberately.
 */
export const makeState = (s: Partial<State>): State => s as State

/**
 * A ProviderDescriptor fixture that omits fields the code under test does not
 * read — e.g. a deliberately "invented" provider that no registry knows about,
 * standing in for a config written by a newer swisscode.
 */
export const makeDescriptor = (d: Partial<ProviderDescriptor>): ProviderDescriptor =>
  d as ProviderDescriptor

/**
 * A ProfileSelection fixture.
 *
 * Same rule as the others: the tests that use this exercise `staticChecks`,
 * which reads a handful of the selection's fields, so `ambiguous` and
 * `consumedPositional` are deliberately absent rather than invented.
 */
export const makeSelection = (s: Partial<ProfileSelection>): ProfileSelection =>
  s as ProfileSelection
