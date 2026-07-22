# Testing

Around 540 tests, ~5 seconds for the whole suite including a full build. The
design goal is that the inner loop is fast enough that you never avoid running
it.

## Running things

```sh
npm test                              # typecheck + build + everything. The gate.
npm run typecheck                     # tsc --noEmit over src/ and test/

node --test "test/core/**/*.test.ts"  # ~0.3s, no build needed
node --test test/golden.test.ts       # one file
node --test --test-name-pattern "binding walk" "test/**/*.test.ts"
```

**Most suites need no build.** Node executes `.ts` directly, and `dist/` is
irrelevant to them. The exceptions are the three UI suites — `test/ui.test.ts`,
`test/picker.test.ts`, `test/profiles-ui.test.ts` — which drive the wizard
through the built `dist/ui.js` and therefore need `npm run build` first.
`npm test` always builds, so it is the safe default; `node --test "test/core/**"`
is the one you run every thirty seconds.

Node runs each test **file** in its own process. That is why
`test/architecture.test.ts` can monkey-patch `process.emitWarning` without
affecting anything else.

## What the suite is made of

| Path | Kind | What it holds |
|---|---|---|
| `test/core/**` | Unit | Pure-function tests for `src/core/**` and the Claude Code lowering. Fast, exhaustive, no I/O. |
| `test/adapters/**` | Adapter | The filesystem config store, the process adapter, the doctor probe, the catalogs, each agent adapter. |
| `test/architecture.test.ts` | Structural | The layering and launch-path invariants, asserted against the source import graph. |
| `test/ports.conformance.ts` | Type-level | The whole adapter surface bound against the whole port surface. **Not** a `*.test.ts`. |
| `test/golden.test.ts` | Characterization | The exact environment every shipped provider hands to Claude Code. |
| `test/registry.test.ts` | Invariant | Descriptor rules every provider must satisfy. |
| `test/ui.test.ts`, `picker`, `profiles-ui` | End-to-end | The Ink wizard, driven with synthetic keystrokes. |
| `test/config-commands.test.ts`, `launch-overrides.test.ts` | Integration | Subcommand dispatch and the override pipeline through a composition root. |
| `test/support/fixtures.ts` | Helper | Typed constructors for deliberately incomplete domain objects. |

### The four that are unusual

**`architecture.test.ts`** walks the static import closure from `src/cli.ts` and
asserts what it must *never* reach — React, Ink, `node_modules`, `.tsx`,
`adapters/ui`, `adapters/catalog`, `config-root`, the doctor, `fetch`, network
`node:` modules — plus the layering rules for `core/` and `ports/`.

