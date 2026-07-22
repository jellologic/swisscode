# Security Policy

swisscode holds API keys and constructs the environment another program runs in.
That makes a narrow class of bugs unusually expensive, and the project is shaped
around preventing them. This page is both the reporting process and the threat
model, because a reporter needs the second to judge the first.

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/jellologic/swisscode/security/advisories/new)**

If that is unavailable to you, email **orepsdev@gmail.com** with `swisscode
security` in the subject.

Useful things to include: what an attacker can do, the smallest reproduction you
have, the swisscode version, and the platform. **Never include a real API key** —
a synthetic one demonstrates the same thing. If a key has already been exposed
anywhere, revoke it first; editing a GitHub comment does not remove it from the
edit history.

What to expect:

| | |
|---|---|
| Acknowledgement | within 72 hours |
| Initial assessment | within 7 days |
| Fix or a plan with a date | within 30 days for confirmed issues |
| Credit | in the advisory and the release notes, unless you prefer otherwise |

This is a small project maintained by one person. Those are honest targets, not
an SLA — if you have not heard back, a nudge is welcome and not rude.

## Supported versions

The latest published minor gets fixes. Older lines do not receive backports;
upgrading is `npm i -g swisscode@latest` and there is no migration cost, since
config is migrated forward automatically.

## Threat model

**What swisscode is trusted with:** one or more third-party API keys at rest, the
resolution of which key goes to which endpoint, and the environment handed to a
child process that will then execute code on the user's machine.

**Assumed trusted:** the user's own machine and shell, `~/.config/swisscode`, and
the coding CLI being launched. swisscode is not a sandbox and does not attempt to
constrain the agent it launches — `--yolo` exists and does exactly what it says.

**In scope for a report**

- A credential reaching a host it was not entered for.
- A credential appearing in output, logs, an error message, or the doctor report.
- Secrets written with permissions wider than `0600`, or a directory wider than
  `0700`, or a write that leaves a readable temp file behind.
- swisscode launching a binary other than the one it resolved, or being made to
  launch an attacker-controlled binary.
- A crafted `config.json`, profile name, model id, base URL, or `--cc-*` argument
  that causes command injection, argument injection into the child, path
  traversal, or arbitrary file write.
- Anything that defeats the recursion guard, the billing guard
  (`ANTHROPIC_API_KEY` stripping), or the cleartext-endpoint warning.
- Supply-chain issues in what is published: the tarball contents, the release
  workflow, provenance.

**Not vulnerabilities** (all documented behaviour):

- **`config.json` stores the API key in plaintext.** It is `0600` inside a `0700`
  directory, which is the same posture as `~/.aws/credentials`, `~/.npmrc` and
  `~/.docker/config.json`. Use `"apiKeyFromEnv": "MY_TOKEN"` if you would rather
  the secret lived in your environment or a keychain-backed shell integration.
  An OS-keychain backend is a reasonable feature request, not a security report.
- **`config.json` records absolute binding paths**, which leak project and client
  names to anyone who can read the file — and `config doctor` prints them. Worth
  knowing before pasting a report publicly; not a vulnerability.
- **Anyone who can already run code as you can read your keys.** That is true of
  every credential file on the machine.
- **A provider gateway mishandling your key** once it has been correctly sent
  there. Report that to the gateway.
- **`--yolo` / `--dangerously-skip-permissions` letting the agent do damage.**
  That is the flag's purpose; the decision is the user's.

## The properties the code asserts

These are the invariants a change must not break. Most are enforced by a test,
and where they are, the test is named.

**A credential never reaches a host it was not entered for.** `--cc-provider`
resolves in a fixed order: keep the key if the provider is unchanged; else borrow
the key, endpoint **and models** together from another profile already using that
provider; else use one already in the environment; else exit 2. There is
deliberately no "just send the key we have" fallback. Models are dropped with the
key because a model id from the wrong provider is a 404 wearing the costume of a
working config. (`core/overrides.ts`, `test/core/overrides.test.ts`)

**The billing guard.** Any launch not going to first-party Anthropic strips
`ANTHROPIC_API_KEY` from the child environment. A stale key in the shell would
otherwise make the agent fall back to Anthropic and bill the wrong account. Both
agent families implement it — the Claude Code adapter directly, and
`agents/shared.ts` for Kilo/OpenCode, where `@ai-sdk/anthropic` would otherwise
pick the ambient key up. (`test/golden.test.ts`: *no launch inherits a stale
ANTHROPIC_API_KEY it did not ask for*)

**Nothing prints a key.** Not masked, not truncated, not length-hinted. The
doctor deep-redacts anything a gateway echoes back before rendering, so its
report is safe to paste into a bug thread. Any new output path inherits this.
(`redactDeep` in the Claude Code doctor)

