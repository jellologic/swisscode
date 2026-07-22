# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read [AGENTS.md](AGENTS.md) first

It is the canonical brief for coding agents in this repo — commands, the hard
invariants, TypeScript conventions, the comment doctrine, task recipes and the
pre-PR checklist. Everything that used to live here moved there so there is one
copy to keep true, which is the same DRY rule the codebase applies to itself.

Deeper material lives in [`docs/`](docs/README.md): `ARCHITECTURE.md`,
`STYLE.md`, `TESTING.md`, `SECURITY.md`, `CONTRIBUTING.md`.

## Claude-Code-specific notes

**"Claude Code" is ambiguous in this repo — disambiguate before acting.** It is
both the tool you are running in *and* the product this project launches. When a
file, test or comment says `claude-code`, it almost always means the launch
target: the `AgentCliPort` adapter under `src/adapters/agents/claude-code/`, the
`ANTHROPIC_*` / `CLAUDE_CODE_*` environment dialect, and the `claude` binary
swisscode resolves and `execve`s. It is not talking about the session you are in.

**Do not run the launcher for real from a tool call.** `node bin/swisscode.js`
with no subcommand resolves the `claude` binary and calls `process.execve`,
replacing the process — from inside a Bash tool call that means a hung,
unkillable-looking command, and if it succeeds it starts a nested interactive
agent. Safe things to run instead:

```sh
node bin/swisscode.js config list
node bin/swisscode.js config doctor --offline
node bin/swisscode.js config use --show
npm test
```

Assert on launch behaviour through `planLaunch` and the golden tests, which
resolve everything a launch needs **without** launching. That is exactly why
`planLaunch` is separate from `main`.

**The doctor makes real, billable inference requests.** Never run
`swisscode config doctor` without `--offline` against the user's config unless
they asked for it.

**Never read or echo `~/.config/swisscode/config.json`.** It holds API keys in
plaintext by design. Use the temp-dir fixtures the tests use
(`XDG_CONFIG_HOME`), never the real file.
