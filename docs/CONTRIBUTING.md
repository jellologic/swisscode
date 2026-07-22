# Contributing to swisscode

Thanks for being here. This project is small, sharply scoped and heavily
invariant-driven, which is good news for a contributor: almost everything you
need to know is either enforced by a test or written down, and the parts that are
neither are listed below.

**The short version.** Fork, branch, `npm test`, `git commit -s`, open a PR. If
it is green and it does not break an invariant, it will get a real review.

## Coding agents are first-class here

A lot of projects are working out how to say "no" to AI-written contributions.
This one says **yes**, and is built to make agent contributions good rather than
merely tolerated:

- **[AGENTS.md](../AGENTS.md)** at the repo root is a machine-readable brief:
  commands, invariants, task recipes, and the pre-PR checklist. Point your agent
  at it and most of this page becomes unnecessary.
- **The invariants are mechanical.** "Do not put React on the launch path" is not
  a norm an agent has to infer from vibes; it is `test/architecture.test.ts`, and
  it fails loudly.
- **The comments carry the reasoning.** Most files open by saying what constrains
  them and which alternatives were rejected. That is the context an agent needs
  and usually cannot reconstruct.
- **The inner loop is 0.3 seconds.** `node --test "test/core/**/*.test.ts"` needs
  no build, which makes an iterate-until-green loop cheap.

You do not have to disclose that an agent wrote your patch, and there is no
checkbox asking. **Human-written PRs are welcome on exactly the same terms.** The
only thing that is actually required, of anyone: *understand the change you are
proposing well enough to answer questions about it.* A PR whose author cannot
explain why it works is not reviewable, and that is true whoever — or whatever —
typed it.

If your agent produced something you have not read, read it before opening the
PR. That is the whole standard.

## Ground rules

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). It is
the Contributor Covenant 2.1, and it is enforced.

## Getting set up

Node **>= 22** (the `engines` floor) and npm. Nothing else.

```sh
git clone https://github.com/jellologic/swisscode.git
cd swisscode
npm install
npm test          # typecheck + build + the full suite (~540 tests, ~5s)
```

To exercise your working copy (after `npm run build`), point it at a throwaway
config so you never touch your real one:

```sh
export XDG_CONFIG_HOME=$(mktemp -d)

node bin/swisscode.js config help
node bin/swisscode.js config list
node bin/swisscode.js config use --show
node bin/swisscode.js config doctor --offline
node bin/swisscode.js config doctor --offline --json | jq .
```

**A bare `node bin/swisscode.js` is not a dry run.** With no subcommand it
resolves the real `claude` binary and calls `process.execve`, replacing the
process — and `--help` is not reserved, so it is forwarded to the agent rather
than printing anything of ours. Use `config help`.

To assert on launch behaviour without launching, use `planLaunch` from
`composition/launch-root.ts`, which resolves everything a launch needs and
returns it. That separation from `main` exists precisely so it can be tested.

### The inner loop

```sh
node --test "test/core/**/*.test.ts"    # ~0.3s, no build step
node --test test/architecture.test.ts   # the invariants
npm run typecheck                       # also runs test/ports.conformance.ts
npm test                                # the full gate, before you push
```

Node executes `.ts` directly, so most of the suite needs no build. The three UI
suites (`ui`, `picker`, `profiles-ui`) drive the built `dist/ui.js` and need
`npm run build` first. See [TESTING.md](TESTING.md).

## Before you write code

Three things send PRs back more often than anything else. All three are cheap to
avoid and expensive to discover in review.

**1. The launch path is closed.** The static import closure from `src/cli.ts`
must not reach React, Ink, `node_modules`, the network, the doctor, or the
`config` subcommands. If your feature needs any of those, it goes behind a
**dynamic import** from `src/cli.ts`, exactly as the wizard, the subcommands and
the doctor already do. `test/architecture.test.ts` will tell you.

**2. The reserved namespace does not grow.** `config`, `setup`, `--safe`,
`--yolo`, `--` and the `--cc-` prefix are the entire list. Everything else is
forwarded to the agent verbatim — that is what makes swisscode a drop-in, and it
is why `swisscode fix the login bug` works. New user-facing commands go under
`swisscode config <thing>`.

**3. Never silently, never guess.** If the change makes swisscode do something
the user did not ask for, it must warn. If the data needed to be correct is
missing, it must refuse rather than approximate. [STYLE.md](STYLE.md) §3 has the
reasoning.

Then skim [ARCHITECTURE.md](ARCHITECTURE.md) for the map, and
[STYLE.md](STYLE.md) for how code is written here — particularly the comment
doctrine, which is the most distinctive thing about the codebase.

## Recipes

### Add a provider

1. `src/adapters/providers/<id>.ts` — a `ProviderDescriptor`. Base URL must be
   the **Anthropic-compatible** route; do not include the OpenAI-style `/v1`, or
   you get `/v1/v1/messages` and a 404.
2. Register it in `src/adapters/providers/registry.ts`. Order is the order the
   wizard offers.
3. Add its expected environment to `GOLDEN` in `test/golden.test.ts`. A missing
   entry fails on a dedicated test.
4. `node --test test/registry.test.ts test/golden.test.ts`.

