# swisscode docs

Contributor documentation. User-facing documentation — installation, flags,
profiles, providers, the model picker, config format — lives in the
[README](../README.md), which is the product spec and is kept current.

## The documents

| Doc | What it answers |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | How do I set up, what will get my PR sent back, how do I sign off, what happens next? |
| [ARCHITECTURE.md](ARCHITECTURE.md) | What is this system, where does the thing that does X live, and what must never be true? |
| [STYLE.md](STYLE.md) | How is code written here, and why do the comments look like that? |
| [TESTING.md](TESTING.md) | How is the suite structured, how do I test each layer, what is the fast inner loop? |
| [SECURITY.md](SECURITY.md) | How do I report a vulnerability, what is in scope, what does the code guarantee? |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Contributor Covenant 2.1. |
| [RELEASING.md](RELEASING.md) | How a release is cut and why there is no stored npm token. |
| [../AGENTS.md](../AGENTS.md) | The machine-readable brief for coding agents. |
| [../CLAUDE.md](../CLAUDE.md) | A pointer to AGENTS.md plus Claude-Code-specific hazards. |

## Reading order

**Fixing a bug:** [CONTRIBUTING](CONTRIBUTING.md) → the invariants in
[ARCHITECTURE](ARCHITECTURE.md#invariants) → [TESTING](TESTING.md).

**Adding a provider or an agent:** the recipe in
[CONTRIBUTING](CONTRIBUTING.md#recipes) → the agent seam in
[ARCHITECTURE](ARCHITECTURE.md#the-agent-seam).

**Changing anything about credentials or the environment:**
[SECURITY](SECURITY.md#the-properties-the-code-asserts) first, then
[STYLE](STYLE.md).

**Just want to understand the codebase:** [ARCHITECTURE](ARCHITECTURE.md), then
skim the file headers in `src/` — they carry most of the reasoning.

**Using a coding agent:** point it at [../AGENTS.md](../AGENTS.md). That is what
it is for, and agent-written PRs are welcome here.

## How these stay true

Each document owns one subject, and they cross-link rather than repeat:
ARCHITECTURE owns the map and the invariants, STYLE owns how code is written,
TESTING owns the suite, SECURITY owns the threat model, CONTRIBUTING owns
process. AGENTS.md is the one deliberate overlap — a dense checklist form of the
rules, for a reader that benefits from having them in one place.

Most of what these describe is enforced by `test/architecture.test.ts`,
`test/golden.test.ts` and `test/ports.conformance.ts`. Where a doc states a rule
that no test enforces, that is a gap worth a PR — a rule nothing checks will be
broken within two releases.
