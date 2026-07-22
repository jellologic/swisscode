# Style — the project's DNA

This is not a formatting guide with a personality section bolted on. Formatting
is the last two pages. The rest is the set of judgements that make this codebase
look the way it does, written down so a contributor — human or agent — can make a
change that reads like it was always there.

Read this once. After that, the codebase itself is the reference: it is small
(~7k lines of `src/`), consistent, and the comments explain themselves.

---

## 1. The failure modes decide the design

swisscode does something simple with something dangerous. It handles API keys, it
constructs the environment another program runs in, and then it disappears. The
worst bugs it can have are not crashes — they are **silent successes**:

- a z.ai token POSTed to OpenRouter because a flag retargeted the provider and
  kept the key
- an Anthropic account billed because a stale `ANTHROPIC_API_KEY` was inherited
  from the shell
- three model tiers at a 1M window and the fourth at 200K, no error, no warning
- a typo'd `--cc-porfile` forwarded to the agent as prompt text while the launch
  quietly used the wrong account

Every one of those looks like it worked. So the standing question when reviewing
any change here is not "does this work?" but **"what does this do wrong,
silently?"** If the answer is "nothing, because it cannot compile / cannot type /
has a test", the change is in the house style.

## 2. Make it a compile error

Preferred, in order: **compile error → test failure → runtime error → warning →
comment**. Reach for the leftmost one that can express the constraint.

The codebase does this constantly, and it is worth recognising the moves:

- **`satisfies` at the definition site.** `registry` in
  `adapters/providers/registry.ts` and `adapters/agents/registry.ts` assert their
  port where they are *defined*, not where a consumer happens to annotate. Drift
  becomes a compile error in the file that drifted.
- **Unions instead of strings.** `ClaudeCodeCompatFlag` is a union of the six
  real flags, so a misspelled flag in a descriptor or a profile is a compile
  error instead of a lookup that silently misses.
- **Discriminated unions instead of optional fields.** `PlannedLaunch` is
  `LaunchNeedsSetup | LaunchPlan`, discriminated on `needsSetup`. That is what
  makes `if (!planned.needsSetup) return` a real narrowing — on the setup branch
  `planned.args` does not exist, rather than existing and being `undefined`.
- **`readonly` that matches reality.** The registries are `Object.freeze`d, so
  they are typed `readonly`. The previous annotation said mutable and nothing
  checked, so type and value had quietly disagreed since the array was written.
- **A conformance file the compiler runs.** `test/ports.conformance.ts` has no
  runtime assertions at all.

The compiler options are turned up for the same reason and are not negotiable:
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitReturns`, `noFallthroughCasesInSwitch`, `noImplicitOverride`,
`erasableSyntaxOnly`, `verbatimModuleSyntax`, `isolatedModules`.

`exactOptionalPropertyTypes` in particular changes how you write: an optional
field is **conditionally assigned**, never set to `undefined`.

```ts
// yes
const intent: LaunchIntent = { baseUrl, credential, models, skipPermissions }
if (profile?.contextWindows) intent.contextWindows = profile.contextWindows

// no — `{ contextWindows: undefined }` is not the same type as absent
const intent = { ..., contextWindows: profile?.contextWindows }
```

## 3. Never fail silently, never guess

Two rules that generate most of the behaviour users notice.

**Never silently.** If swisscode does something the user did not literally ask
for, it says so on stderr. A dropped model tier produces a `tier-collapsed`
warning naming exactly which tiers were ignored. An unknown agent id in a stored
profile falls back to the default *and* warns. An unrecognised `--cc-*` option is
exit 2 rather than a passthrough token, because forwarding it would put it in the
prompt while the launch used the wrong settings.

Warnings are structured (`{severity, code, message}`), not bare strings, because
the doctor maps `info` to an `ok` check and the others to warnings, which decides
its exit code.

**Never guess.** Where the data required to be correct is missing, do nothing:

- no measured context window → `CLAUDE_CODE_AUTO_COMPACT_WINDOW` is not set at
  all. A guessed window that is too large means the conversation overflows
  instead of compacting
- unknown provider and no `baseUrl` → refuse to launch, rather than defaulting to
  Anthropic and billing the wrong account
- `--cc-provider` with no credential for the new host → exit 2. There is no "just
  send the key we have" fallback, and models are dropped alongside the key
  because `glm-5.2` sent to OpenRouter is a guaranteed 404 wearing the costume of
  a working config

A "sensible default" that can be wrong in a way the user cannot see is not
sensible. Prefer the refusal with a message naming the fix.

## 4. Comments record decisions, not mechanics

This is the most visible thing about the codebase and the easiest to get wrong.
The comments here are long, and they are long for one reason: **they preserve the
reasoning that constrains the next edit**. They do not narrate the code.

A comment earns its place if it records at least one of:

- **the failure it prevents** — "a stale key left in your shell makes Claude Code
  fall back to Anthropic and bill that account"
- **the alternative that was rejected, and why** — `test/support/fixtures.ts`
  enumerates three ways to type an incomplete fixture and explains what each one
  loses. Nobody will re-litigate that now
- **a non-obvious constraint** — "`exclude` only filters the `include` globs, so
  a type-only import silently re-adds the module to the emit"
- **why the obvious thing is wrong here** — `LaunchError` declares `exitCode` by
  interface merging rather than as a class field, because a field declaration
  emits an extra statement under `useDefineForClassFields`

It does not earn its place if it says what the next line says. `// increment i`
has no home here, and neither does a JSDoc block that restates the signature.