Two properties make it trustworthy. It asserts on the **import graph**, not on
startup time, so a loaded CI box cannot make it flake. And the layering checks
run **post-type-erasure** (via `node:module`'s `stripTypeScriptTypes`), so they
check the program the file actually becomes: a comment mentioning
`ANTHROPIC_API_KEY` passes, emitted code naming it fails, and a mixed
`import {type A, b}` — which keeps a live runtime binding — correctly fails where
a regex over the source could not tell the difference.

**`ports.conformance.ts`** is checked by `tsc`, not by `node --test`. It has no
runtime assertions, which is why it is deliberately misnamed: `node --test` skips
it and `npm run typecheck` runs it. It lives in `test/` rather than `src/`
because `tsconfig.build.json` emits `src/` to `dist/`, and a file whose only
purpose is compile-time checking must not ship.

**`golden.test.ts`** pins the exact env map each provider produces against one
fixed, deliberately polluted ambient environment (a stale `ANTHROPIC_API_KEY`, a
stale `ANTHROPIC_BASE_URL`, stale tier models). Those maps **are** the contract.
A change to one is fine; a change to one that does not update the golden map is
not — the point is that a human reads the diff on purpose. Its header comments
record every intentional change since 0.1.0 and why, which is the format to
follow when you change one.

Adding a provider without adding its `GOLDEN` entry fails on a dedicated test:
`every shipped provider has a golden map`.

**`registry.test.ts`** generates a test per provider for each descriptor
invariant: no hand-typed `[1m]`, no `/v1` suffix on a base URL, third-party
endpoints always clear `ANTHROPIC_API_KEY`, `extendedContext` agrees with
`defaultModels`, and compat flags are real. A new provider inherits all of them
for free.

It also holds the rule that a compat flag which **trades something away** must
declare what — and that no descriptor may write that flag's variable through the
`env` block, since `env` would set it while skipping the warning the compat
mechanism attaches. That replaced a deny-list naming one variable: the objection
was always that a costly switch must not act silently, which is a property of
the mechanism rather than of any one name, and a deny-list does not generalise to
the next provider with its own rules.

## Fixtures: the rule about incomplete objects

Tests routinely pass deliberately incomplete domain objects — `{apiKey: 'k'}`
where the type says `Profile`. That is the point of them: a unit test for
`buildEnvPlan` has no business inventing a `provider` field the function never
reads, and filling it in to satisfy the compiler would change the input under
test.

So use the constructors in `test/support/fixtures.ts`:

```ts
import { makeProfile, makeState, makeDescriptor } from '../support/fixtures.ts'

const profile = makeProfile({ apiKey: 'k', models: { opus: 'glm-5.2' } })
```

They are identity functions — no field added, none removed, same object identity.
What they buy is that the argument is checked in full against `Partial<Profile>`
in a fresh-literal position: a misspelled key is `TS2561`, a wrong value type is
`TS2322`, nested types are checked. **Only missingness is waived.**

`x as unknown as Profile` is explicitly rejected: it compiles always and checks
nothing, so a typo'd field goes silently into the fixture. The file's header
comment explains why plain `x as Profile` also fails once a fixture sets a
`Record<string, T>` field.

## Writing a new test

**Domain logic** → `test/core/<module>.test.ts`. Plain `node:test` + `node:assert/strict`.
Call the pure function directly with fixtures. No mocks needed, because there is
nothing to mock.

**An adapter** → `test/adapters/…`. Inject fakes through the port; the composition
roots all take a `LaunchDeps` bag for exactly this reason.

```ts
const proc = { env: () => ({}), cwd: () => '/tmp', resolveBinary: …, replace: … }
const planned = planLaunch({ store, registry, agents, proc, /* … */ })
```

Counting stubs are a good pattern here: `test/core/overrides.test.ts` pins "per-run
overrides never persist" with a `store.save` that counts calls and asserts zero.

**A new invariant** → add it to `test/architecture.test.ts` next to its siblings,
and state it in [ARCHITECTURE.md](ARCHITECTURE.md#invariants) too. A rule
documented but not enforced will be broken within two releases.

**A UI change** → the three wizard suites drive Ink with `ink-testing-library` and
synthetic keystrokes, written with `React.createElement` rather than JSX so they
run under plain `node` with no build of their own. They set `XDG_CONFIG_HOME` to
a temp directory; never let a test touch the real `~/.config/swisscode`.

## House rules

- **A bug fix ships with a test that fails without the fix.** If you cannot write
  one, say so in the PR and explain why — sometimes that is a legitimate answer,
  and it is a useful thing for a reviewer to know.
- **No wall-clock assertions.** Nothing may assert "this was fast". Assert on the
  structure that makes it fast.
- **No network in tests.** The doctor's probe is tested through an injected fake.
  The only code allowed to make a real request is `adapters/doctor/probe`, and it
  only runs when a user asks for `config doctor`.
- **Deterministic or it does not merge.** No reliance on ordering that is not
  guaranteed, on real time, or on a machine's installed binaries.
- **Tests are read as documentation.** Name them as sentences describing the
  property: `an unknown positional falls through, an unknown flag does not`,
  `no launch inherits a stale ANTHROPIC_API_KEY it did not ask for`.

## CI

`.github/workflows/ci.yml` runs `npm test` on every push to `main` and every pull
request, across Node 22 and 24 on ubuntu and macOS.

Node 22 is not there for symmetry — it is the floor `engines` promises, and the
version where the toolchain assumptions have to hold: type stripping is what lets
the suite run straight from `.ts`, and `tsc`'s emit is equivalent to that stripped
program only because `target: es2023` downlevels nothing there.

One thing it does **not** buy, despite being the version where `process.execve`
does not exist: extra coverage of the spawn fallback. `spawnFallback` is called
directly with an injected `SignalHost`, so it is exercised on every version, and
nothing asserts on the dispatch inside `createNodeProcess().replace()` — taking
the `execve` branch would replace the test process. The runtime difference is
real; the test difference is not.

Windows is deliberately not in the matrix. `execve` does not exist there, the
POSIX mode bits the config store asserts are meaningless, and nobody has verified
the suite on it; claiming coverage we do not have would be worse than the gap.
Fixing that is a genuinely useful contribution.

`publish.yml` runs the same `npm test` on a `v*` tag before publishing, so a red
tree never reaches the registry.