`test/registry.test.ts` generates the descriptor invariants for you: no
hand-typed `[1m]`, third-party endpoints clear `ANTHROPIC_API_KEY`,
`extendedContext` agrees with `defaultModels`, compat flags are real.

**Only claim extended context for models you have verified.** Declaring `[1m]`
support that a provider does not have sends an id the endpoint rejects — a hard
failure, where the honest alternative merely runs at a narrower window.

### Add an agent CLI

1. `src/adapters/agents/<id>/index.ts` implementing `AgentCliPort`: `id`, `label`,
   `capabilities`, a declarative `binary` spec, and `translate`.
2. Register it in `src/adapters/agents/registry.ts`.
3. Reuse `agents/shared.ts` if the CLI is configured by an inline AI-SDK config,
   like Kilo and OpenCode.
4. Every string the CLI's config schema pins goes in a **named constant**, so a
   schema change upstream is a one-line fix with a test to catch it.
5. Where the CLI cannot express what a profile asked for, emit an `EnvWarning`.
   Silently dropping a pinned tier is the bug the seam exists to prevent.

If adding an agent requires changing `src/core/`, stop: the neutral
`LaunchIntent` is probably missing something, and *that* is the change to
propose.

### Add a gateway compat flag

Add the key to the `ClaudeCodeCompatFlag` union in `src/ports/claude-code.ts` and
the variable mapping in `src/adapters/agents/claude-code/env.ts`. Document the
**symptom it clears**, not the variable it sets — that is the only thing that
lets someone decide whether they need it.

### Fix a bug

Write the failing test first, in the layer that owns the behaviour. If it is a
launch-behaviour bug, there is a good chance the right test is a new golden
expectation.

## Tests

Every behavioural change needs a test; every bug fix needs one that fails without
the fix. [TESTING.md](TESTING.md) covers the suite's structure, the fixture rules
(`makeProfile`/`makeState`/`makeDescriptor`, never `as unknown as`), and how to
test each layer.

If you genuinely cannot test something, say so in the PR and explain why. That is
occasionally a legitimate answer and it is useful for a reviewer to know.

## Commits and pull requests

**Commit messages.** Imperative subject, lowercase area prefix where it helps
(`docs:`, `CI:`). The body explains *why* — the failure prevented, the
alternative rejected. Match the existing history.

**One concern per PR.** A refactor and a behaviour change in one diff makes the
behaviour change invisible, and the behaviour change is the one that can cost
someone money.

**Draft PRs are welcome** for anything you want early feedback on.

### Developer Certificate of Origin

All commits must be signed off. This project uses the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) rather
than a CLA — no forms, no external service, no account.

```sh
git commit -s -m "your message"      # appends the Signed-off-by line
git commit -s --amend                # fix a commit you already made
```

That adds:

```
Signed-off-by: Your Name <your.email@example.com>
```

By signing off you certify the DCO: that you wrote the contribution or otherwise
have the right to submit it under this project's MIT licence, and that you
understand the contribution and your sign-off are public and kept indefinitely.

**If an agent wrote the code, you still sign off.** The DCO certifies the right to
submit, not the identity of the typist — you ran the agent, you reviewed the
output, you are vouching for it. That is the accountability story, and it is
exactly why this project uses the DCO rather than nothing at all.

Contributions are licensed under the [MIT licence](../LICENSE), the same as the
project.

## What happens to your PR

1. **CI runs** — `npm test` on Node 22 and 24, ubuntu and macOS. Green is the
   entry price, not the finish line.
2. **Review.** Expect questions about *why*, about the silent-failure mode, and
   about whether an invariant should have been tightened. That is the culture of
   the codebase, not scepticism about you.
3. **Merge.** Squash, with the PR body preserved as the commit body when it is
   worth keeping.

Reviews are usually within a week. This is a one-maintainer project; a ping on a
stalled PR is welcome and not rude.

## What is likely to be declined

Said plainly, so nobody wastes an afternoon:

- **A new top-level command word.** It permanently takes an English word away
  from the agent's prompt space. Goes under `config`.
- **A new runtime dependency on the launch path.** Non-negotiable; it is the
  property the project sells.
- **A provider added from a blog post.** Presets are load-bearing — a wrong base
  URL or a speculative `[1m]` claim produces confident, wrong behaviour. See
  `REJECTED_PROVIDERS` for three that were investigated and deliberately not
  shipped, each with the specific finding.
- **A "helpful" default that can be wrong invisibly.** Guessing a context window,
  reusing a credential across hosts, inferring a model id.
- **A repo-wide reformat**, unless it is its own PR that touches nothing else.

None of these are "no forever" — they are the design pressure. An issue arguing
that one of them should change is a perfectly good contribution.

## Good places to start

- Issues labelled **`good first issue`** and **`help wanted`**.
- **Windows support in the test matrix.** CI runs ubuntu + macOS; `execve` does
  not exist on Windows, so the spawn fallback is the whole story there and nobody
  has verified the suite on it.
- **A provider you actually use.** The recipe above is short and the tests carry
  most of the weight.
- **Docs.** If something in this directory was wrong or missing when you needed
  it, that is the highest-value patch you can send.

## Questions

Open an issue — questions are fine as issues. For anything security-related, do
not open a public issue; see [SECURITY.md](SECURITY.md).
