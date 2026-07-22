# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`swisscode` is a **launcher**, not a proxy or a daemon: it resolves a profile
(provider + credential + per-tier models + flags), builds a child environment,
and `execve`s the real coding CLI (`claude`, `kilo`, `opencode`), replacing its
own process image. Nothing runs alongside the agent. See `README.md` for the
user-facing feature set — it is the product spec and is kept current.

## Commands

```sh
npm run typecheck                     # tsc --noEmit over src/ + test/ (the LSP config)
npm run build                         # tsc src/ -> dist/  +  esbuild the Ink UI -> dist/ui.js
npm test                              # typecheck, build, then node --test "test/**/*.test.ts"
npm run dev                           # build once, then tsc --watch

node --test "test/core/**/*.test.ts"  # ~0.3s inner loop, NO build needed
node --test test/golden.test.ts       # one file
node --test --test-name-pattern "binding walk" "test/**/*.test.ts"   # one test
```

Node runs `.ts` sources directly, so most suites need no build. The exception is
the three UI suites (`test/ui.test.ts`, `test/picker.test.ts`,
`test/profiles-ui.test.ts`) — they import the built `dist/ui.js`, so run
`npm run build` first. `npm test` always builds.

`test/ports.conformance.ts` is deliberately **not** named `*.test.ts`: it has no
runtime assertions and is checked by `tsc` alone. `npm run typecheck` is what
runs it.

## Architecture

Hexagonal, with a dependency rule that is mechanically enforced by
`test/architecture.test.ts` rather than by convention:

| layer | rule |
|---|---|
| `src/core/**` | pure domain logic. No I/O, no top-level `let`/`var`, imports nothing outside `core/` and `node:` builtins (type-only imports of `ports/` are fine — they erase). |
| `src/ports/**` | interfaces only. Every file must erase to exactly `export {}`. |
| `src/adapters/**` | the implementations: providers, agent CLIs, catalogs, fs, process, net, clock, doctor probe, Ink UI. Each states its port at the definition site with `satisfies` or an explicit return type. |
| `src/composition/**` | the four composition roots that wire adapters into ports: `launch-root` (hot path), `config-root`, `doctor-root`, `ui-root`. |

Every root takes the same `LaunchDeps` bag (`store`, `registry`, `agents`,
`proc`), declared once in `launch-root.ts` and imported by the others with
`import type`, so the roots cannot drift.

### The launch path is the load-bearing invariant

`src/cli.ts` → `composition/launch-root.ts` is the *static* import closure that
runs on every launch. `test/architecture.test.ts` walks that closure from source
and fails if it ever reaches React/Ink, `node_modules`, a `.tsx` file,
`adapters/ui`, `adapters/catalog`, `config-root`, the doctor, `fetch`, or a
network `node:` module. It also caps the closure at 40 modules so it stays
hand-auditable.

Everything else is behind a **dynamic** import in `src/cli.ts` — that is the
only escape hatch the test recognises. If you add a feature to the launch path
that pulls in a new dependency, the fix is a dynamic import, not relaxing the
test.

### Two-stage build (`build.js`)

1. `tsc -p tsconfig.build.json` → `dist/**` — the launch path, plain readable JS.
2. `esbuild src/composition/ui-root.ts` → `dist/ui.js` — the Ink UI as one lazily
   imported bundle (ink/react stay `external`).

`tsconfig.build.json` **excludes** the UI and the UI-only leaf cluster
(`core/catalog`, `core/format`, `adapters/net`, `adapters/clock`,
`adapters/catalog`, `fs-cache-store`) because esbuild already inlines them.
`dist/ports/` is deleted after emit — the ports are inert.

Two tsconfigs on purpose: `tsconfig.json` typechecks `src` + `test` and emits
nothing; `tsconfig.build.json` emits.

### The agent seam

`core/intent.ts` builds a **neutral** `LaunchIntent` (baseUrl, credential, bare
per-tier model ids, skipPermissions, extendedContext) from
(profile, provider, ambient). Each `AgentCliPort` adapter then *lowers* it:

- `adapters/agents/claude-code/**` — the reference adapter; writes `ANTHROPIC_*`
  / `CLAUDE_CODE_*` vars, derives the `[1m]` extended-context suffix, sets
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, maps `compat` flags.
- `adapters/agents/{kilo,opencode}` — generate a full inline CLI config
  (`KILO_CONFIG_CONTENT` / `OPENCODE_CONFIG_CONTENT`) via `agents/shared.ts`.

