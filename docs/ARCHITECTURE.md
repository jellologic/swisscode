# Architecture

A map of the codebase for people (and agents) about to change it. It names
modules rather than linking to lines, so it does not go stale every time a file
moves — use symbol search to find anything named here.

If you read one section, read [Invariants](#invariants). They are the part that
is enforced by tests and the part a reviewer will push back on.

## Bird's eye view

swisscode is a **launcher**. It answers one question — *what environment and
argv should the real coding CLI be started with?* — and then stops existing:

```
argv ─┬─> parse ──> select profile ──> apply overrides ──> build neutral intent
      │                  ▲                                          │
      │            config.json                                      ▼
      │         (profiles, bindings)                     agent adapter lowers it
      │                                                             │
      └─────────────────────────────────────────────> execve(binary, argv, env)
                                                          (process replaced)
```

There is no proxy, no daemon, no background process, and after `execve` no
swisscode. That single fact drives most of the design: anything that would make
the launch slower, heavier or less auditable is pushed off the launch path or
out of the project.

The tool's job is small; its **failure modes are expensive**. Sending a z.ai
token to OpenRouter, silently billing an Anthropic account because a stale
`ANTHROPIC_API_KEY` was inherited, or running three model tiers at a 1M window
and the fourth at 200K without a word — those are the bugs this codebase is
shaped to make structurally hard.

## Layers

Hexagonal (ports and adapters), with the dependency rule pointing inward.

| Directory | What lives there | May import |
|---|---|---|
| `src/core/**` | Pure domain logic: arg parsing, profile selection, binding resolution, override merging, intent building, migration, URL safety. No I/O, no clock, no state. | `core/`, `node:` builtins, and `ports/` **type-only** |
| `src/ports/**` | Interfaces. Every file erases to `export {}` — there is no runtime code here at all. | other `ports/` (type-only) |
| `src/adapters/**` | The implementations: provider descriptors, agent CLIs, model catalogs, filesystem stores, the process adapter, the network probe, the Ink UI. | `core/`, `ports/`, siblings, npm packages |
| `src/composition/**` | The four composition roots that wire adapters into ports and own the top-level flow. | anything |

`src/cli.ts` is the entry point; `bin/swisscode.js` is a deliberately trivial
shim over the compiled `dist/cli.js`, kept as plain JS because it runs before
anything is known about the environment.

### Why ports are type-only

In a language without interfaces, "ports and adapters" usually degrades into a
naming convention: a port describes a contract in a comment and nothing checks
that an adapter meets it. Here the check is real in three places:

1. Adapters state their port **at the definition site** — `satisfies
   ProviderRegistryPort`, or an explicit return type. Drift is a compile error
   in the adapter's own file.
2. `test/ports.conformance.ts` binds the whole adapter surface against the whole
   port surface in one file. A port that grows a member no adapter implements
   fails here even when every adapter compiles on its own. It has no runtime
   assertions and is deliberately not named `*.test.ts` — `tsc` is what runs it.
3. `test/architecture.test.ts` asserts the layering itself, post-type-erasure.

## Codemap

### `core/` — the pure middle

- **`args`** — argument routing. Deliberately tiny: everything outside the
  reserved namespace belongs to the agent verbatim. Also the single source of
  truth for what *is* reserved.
- **`profile`** — which profile this launch uses, and why (`source` is one of
  default / positional / flag / binding), including the ambiguity and conflict
  errors.
- **`binding`** — per-directory bindings. Nearest ancestor wins; the walk is
  string arithmetic over a map already in memory, so resolution costs no
  syscalls.
- **`overrides`** — merging `--cc-*` into a profile, and `retargetProvider`,
  which holds the rule that a credential never crosses to a host it was not
  entered for.
- **`intent`** — builds the neutral `LaunchIntent`. This is the core's whole
  contribution to a launch.
- **`env-plan`** — the neutral env-writing mechanics (`makeEnvWriter`,
  `materializeEnv`, `resolveCredential`). *How* an env mutation accumulates;
  never *which* variables.
- **`migrate`** — v1 → v2 config migration, plus the profile-name grammar and
  the reserved/soft-reserved word lists.
- **`tiers`**, **`format`**, **`catalog`**, **`url-safety`** — small helpers.
  The last three are UI-facing and excluded from the `tsc` emit (see
  [Build](#build)).

### `adapters/` — the edges

- **`providers/*`** — one descriptor per model backend, plus `registry` and
  `REJECTED_PROVIDERS`: providers investigated and deliberately not shipped,
  each with the specific finding that disqualified it, so nobody re-adds one
  from a blog post.
- **`agents/*`** — one `AgentCliPort` per coding CLI. `claude-code/` is the
  reference adapter and the only place `ANTHROPIC_*` / `CLAUDE_CODE_*` variables
  are named; `kilo/` and `opencode/` are peers sharing `agents/shared.ts`.
- **`process/node-process`** — binary resolution (PATH first, then the usual
  install locations, skipping ourselves), `execve`, and the spawn fallback.
- **`store/fs-config-store`** — `config.json`: atomic write, `0600` in a `0700`
  directory, migration on read, backup of the original.
- **`catalog/*`**, **`net/*`**, **`clock/*`**, **`store/fs-cache-store`** — the
  model-picker cluster. Reached **only** by the UI.
- **`doctor/probe`** — the one place a real inference request is made.
  **`doctor/ollama`** sits beside it and is the opposite kind of call: a
  provider's own native API, costing nothing, so it may be asked freely. It
  exists because a local Ollama's effective context window is set by *how the
  server was started* rather than by the model id, making it unguessable at
  launch and invisible at runtime — the doctor is the only place it can be
  caught. Gated on the provider id rather than generalised into an "introspect a
  provider" port method: one example is not enough to know that abstraction's
  shape, and the second caller is what should define it.
- **`ui/*`** — the Ink wizard. The only `.tsx` in the project and the only code
  that imports React.

### `composition/` — the four roots

| Root | Reached by | Notes |
|---|---|---|
| `launch-root` | statically, always | The hot path. `planLaunch` resolves everything without launching; `main` reports and then replaces the process. |
| `config-root` | dynamic import | Every `swisscode config <sub>` subcommand. |
| `doctor-root` | dynamic import | `config doctor`. Never runs automatically — the probes are real, billable inference requests. |
| `ui-root` | dynamic import of `dist/ui.js` | The Ink wizard, bundled separately. |

Each takes the same `LaunchDeps` bag (`store`, `registry`, `agents`, `proc`),
declared once in `launch-root` and imported by the others with `import type`, so
the roots cannot drift on what they expect. Every field is a **port** type, never
an adapter type — that is what makes a mis-wire a compile error rather than a
runtime `undefined is not a function`.

## The agent seam

The single most important abstraction, and the newest. It exists because
"launch Claude Code" and "launch a coding CLI" turned out to be different jobs.

The core builds a **neutral** `LaunchIntent`:

```
baseUrl · credential · bare per-tier model ids · skipPermissions
        · extendedContext (a fact about the model) · contextWindows
```

Nothing in that shape is Claude-Code-flavoured — no `[1m]` suffix, no variable
names. Each `AgentCliPort` adapter then **lowers** the intent into its own CLI's
dialect:

- **Claude Code** writes `ANTHROPIC_*` / `CLAUDE_CODE_*` variables, re-derives
  the `[1m]` extended-context suffix from the provider's declared model list,
  sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` when a real measured window is known,
  and maps `compat` flags to their variables.
- **Kilo / OpenCode** generate a whole CLI config inline
  (`KILO_CONFIG_CONTENT` / `OPENCODE_CONFIG_CONTENT`) describing an
  `@ai-sdk/anthropic` provider pointed at the endpoint. No file is written to
  the user's disk.

Where an agent cannot express what a profile asked for — Claude Code has four
model tiers, OpenCode has two slots, Kilo has one — the adapter emits an
`EnvWarning`. **Capability gaps are surfaced, never silently dropped.** That is
the rule the seam exists to enforce.

### Compat flags carry their cost

Each provider disagrees with Claude Code in its own way, so a descriptor sets
named booleans (`compat`) and the adapter's `COMPAT_ENV` table decides which
variable each one means. A descriptor never spells a variable name, which is what
makes a misspelled flag a compile error instead of a silent no-op.

Some switches **trade something away**. `disableNonessentialTraffic` stops the
background requests that can wedge a local Ollama, and also disables gateway
model discovery. A `COMPAT_ENV` entry may therefore declare a `consequence`, and
when one is set the adapter emits a `compat-consequence` warning naming exactly
what was given up — `medium` (stderr, every launch) when a provider imposes it,
`info` (doctor-only) when the profile asked for it. Severity encodes *who chose*.

This replaced a deny-list that banned one variable by name, in the compat table
and in descriptor `env` blocks alike. The recorded objection was that the switch
"must not hide behind a boolean that reads like a harmless compatibility
switch" — a statement about **silence**, not about the variable. A list also does
not generalise: the next provider brings its own rules and earns another entry
rather than a mechanism. The `env`-block ban survives, now for a reason that
does generalise: `env` writes straight to the environment and would skip the
warning.

Adding an agent should not require touching `core/` at all. If it does, the
intent is missing something neutral, and *that* is the change to propose.

## Invariants

Stated as absences, which is how they are checked. Almost all of these live in
`test/architecture.test.ts`, which walks the **source** import graph rather than
measuring anything at runtime, so it cannot flake.

**The launch path** — the static import closure rooted at `src/cli.ts`:

- never reaches React, Ink, or any `.tsx` file
- never reaches `node_modules` — it resolves only inside `src/` and `node:`
  builtins
- never reaches `adapters/ui`, `adapters/catalog`, `config-root`, or the doctor
- never calls `fetch`, and never imports `node:http`/`https`/`net`/`tls`/`dgram`.
  A launcher must not make network calls. The `execve`/`spawn` in the process
  adapter is the one deliberate subprocess exception
- stays under 40 modules, so it remains auditable in one sitting

The **only** sanctioned escape hatch is a dynamic `import()` from `src/cli.ts`.
That is not a lint rule to be worked around — it is the property the project
sells, and it is why launching stays instant.

**`core/`**

- holds no top-level `let` or `var`. `dist/ui.js` inlines its own copy of
  `core/`, and two copies in one process are harmless only while the core has no
  mutable module state
- imports nothing outside `core/` and `node:` builtins **at runtime**. Type-only
  imports of `ports/` are fine because they provably emit nothing; the check
  erases types first, so a mixed `import {type A, b}` — which keeps a live
  binding — still fails

**`core/` and `ports/`**

- name no `ANTHROPIC_*` or `CLAUDE_CODE_*` variable in emitted code. The sole
  exception is `ports/claude-code.ts`, the designated home for that dialect.
  Comments may mention anything; the scan runs post-erasure

**`ports/`**

- carry no runtime behaviour: every file must erase to exactly `export {}`

**Packaging**

- `bin/swisscode.js` imports exactly `../dist/cli.js` and nothing else
- nothing under `src/` names the UI module, even in type space — see
  [Build](#build)

## Build

Two stages, neither optional (`build.js`):

1. `tsc -p tsconfig.build.json` → `dist/**`. The launch path, emitted as plain,
   readable, individually-inspectable JS with no bundler in the way.
2. `esbuild src/composition/ui-root.ts` → `dist/ui.js`. The Ink UI as one
   lazily-imported bundle, with `ink`/`react` left external so nothing has to
   bundle Yoga's wasm.

They ship different things on purpose. `tsconfig.build.json` therefore
**excludes** the UI and the UI-only leaf cluster (`core/catalog`, `core/format`,
`adapters/net`, `adapters/clock`, `adapters/catalog`, `fs-cache-store`) — esbuild
already inlines those, and emitting them twice would put React-importing modules
inside a package whose entire selling point is that the launch path never touches
them. `dist/ports/` is deleted after emit, since the ports are inert.

The trap this creates, and the reason `src/cli.ts` carries a long comment about
it: `exclude` only filters the `include` globs. A module reached through an
**import** — even a type-only query like `typeof import('./composition/ui-root.ts')` —
rejoins the program and gets emitted anyway. So the exclusion silently stops
applying the moment anything under `src/` names the UI in any way. `src/cli.ts`
declares the bundle's shape structurally instead, and `test/ports.conformance.ts`
(never emitted) checks that declaration against the real module.

Two tsconfigs, because they do different jobs: `tsconfig.json` typechecks
`src` + `test` and emits nothing — it is what the editor loads and what
`npm run typecheck` runs. `tsconfig.build.json` emits.

## Cross-cutting concerns

**Output streams.** stdout belongs to the launched agent and may be piped into
something that parses it. Everything swisscode says on the launch path —
warnings, the profile banner, errors — goes to **stderr**. The `config`
subcommands and the doctor print to stdout, because nothing is being launched and
`config doctor --json | jq` has to work.

**Silence is a feature.** A clean environment produces no output, and an ordinary
default-profile launch prints nothing at all. That is what keeps the one line it
*does* print — when a binding or an override changed which profile you got —
worth reading.

**Warnings, not silent behaviour.** Every place where swisscode does something
the user did not literally ask for, it says so: a collapsed model tier, an
extended window that cannot be negotiated, an unknown agent falling back to the
default, a shell variable that conflicts with the profile.

**Refusing to guess.** When the data needed to be correct is absent, swisscode
does nothing rather than approximating. No measured context window means
`CLAUDE_CODE_AUTO_COMPACT_WINDOW` is not set at all, because a guessed window
that is too large means the conversation overflows instead of compacting. An
unknown provider with no `baseUrl` refuses to launch rather than defaulting to
Anthropic and billing the wrong account.

**Errors name the fix.** `LaunchError` messages say what to run next — the
several-profiles-no-default error names `swisscode config default <name>`.

**Credentials.** See [SECURITY.md](SECURITY.md); the short version is that a
credential never reaches a host it was not entered for, and nothing ever prints
a key.

## Where to make common changes

| Change | Touch | Test that will fail if you forget |
|---|---|---|
| New provider | `adapters/providers/<id>.ts` + `providers/registry.ts` | `test/golden.test.ts` (missing `GOLDEN` entry), `test/registry.test.ts` |
| New agent CLI | `adapters/agents/<id>/index.ts` + `agents/registry.ts` | `test/adapters/agents/registry.test.ts`, `ports.conformance` |
| New `config` subcommand | `composition/config-root.ts` | `test/config-commands.test.ts` |
| New compat flag | `ports/claude-code.ts` union + `agents/claude-code/env.ts` map | `test/registry.test.ts` |
| New port member | the port + every adapter | `test/ports.conformance.ts` (via `npm run typecheck`) |
| Anything on the launch path | — | `test/architecture.test.ts` |

## Further reading

- [STYLE.md](STYLE.md) — how code is written here, and why the comments look like that
- [TESTING.md](TESTING.md) — the test suite's own architecture
- [SECURITY.md](SECURITY.md) — threat model and the properties the code asserts
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow, review, sign-off
