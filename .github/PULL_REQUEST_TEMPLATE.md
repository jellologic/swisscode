<!--
Thanks for contributing. This template is a prompt, not a form to survive —
delete anything that does not apply. A one-line typo fix does not need a
threat model.

Agent-written PRs are welcome and expected here. See CONTRIBUTING.md.
-->

## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!--
The failure this prevents, or the thing it makes possible. If it fixes an
issue, link it: "Fixes #123".

This project's comments and commits record decisions, not restatements of the
diff. Reviewers will ask "why" if you skip it, so it is faster to answer here.
-->

## Alternatives considered

<!--
Optional, but the highest-signal section in most PRs here. If you rejected an
approach, say which and why — that is exactly the reasoning STYLE.md asks to
be preserved in a comment when it constrains future edits.
-->

---

## Checklist

- [ ] `npm test` passes locally (typecheck + build + the full suite)
- [ ] New behaviour has a test; a bug fix has a test that fails without the fix
- [ ] Commits are signed off (`git commit -s`) — see [CONTRIBUTING.md](../docs/CONTRIBUTING.md#developer-certificate-of-origin)

If your change touches any of these, tick the matching line:

- [ ] **New/changed provider** — added or updated its entry in `GOLDEN` (`test/golden.test.ts`)
- [ ] **New/changed agent adapter** — implements `AgentCliPort`, registered, capability gaps warn rather than drop silently
- [ ] **New port member** — bound in `test/ports.conformance.ts`
- [ ] **Launch path** — no new runtime dependency, no network, no React/Ink; `test/architecture.test.ts` still green
- [ ] **Credentials or the environment** — no credential can reach a host it was not entered for; nothing prints a key
- [ ] **User-facing behaviour** — `README.md` updated
- [ ] **An invariant or convention** — the relevant doc under `docs/` updated

## Anything reviewers should look at hardest

<!--
Optional. Point at the part you are least sure about. It is a shortcut to a
useful review, not an admission of anything.
-->