**No `ANTHROPIC_*` or `CLAUDE_CODE_*` string may appear in emitted code under
`core/` or `ports/`.** The one exception is `ports/claude-code.ts`, which is the
designated (type-only) home for that dialect. The architecture test scans
post-type-erasure, so a comment mentioning a variable is fine; emitted code
naming one is not.

Capability mismatches (Kilo has one model slot, OpenCode has two, Claude Code
has four) are surfaced as `EnvWarning`s — **never silently dropped**.

## Rules that bite if you don't know them

- **Relative imports name the file on disk: write `'./format.ts'`, not
  `'./format.js'`.** Node's type stripper does not remap `.js` → `.ts`;
  `rewriteRelativeImportExtensions` rewrites the specifier on the way to `dist/`.
- **Nothing under `src/` may name the UI module, even in type space.** A bare
  `import type` re-adds it to the build program and ships a second, unbundled
  copy of the React tree. `src/cli.ts` therefore declares `UiModule`
  structurally, and `test/ports.conformance.ts` (never emitted) checks that
  declaration against the real `ui-root`. `config-root.ts` does the same with its
  `OpenUi` callback type.
- `dist/ui.js` and `dist/cli.js` are build output. `allowJs` is off so tsc cannot
  resolve them; imports of either carry a deliberate `@ts-expect-error`.
- `erasableSyntaxOnly` is on: no enums, namespaces, parameter properties, or
  `declare` fields. `verbatimModuleSyntax` is on: type-only imports need
  `import type`. `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are
  on, which is why optional fields are conditionally assigned rather than set to
  `undefined`.
- **stdout belongs to the agent.** Every warning, banner, and error on the launch
  path goes to stderr. `config`/`doctor` output goes to stdout because nothing is
  being launched (`config doctor --json | jq` must work).
- **The reserved namespace is closed**: `config | setup | --safe | --yolo | --`
  plus the `--cc-` prefix (`core/args.ts`). Everything else is forwarded to the
  agent verbatim. New user-facing commands go under `config <sub>`, never as a
  new top-level word. An unrecognised `--cc-*` is exit 2, never a passthrough.
- **Per-run overrides never persist.** Nothing on the launch path calls
  `store.save`; only the wizard and the `config *` subcommands write.
- **Never send a credential to a host it wasn't entered for.** `--cc-provider`
  keeps → borrows (key + endpoint + models together) → reads the environment →
  exits 2. There is no "just reuse the key we have" fallback.

## Common changes

- **New provider**: add `adapters/providers/<id>.ts`, register it in
  `adapters/providers/registry.ts`, and add its expected env map to `GOLDEN` in
  `test/golden.test.ts` (a missing entry fails). `test/registry.test.ts` then
  enforces the descriptor invariants (no hand-typed `[1m]`, no `/v1` suffix,
  clears `ANTHROPIC_API_KEY` for third-party endpoints, real compat flags…).
  Providers investigated and *rejected* are recorded in `REJECTED_PROVIDERS` with
  the reason so nobody re-adds one from a blog post.
- **New agent CLI**: add `adapters/agents/<id>/index.ts` implementing
  `AgentCliPort` and register it in `adapters/agents/registry.ts`. Reuse
  `agents/shared.ts` if it is AI-SDK-config-shaped. Anything a CLI's schema pins
  goes in a named constant so a schema change is a one-line fix.
- **New port member**: add the binding in `test/ports.conformance.ts` — it is the
  one place the whole adapter surface is asserted against the whole port surface.
- **Test fixtures**: use `makeProfile` / `makeState` / `makeDescriptor` from
  `test/support/fixtures.ts` for deliberately incomplete domain objects. They are
  identity functions that waive *only* missingness; `as unknown as T` is
  explicitly rejected.

## Config & release

Config lives at `~/.config/swisscode/config.json` (honours `XDG_CONFIG_HOME`),
written `0600` in a `0700` dir, atomically via a temp file. v1 configs are
migrated on read (`core/migrate.ts`), with the original kept as
`config.v1.bak.json`; a migration that cannot be written is used in memory rather
than blocking the launch.

Releases are automated: `npm version <patch|minor|major>` then
`git push --follow-tags`. The `v*` tag triggers `.github/workflows/publish.yml`,
which runs `npm test`, verifies the tag matches `package.json`, and publishes via
npm trusted publishing (OIDC — no stored token). See `docs/RELEASING.md`.
