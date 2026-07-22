# AGENTS.md

Brief for coding agents working in this repository. Follows the
[AGENTS.md](https://agents.md/) convention; it is the canonical agent-facing
document, and `CLAUDE.md` points here.

**Agent-written contributions are welcome and expected here.** No disclosure is
required and no checkbox asks. The one standard that applies to everyone: the
person opening the PR understands the change well enough to answer questions
about it. Read what your agent produced before you submit it.

---

## Project

`swisscode` is a **launcher**. It resolves a profile (provider + credential +
per-tier models + flags), builds a child environment, and `execve`s the real
coding CLI — `claude`, `kilo`, or `opencode` — replacing its own process image.
No proxy, no daemon, nothing left running.

TypeScript, published as compiled JavaScript. Node >= 22. Four runtime
dependencies, all reachable only from the Ink wizard.

## Commands

```sh
npm install
npm run typecheck                     # tsc --noEmit over src/ + test/; also runs test/ports.conformance.ts
npm run build                         # tsc src/ -> dist/  +  esbuild the Ink UI -> dist/ui.js
npm test                              # typecheck + build + full suite (~540 tests, ~5s). The gate.

node --test "test/core/**/*.test.ts"  # ~0.3s inner loop, NO build required
node --test test/architecture.test.ts # the invariants below
node --test test/golden.test.ts       # per-provider env contracts
node --test --test-name-pattern "binding walk" "test/**/*.test.ts"
```

Node runs `.ts` sources directly, so most suites need no build. **Exception:** the
three UI suites (`test/ui.test.ts`, `test/picker.test.ts`,
`test/profiles-ui.test.ts`) import the built `dist/ui.js` — run `npm run build`
first. `npm test` always builds.

`test/ports.conformance.ts` is intentionally *not* named `*.test.ts`: it has no
runtime assertions and is checked by `tsc`. `npm run typecheck` runs it.

## Layout

| Path | Rule |
|---|---|
| `src/core/**` | Pure domain logic. No I/O, no top-level `let`/`var`, imports nothing outside `core/` and `node:` builtins at runtime. |
| `src/ports/**` | Interfaces only. Every file must erase to exactly `export {}`. |
| `src/adapters/**` | Implementations: providers, agent CLIs, catalogs, fs, process, net, clock, doctor probe, Ink UI. |
| `src/composition/**` | Four composition roots: `launch-root` (hot path), `config-root`, `doctor-root`, `ui-root`. |
| `bin/swisscode.js` | Published entry shim. Plain JS, never compiled, imports exactly `../dist/cli.js`. |
| `test/**` | `.ts`, run from source, never compiled, never packed. |

## Hard invariants

These are enforced by `test/architecture.test.ts`, which walks the **source**
import graph. Do not work around them — they are the properties the project
sells. If a change needs to break one, that is a design discussion in an issue,
not a patch.

1. **The launch path** — the static import closure rooted at `src/cli.ts` — never
   reaches React, Ink, any `.tsx`, `node_modules`, `adapters/ui`,
   `adapters/catalog`, `config-root`, or the doctor. It never calls `fetch` and
   never imports `node:http`/`https`/`net`/`tls`/`dgram`. It stays under 40
   modules.
   **The only sanctioned escape hatch is a dynamic `import()` from `src/cli.ts`.**
2. **`core/` is pure**: no I/O, no clock, no `process.env`, no top-level mutable
   state. `dist/ui.js` inlines its own copy of `core/`, so module state would
   mean two divergent copies in one process.
3. **`ports/` carry no runtime behaviour.** Type-only, always.
4. **No `ANTHROPIC_*` or `CLAUDE_CODE_*` identifier in emitted code under `core/`
   or `ports/`.** The sole exception is `ports/claude-code.ts`. Comments may
   mention anything — the check runs post-type-erasure.
5. **Nothing under `src/` names the UI module, even in type space.** A bare
   `import type` re-adds it to the build program and ships a second, unbundled
   copy of the React tree. `src/cli.ts` declares the bundle's shape structurally;
   `test/ports.conformance.ts` checks that declaration against the real module.
6. **The reserved namespace is closed**: `config | setup | --safe | --yolo | --`
   plus the `--cc-` prefix. Everything else is forwarded to the agent verbatim.
   New commands go under `swisscode config <thing>`.
7. **stdout belongs to the launched agent.** Every warning, banner and error on
   the launch path goes to stderr. `config` and `doctor` print to stdout because
   nothing is being launched.
8. **Per-run overrides never persist.** Nothing on the launch path calls
   `store.save`; only the wizard and the `config *` subcommands write.
9. **A credential never reaches a host it was not entered for.** No "just reuse
   the key we have" fallback, anywhere.
10. **A compat flag that trades something away declares what it costs.** Entries
    in `COMPAT_ENV` may carry a `consequence`; when one is set the Claude Code
    adapter emits a `compat-consequence` warning naming it — `medium` when a
    provider imposes it, `info` when the profile asked. No descriptor may write
    such a flag's variable through its `env` block, which would set it while
    skipping the warning. (This replaced a deny-list on one variable name; see
    `ports/claude-code.ts` for why a mechanism beat a list.)

## Behavioural rules

- **Never fail silently.** Anything swisscode does that the user did not ask for
  gets a structured `EnvWarning` on stderr — a collapsed model tier, an unknown
  agent falling back, a conflicting shell variable.
- **Never guess.** Missing data means do nothing, not approximate. No measured
  context window → do not set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` at all. The
  Ollama catalog is the worked example: `/api/tags` publishes a
  `details.context_length`, and the adapter deliberately drops it, because that
  is the model's ceiling rather than the window the server actually loaded.
- **Errors name the fix.** `LaunchError` messages say what to run next.
- **Verify a capability against the real thing, not its docs.** Provider presets
  and catalog claims are load-bearing — a wrong base URL or a speculative
  capability produces confident, wrong behaviour. Ollama's `/api/tags` was
  assumed to publish neither tool support nor context length; running it proved
  both wrong. `REJECTED_PROVIDERS` records the ones that failed verification.

## TypeScript conventions

- **Relative imports name the file on disk: `'./format.ts'`, not `'./format.js'`.**
  Node's type stripper does not remap `.js` → `.ts`;
  `rewriteRelativeImportExtensions` rewrites the specifier on the way to `dist/`.
- `erasableSyntaxOnly` — no enums, namespaces, parameter properties, `declare`
  fields.
- `verbatimModuleSyntax` — `import type` for every type-only import.
- `exactOptionalPropertyTypes` — assign optional fields conditionally; never set
  one to `undefined`.
- `noUncheckedIndexedAccess` — index reads are `T | undefined`; narrow them.
- Adapters state their port at the definition site (`satisfies SomePort`, or an
  explicit return type).
- `dist/ui.js` and `dist/cli.js` are build output. `allowJs` is off, so imports
  of either carry a deliberate `@ts-expect-error`.
- No semicolons, single quotes, 2-space indent, named exports only. There is no
  formatter configured — match the file you are editing.

## Comment doctrine

Distinctive and load-bearing. Comments here **record decisions**, not mechanics:
the failure prevented, the alternative rejected and why, the non-obvious
constraint. `// increment i` has no home. A stale "why" is worse than none —
when you change what code does, the comment is part of the change.

Read `test/support/fixtures.ts` or the header of `src/cli.ts` for the register to
match.

## Where to make common changes

| Change | Touch | Test that fails if you forget |
|---|---|---|
| New provider | `adapters/providers/<id>.ts`, `providers/registry.ts` | `test/golden.test.ts` (missing `GOLDEN` entry), `test/registry.test.ts` |
| New agent CLI | `adapters/agents/<id>/index.ts`, `agents/registry.ts` | `test/adapters/agents/registry.test.ts` |
| New `config` subcommand | `composition/config-root.ts` | `test/config-commands.test.ts` |
| New compat flag | `ports/claude-code.ts` union + `agents/claude-code/env.ts` map | `test/registry.test.ts`, `test/core/compat.test.ts` |
| New model catalog | `adapters/catalog/<id>.ts`, `catalog/registry.ts`, provider's `catalogId` | `test/adapters/catalog.test.ts`, `test/registry.test.ts` |
| New port member | the port + every adapter + `test/ports.conformance.ts` | `npm run typecheck` |

Adding an agent should require **no** change to `src/core/`. If it does, the
neutral `LaunchIntent` is missing something — propose that instead.

## Before opening a PR

1. `npm test` passes.
2. New behaviour has a test; a bug fix has a test that fails without the fix.
3. Fixtures use `makeProfile` / `makeState` / `makeDescriptor` from
   `test/support/fixtures.ts` — never `as unknown as T`.
4. No new runtime dependency, anywhere near the launch path.
5. User-facing behaviour change → `README.md` updated. Invariant or convention
   change → the relevant file in `docs/` updated.
6. Commits signed off: `git commit -s`. Required for every contribution; if an
   agent wrote the code, the human running it signs.
7. One concern per PR. Do not bundle a refactor with a behaviour change.

## Do not

- Weaken, skip, or work around a test in `test/architecture.test.ts`.
- Add a top-level command word.
- Print, log, mask, truncate, or length-hint an API key. Ever.
- Reformat files you are not otherwise changing.
- Commit anything from `~/.config/swisscode`, or a real key in a test fixture.
- Add a provider preset from an unverified source — a wrong base URL or a
  speculative `[1m]` claim produces confident, wrong behaviour. See
  `REJECTED_PROVIDERS` in `src/adapters/providers/registry.ts`.

## Deeper docs

| Doc | For |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The map, the layers, the agent seam, every invariant with its rationale |
| [docs/STYLE.md](docs/STYLE.md) | How code is written here and why |
| [docs/TESTING.md](docs/TESTING.md) | The suite's structure and how to test each layer |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model and the properties the code asserts |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Workflow, review, DCO sign-off |
| [README.md](README.md) | What the tool does, from the user's side |

## Useful facts

- Config: `~/.config/swisscode/config.json` (honours `XDG_CONFIG_HOME`), `0600`
  in a `0700` directory, written atomically. v1 configs migrate on read.
- Env vars swisscode reads: `SWISSCODE_CLAUDE_BIN`, `SWISSCODE_KILO_BIN`,
  `SWISSCODE_OPENCODE_BIN`, `SWISSCODE_QUIET`, `SWISSCODE_DEBUG` (prints the
  reason `execve` fell back to `spawn`), and `SWISSCODE=1`, which it sets in the
  child as a recursion guard.
- Exit codes: doctor uses 0 clean / 1 warnings / 2 errors; launch failures are 2,
  except the recursion refusal, which is 1.
- `process.execve` needs Node 23.11+. On Node 22 the spawn fallback runs — which
  is why CI tests both.
- CI (`.github/workflows/ci.yml`) runs `npm test` on every push to `main` and
  every PR, across Node 22 + 24 on ubuntu and macOS. `publish.yml` runs it again
  on a `v*` tag before publishing via npm trusted publishing (OIDC, no token).
- A provider needing no real credential sets `credentialOptional: true` plus
  `defaultCredential` — the placeholder ships in source, is explicitly **not** a
  secret, and is excluded from the doctor's redaction set for that reason.