Two supporting habits:

- **Load-bearing detail gets stated as load-bearing.** "Both spellings are
  Anthropic's. The choice is load-bearing rather than cosmetic —
  `ANTHROPIC_API_KEY` triggers Claude Code's one-time approval prompt."
- **Rejections are recorded where someone would re-add them.**
  `REJECTED_PROVIDERS` is a shipped constant, not a wiki page, so the reason
  iFlow is absent is next to the list it is absent from.

When you delete code, delete its comment. When you change what code does, the
comment is part of the change — a stale "why" is worse than none, because it is
believed.

## 5. DRY, with a specific exception

Deduplicate behaviour aggressively. `agents/shared.ts` exists because Kilo and
OpenCode lower an intent almost identically; `makeEnvWriter` is the one env-write
primitive every adapter shares; `LaunchDeps` is declared once and imported by all
four composition roots.

**The exception: prefer a checked duplicate over an import that breaks a
boundary.** Two live examples, both deliberate:

- `src/cli.ts` spells `WizardMode` locally instead of importing it from
  `config-root`, and declares the UI bundle's shape structurally instead of
  querying `typeof import(...)`. A static `import type` of either would put those
  modules into the launch path's *source* graph, which is what the architecture
  test reads.
- `config-root.ts` declares its `OpenUi` callback type locally for the same
  reason.

Neither is a blind copy. `openUi` is passed to `runConfigCommand`, so if the two
`WizardMode` unions ever drift the call stops compiling; and
`test/ports.conformance.ts` checks the structural `UiModule` against the real
`ui-root`. **A duplicate is acceptable when something fails if the copies
disagree.** An unchecked duplicate is a bug waiting to be found by a user.

## 6. Purity is a boundary, not an aesthetic

`core/` is pure because two copies of it run in one process — `dist/ui.js`
inlines its own — and because pure functions are the only part of a launcher you
can test exhaustively in 0.3 seconds. That is the payoff, and it is why the rules
are mechanical rather than tasteful:

- no I/O, no clock, no randomness, no `process.env` reads
- no top-level `let` or `var` — no mutable module state, ever
- imports nothing outside `core/` and `node:` builtins at runtime

Adapters own everything the core is not allowed to touch, and they own it
narrowly: `adapters/process` is the only module that resolves a binary or reaches
the filesystem on behalf of a launch, which is why `AgentCliPort.binary` is
*declarative data* (name + fallbacks + override env var) rather than a function
that goes looking. That keeps `adapters/agents/**` filesystem-free and cheap
enough to sit on the launch path.

When something needs a dependency the core cannot have, the answer is a port, not
an exception.

## 7. Small surfaces, closed namespaces

The reserved namespace is `config | setup | --safe | --yolo | --` plus the
`--cc-` prefix. **It does not grow.** Everything else is forwarded verbatim,
which is what makes the tool a drop-in — `swisscode fix the login bug` has to
keep working, and so does a profile named after whatever word you like.

That constraint is why every subcommand lives under `config`: `swisscode use`
would claim an English word from the agent's prompt space forever. The cost is
six characters; the alternative is unrecoverable.

Apply the same instinct to APIs inside the codebase. `core/args.ts` opens with
"deliberately tiny — every token not in the table below belongs to Claude Code
verbatim", and that is a design statement, not modesty.

## 8. Security is a property of the code, not a review step

The full threat model is in [SECURITY.md](SECURITY.md). The habits it produces:

- **A credential is scoped to the host it was entered for.** Any code path that
  moves a key must answer "to which host, and did the user enter it for that
  host?" Retargeting borrows the key, endpoint *and* models together, or fails.
- **Nothing prints a key.** Not masked, not truncated, not length-hinted. The
  doctor redacts anything a gateway echoes back, so its report is safe to paste
  into a bug thread. New output paths inherit this obligation.