**Cleartext transport is refused loudly.** A credential bound for an `http://`
non-loopback host produces a `high`-severity warning naming the endpoint.
Loopback is exempt, because a local model server is a legitimate setup.
(`core/url-safety.ts`)

**Config is written safely.** `0700` directory, `0600` file, written to a temp
file with mode `0600` and then moved into place, with the mode re-asserted by
`chmod` in case of a permissive umask. An unparseable `config.json` is moved
aside rather than overwritten, and a v1 file is backed up before migration.
(`adapters/store/fs-config-store.ts`)

**Exactly one module reads a credential swisscode did not write, and exactly one
writes one.** Session mode handles Claude subscription logins, which belong to
the agent rather than to us, so the surface is deliberately tiny:

- `adapters/claude-session/identity.ts` reads *who* an account is from
  `.claude.json`. No credential, no keychain, no prompt — which is why listing
  accounts is free.
- `adapters/claude-session/credentials.ts` reads the token, only so usage can be
  measured. It never refreshes: refreshing needs Anthropic's own OAuth client
  id, and impersonating their client is the line this design stays behind. An
  expired token is *reported*; the agent refreshes it itself on its next run.
- `adapters/claude-session/swap.ts` is the only writer. It is a separate module
  precisely so the read path's "never writes" promise holds by construction.

**A moved credential never touches argv, and never gets truncated.** `ps` shows
argv to every user on the machine, so a secret must not go there.
`/usr/bin/security add-generic-password` offers no safe alternative: `-w <value>`
is argv, and `-w` reading from stdin **silently truncates at 128 bytes** —
measured, 500 in and 128 stored with exit 0 and no warning, against a real
credential of ~3.9 kB. So the credential is written as a `0600` file in a `0700`
directory instead, and any competing keychain item for that directory is dropped
afterwards so exactly one stored credential remains. The blob is moved as opaque
bytes, never parsed into a shape that could be logged or narrowed — dropping
`refreshToken` would hand the target a login that dies at the next refresh.
(`test/adapters/claude-session-swap.test.ts`: *THE SECRET NEVER REACHES ARGV*,
*THE BLOB IS NEVER TRUNCATED*)

**Measuring usage is never automatic.** A keychain read can raise an unlock
dialog, so it happens only when asked: `config accounts usage`, `config doctor`,
or the button in the web UI. The web route is a `POST` for the same reason — a
`GET` is something a browser may prefetch, retry or replay on its own
initiative, and nothing that can pop a system dialog should be reachable that
way. The launch path never measures at all; it reads a cached snapshot.

**Binary resolution cannot be hijacked into a loop.** `SWISSCODE=1` is set in the
child; seeing it in the ambient environment means swisscode resolved to itself
via an alias or a shim, and the launch is refused rather than recursing into a
hang. Resolution skips ourselves so `alias claude=swisscode` is safe.
(`detectRecursion`, `adapters/process/node-process.ts`)

**No network on the launch path.** Enforced structurally: the static import
closure from `src/cli.ts` may not call `fetch` or import `node:http`/`https`/
`net`/`tls`/`dgram`. The only code that reaches the network is the model catalog
(UI-only) and the doctor probe, both behind lazy imports and both user-initiated.
(`test/architecture.test.ts`)

**The doctor never runs automatically.** Its probes are real, billable inference
requests. A launcher that quietly billed a token on every start would be a worse
bug than anything it detects.

**No arbitrary code on install.** There is no `postinstall`. `prepare` runs the
build, which npm executes only for local checkouts and git installs — never when
installing the published tarball. The tarball ships `bin/`, `dist/` and
`README.md` and nothing else.

## Supply chain

- **Four runtime dependencies** — `ink`, `ink-select-input`, `ink-text-input`,
  `react` — and every one is reachable only from the Ink wizard. The launch path
  imports nothing from `node_modules` at all, which is asserted rather than
  believed.
- **Releases use npm trusted publishing (OIDC).** No npm token exists in a shell,
  in repo secrets, or anywhere else. Every release carries a signed build
  provenance attestation. See [RELEASING.md](RELEASING.md).
- **GitHub Actions are SHA-pinned**, not tag-pinned, in both workflows. Dependabot
  proposes bumps as reviewable PRs.
- **`npm test` gates every publish**, on the tag, in CI.

Verify a release yourself:

```sh
npm view swisscode dist.integrity
npm audit signatures
```

## If you think a key of yours has leaked

1. Revoke it at the provider, now. Everything else can wait.
2. `swisscode config <profile>` to enter the replacement, or switch the profile to
   `"apiKeyFromEnv"`.
3. Check `~/.config/swisscode/config.json` and `config.v1.bak.json` — the
   migration backup can hold an old key — and check your shell history and
   rc files for an exported `ANTHROPIC_*` variable.
4. Then, if swisscode caused the exposure, report it as above.
