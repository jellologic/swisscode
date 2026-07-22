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
import type { Profile, State } from '../../src/ports/config-store.ts'
import type { ProviderDescriptor } from '../../src/ports/provider.ts'
import type { ProfileSelection } from '../../src/core/profile.ts'

/**
 * A Profile fixture that omits fields the code under test does not read.
 * Everything present is checked; only absence is waived.
 */
export const makeProfile = (p: Partial<Profile>): Profile => p as Profile

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
 * standing in for a config written by a newer cuckoocode.
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