- **Clear what you do not own.** A non-Anthropic launch strips `ANTHROPIC_API_KEY`
  from the child environment. Both agent families implement that guard.
- **Secrets on disk are `0600` in a `0700` directory**, written atomically via a
  temp file.
- **Refuse, do not warn, when the cost is money or a leaked key.**

## 9. Tests are the specification

See [TESTING.md](TESTING.md) for mechanics. The style points:

- **Architectural claims get architectural tests.** Every invariant in
  ARCHITECTURE.md is enforced by `test/architecture.test.ts`, and it asserts on
  the *import graph*, not on wall-clock startup time, so it cannot flake on a
  loaded CI box. If you state a rule in a doc, add the test that keeps it true.
- **Golden tests are contracts.** The env map each provider produces is pinned in
  `test/golden.test.ts`. Changing one is allowed; changing one *without* updating
  the golden map is not. The diff is the point — it forces a human to look.
- **Test what the code actually tolerates.** Fixtures are deliberately
  incomplete, because `resolveProfile` really does open with `state?.profiles ?? {}`
  and the tests exercise that tolerance on purpose.
- **A bug fix ships with the test that fails without it.**

## 10. Naming

| Kind | Convention | Example |
|---|---|---|
| Port type | `*Port` | `ConfigStorePort`, `AgentCliPort` |
| Adapter factory | `create*` | `createFsConfigStore`, `createNodeProcess` |
| Pure builder | `make*` / `build*` | `makeEnvWriter`, `buildIntent`, `buildEnvPlan` |
| Predicate | `is*` / `has*` | `isInsecureRemoteBaseUrl`, `isTier` |
| Resolver | `resolve*` | `resolveProfile`, `resolveCredential` |
| Constant | `SCREAMING_SNAKE`, frozen | `TIERS`, `CC_FLAGS`, `REJECTED_PROVIDERS` |
| File | `kebab-case.ts`; `PascalCase.tsx` for components | `env-plan.ts`, `ModelPicker.tsx` |

Names say what a thing *is* in the domain, not what shape it has. `borrowedFrom`,
`consumedPositional`, `skipOverride` and `needsSetup` all read as sentences at
the call site, which is the test.

## 11. Formatting

There is no formatter or linter configured. That is a deliberate consequence of
the dependency budget, and it means the conventions are held by hand and by
review — match the file you are editing. The house style, as it actually exists:

- **No semicolons.** Single quotes. Trailing commas in multi-line literals.
- **2-space indent.** Lines wrap around 100 columns; comment prose wraps around 80.
- **`const` by default**, `let` only where genuinely reassigned (and never at
  module top level in `core/`).
- **Named exports only.** No default exports anywhere in `src/`.
- **Arrow functions for callbacks and one-liners; `function` declarations for
  module-level definitions.**
- **Explicit return types on exported functions.** Inference is fine internally.
- **`import type` for every type-only import** — `verbatimModuleSyntax` requires
  it, and it is what keeps a type-only reference from becoming a runtime edge.
- **Relative imports name the file on disk: `'./format.ts'`, not `'./format.js'`.**
  Node's type stripper does not remap `.js` → `.ts`, so the usual TypeScript-ESM
  convention would make the sources unrunnable;
  `rewriteRelativeImportExtensions` rewrites the specifier on the way to `dist/`.
- **Banned by `erasableSyntaxOnly`:** enums, namespaces, parameter properties,
  `declare` fields. Use unions and plain objects.
- **Comment style:** `//` for prose and file headers, `/** */` for a type or
  function whose contract needs stating. File headers are common and start by
  saying what the file *is*, then what constrains it.

If a formatter is ever added, it goes in as its own PR that touches nothing else.

## 12. Commits and pull requests

Subject lines are imperative and specific, with a lowercase area prefix where one
helps (`docs:`, `CI:`). The body explains **why**, in the same spirit as the
comments — recent history reads `Make the agent CLI a port: Claude Code as one
adapter, add Kilo & OpenCode`, not `update files`.

One concern per PR. A refactor and a behaviour change in the same diff makes the
behaviour change invisible, and the behaviour change is the one that can cost
someone money.

Sign off your commits: `git commit -s`. See
[CONTRIBUTING.md](CONTRIBUTING.md#developer-certificate-of-origin).

---

## The short version

If you remember five things:

1. Ask what the change does **wrong and silently**, not whether it works.
2. Push every constraint as far left as it goes — compile error beats test beats
   comment.
3. Comments record decisions and rejected alternatives. Delete stale ones.
4. Never guess when the correct answer is unavailable. Refuse, and name the fix.
5. A credential never reaches a host it was not entered for.
