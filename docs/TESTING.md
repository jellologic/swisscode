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

npm run test:e2e                      # Tier A: the REAL binary vs a recorder
npm run test:e2e:real                 # Tier B: vs the REAL CLIs (Docker; see below)
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
| `test/e2e/*.e2e.ts` | End-to-end (hermetic) | The **real** `bin/swisscode.js`, launched against a recorder. See below. |
| `test/e2e/*.real.ts` | End-to-end (real CLIs) | The real binary vs the real coding CLIs, in Docker. See below. |
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

## The end-to-end harness

Everything above asserts on the launch **plan** — the in-memory object
`planLaunch` / `buildEnvPlan` produce. Nothing there runs the real binary and
observes what it launches. The e2e harness closes that gap, in two tiers, both
under `test/e2e/`.

**Tier A — hermetic (`*.e2e.ts`, `npm run test:e2e`, every PR).** The three
`SWISSCODE_*_BIN` overrides are pointed at `recorder.mjs` — a tiny fake agent
that writes down its own argv, env and cwd, then exits. The harness seeds a temp
config, runs the real `bin/swisscode.js`, and reads that capture. So the whole
pipeline runs for real — argv parsing, config load, resolution, env lowering,
the `execve` handoff — with no network, no credential and full determinism.

The assertion a plan test cannot make: for a third-party provider, the stale
`ANTHROPIC_API_KEY` from the polluted ambient env is **absent from the launched
child**. Present in `plan.unset` is not the same as gone from the process; only a
real launch shows the difference. This is `test/golden.test.ts`'s claim, verified
one layer further out.

The recorder is **copied** into a temp dir, never symlinked or run from inside
the repo, because swisscode's recursion guard resolves candidates with
`realpathSync` and rejects anything under its own install directory — a symlink
resolves back into the repo and is (correctly) refused. A copy under `/tmp` is
accepted exactly as a real agent would be. The recorder exiting immediately is
also why this is not the "do not launch for real" hazard `CLAUDE.md` warns
about: it is the safe launch that warning leaves room for.

**Tier B — real CLIs (`*.real.ts`, `npm run test:e2e:real`, manual only).** A
Docker image (`test/e2e/Dockerfile`) installs the three actual CLIs at pinned
versions and runs swisscode against them. It forwards only `--version`, which
every CLI answers before any auth — non-billable, no secret, no cost. It cannot
be deterministic (it depends on upstream), so it never gates a PR; it catches an
upstream flag rename or a rejected env var when someone runs it:

```sh
docker build -f test/e2e/Dockerfile -t swisscode-e2e .
docker run --rm swisscode-e2e
```

The `.real.ts` extension is deliberate: `test:e2e` globs `*.e2e.ts` and
`npm test` globs `*.test.ts`, so the three sets are disjoint and a PR that has
not installed the real CLIs stays green.

## CI

`.github/workflows/ci.yml` runs `npm test` and then `npm run test:e2e` on every
push to `main` and every pull request, across Node 22 and 24 on ubuntu and macOS.
`.github/workflows/e2e-real.yml` runs Tier B, on manual dispatch only.

Node 22 is not there for symmetry — it is the floor `engines` promises, and the
version where the toolchain assumptions have to hold: type stripping is what lets
the suite run straight from `.ts`, and `tsc`'s emit is equivalent to that stripped
program only because `target: es2023` downlevels nothing there.

The `execve` dispatch inside `createNodeProcess().replace()` is now covered — by
the e2e harness, which runs the real binary in a child process, lets it `execve`
into the recorder, and reads back what landed. Taking that branch replaces the
*child*, not the test runner, which is what makes it observable. (Even Node 22.23
backported `process.execve`, so both supported versions take the `execve` branch;
the `spawn` fallback fires only where execve is truly absent — Windows and
Node < 23.11 — and stays unit-tested via `spawnFallback` with an injected
`SignalHost`. Running the e2e under both Node versions is defence in depth, not
two different dispatches.)

Windows is deliberately not in the matrix. `execve` does not exist there, the
POSIX mode bits the config store asserts are meaningless, and nobody has verified
the suite on it; claiming coverage we do not have would be worse than the gap.
Fixing that is a genuinely useful contribution.

`publish.yml` runs the same `npm test` on a `v*` tag before publishing, so a red
tree never reaches the registry.
