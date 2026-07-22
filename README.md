<p align="center">
  <a href="https://www.npmjs.com/package/swisscode">
    <img src="https://raw.githubusercontent.com/jellologic/swisscode/main/assets/hero.png" width="850" alt="swisscode — a drop-in Claude Code launcher that runs Claude Code, Kilo or OpenCode against OpenRouter, z.ai/GLM, Kimi, DeepSeek, Qwen and more">
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/swisscode"><img src="https://img.shields.io/npm/v/swisscode?logo=npm&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/swisscode"><img src="https://img.shields.io/npm/dm/swisscode?color=cb3837" alt="npm downloads"></a>
  <a href="https://github.com/jellologic/swisscode/actions/workflows/ci.yml"><img src="https://github.com/jellologic/swisscode/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/node/v/swisscode?logo=node.js&logoColor=white&color=5fa04e" alt="node current">
  <img src="https://img.shields.io/npm/l/swisscode?color=3da639" alt="MIT license">
  <img src="https://img.shields.io/badge/no%20proxy-no%20daemon-8957e5" alt="no proxy, no daemon">
  <a href="AGENTS.md"><img src="https://img.shields.io/badge/agent--written%20PRs-welcome-2f81f7" alt="agent-written PRs welcome"></a>
</p>

# swisscode — drop-in launcher for Claude Code, Kilo &amp; OpenCode

**swisscode** is a drop-in launcher for [Claude Code](https://claude.com/claude-code)
and other coding CLIs ([Kilo](https://kilo.ai), [OpenCode](https://opencode.ai)).
Pick a provider, models and permission flags once — then `swisscode` behaves
exactly like `claude`, only pointed at [OpenRouter](https://openrouter.ai),
[z.ai / GLM](https://z.ai), Kimi, DeepSeek, Qwen, ModelScope, SiliconFlow,
[Ollama](https://ollama.com) running on your own machine, or any other
Anthropic-compatible endpoint.

Unlike a router/proxy or a desktop GUI, swisscode is a **launcher**: it sets the
right environment and `exec`s the real CLI, so there is **no proxy, no daemon, no
background process** — and it fixes third-party correctness bugs (like the
[silent 200K → 1M context downgrade](#extended-context-1m)) that a log-reader or
proxy structurally cannot.

- **Any provider** — OpenRouter, z.ai/GLM, Kimi, DeepSeek, Qwen, ModelScope, SiliconFlow, or a custom Anthropic-compatible endpoint.
- **Local models, no key** — [Ollama](#ollama) speaks the Anthropic Messages API natively, so `swisscode` points Claude Code at `localhost` with no proxy and nothing to sign up for.
- **Any agent** — Claude Code (default), [Kilo](https://kilo.ai) or [OpenCode](https://opencode.ai), selectable per profile or per run.
- **Named profiles &amp; per-directory bindings** — the right backend per repo, automatically.
- **Correctness fixes** — real 1M context (`[1m]`), catalog-driven auto-compaction, gateway compatibility flags.
- **A preflight `doctor`** — binary, endpoint, credential, models, real tool-calling probe, and the context window your local server actually loaded.
- **No proxy, no daemon, no GUI** — a single binary that `exec`s the real CLI, so nothing sits between you and your agent.

It replaces shell aliases like this:

```sh
alias claudeor='ANTHROPIC_AUTH_TOKEN=sk-or-... ANTHROPIC_BASE_URL=https://openrouter.ai/api \
  ANTHROPIC_DEFAULT_OPUS_MODEL=openrouter/fusion ... claude --dangerously-skip-permissions'
```

## Usage

```sh
npx swisscode          # first run opens setup, then launches
npx swisscode          # every run after: launches straight into Claude Code
```

For daily use install it globally — `npx` re-checks the registry on every
invocation, which you'll feel on a tool you launch dozens of times a day:

```sh
npm install -g swisscode
```

Every argument that isn't listed below is forwarded to `claude` untouched:

```sh
swisscode "fix the failing test"
swisscode --resume --model opus
swisscode -p "summarise this diff" < diff.txt
```

| Command / flag | Effect |
| --- | --- |
| `swisscode config` | Reopen the settings UI |
| `swisscode <profile>` | Use that profile for this run (see [Profiles](#profiles)) |
| `swisscode --safe` | Force permission prompts **on** for this run |
| `swisscode --yolo` | Force `--dangerously-skip-permissions` **on** for this run |
| `swisscode --cc-…` | Per-run overrides (see [Per-run overrides](#per-run-overrides)) |
| `swisscode -- …` | Everything after `--` goes to `claude` verbatim |

`config`, `setup`, `--safe`, `--yolo` and the `--cc-` **prefix** are the only
reserved things. Everything else — including every subcommand below — lives
under `config`, so no ordinary English word is ever taken away from you. If you
need to pass a reserved token through literally, put it after `--`:

```sh
swisscode -- --cc-profile   # claude receives "--cc-profile"
```

## Profiles

A profile is a named provider + key + models. Name one after each account,
client or experiment.

```sh
swisscode config work           # create or edit the "work" profile
swisscode config list           # every profile (keys are never printed)
swisscode config default work   # used when nothing else applies
swisscode config rm old         # deletes it, and any bindings to it
```

Once a profile exists, its name is usable in `argv[0]`:

```sh
swisscode work --resume
```

If the first word isn't a profile name it's passed straight to `claude`, so
`swisscode fix the login bug` still works. To be explicit either way, use
`--cc-profile work` — an unknown name there is an error rather than a prompt.

Profile names must start with a letter or digit and contain only letters,
digits, `.`, `_` or `-`. Names that would collide with a subcommand, or with a
word you're likely to start a prompt with (`fix`, `test`, `run`, …), are
refused at creation time.

## Per-directory bindings

Bind a directory to a profile and every launch from it — or from anything
underneath it — uses that profile.

```sh
cd ~/clients/acme
swisscode config use acme       # bind this directory
swisscode config use --show     # which profile applies here, and why
swisscode config use --clear    # remove this directory's binding
swisscode config bindings       # list all of them
swisscode config bindings --prune   # drop ones whose dir or profile is gone
```

The nearest ancestor wins, so a binding deeper in the tree overrides a shallower
one. `--show` prints the exact path the binding came from, which is the thing
you need when a directory picks a profile you didn't expect.

Bindings live in `~/.config/swisscode/config.json`, keyed by absolute path.
Nothing is written into your project, so nothing leaks into a commit — the
tradeoff is that bindings don't travel with a clone. They're keyed by the
physical path (`process.cwd()`), so a symlinked route to the same directory is
a different key.

Resolution costs no syscalls: the binding map is already in the config file
being read, and the "walk" is string arithmetic bounded by the shallowest
binding you have. A binding to a directory you've since deleted is inert until
you `--prune` it.

## Per-run overrides

Every `--cc-` flag applies to exactly one launch and is **never** written to
disk. All of them are stripped before `claude` is executed.

| Flag | Effect |
| --- | --- |
| `--cc-profile <name>` | Use this profile. Unknown name → exit 2 |
| `--cc-provider <id>` | Switch provider (see the credential rule below) |
| `--cc-agent <id>` | Launch a different coding CLI (see [Agents](#agents)). Unknown id → exit 2 |
| `--cc-base-url <url>` | Point at a different endpoint |
| `--cc-model <id>` | Set **all four** tiers |
| `--cc-model <tier>=<id>` | Set one tier; repeatable; applied left to right |
| `--cc-env KEY=VALUE` | Set an env var. `KEY=` **unsets** it |

```sh
swisscode --cc-model kimi-k3 --cc-model haiku=glm-4.6 -p "..."
swisscode --cc-base-url http://localhost:8080 --cc-env API_TIMEOUT_MS=600000
```

A bare `--cc-model` sets all four tiers on purpose. `[1m]` is read per
variable, so a one-tier override is exactly the shape of the bug where three
tiers get an extended context window and the fourth silently doesn't.

**`--cc-provider` never sends a credential to a host it wasn't entered for.**
In order: keep the key if the provider is unchanged; else borrow the key,
endpoint *and models* from another profile that already uses that provider;
else use one already in your environment; else exit 2. There is no "just send
the key we have" fallback — that's how a z.ai token ends up POSTed to
OpenRouter. Model ids are dropped for the same reason: `glm-5.2` sent to
OpenRouter is a guaranteed 404 wearing the costume of a working config.

Any unrecognised `--cc-*` option is an error rather than a passthrough token,
because forwarding a typo'd `--cc-porfile` would put it in your prompt while
the launch quietly used the wrong account.

## Checking a setup

```sh
swisscode config doctor              # check everything
swisscode config doctor --offline    # skip the network probes
swisscode config doctor --json       # for scripts and CI
swisscode config doctor --fix        # apply the unambiguous repairs
```

Doctor verifies binary resolution, which profile is active and why, endpoint
reachability, credential validity, model existence, tool-calling support,
conflicting shell variables, and config file permissions.

Exit codes are meant for CI: **0** clean, **1** warnings, **2** errors.

Three things worth knowing:

- **It never runs automatically.** The probes are real inference requests
  (`max_tokens: 1`, at most one per distinct model plus one tool-calling
  probe). A launcher that quietly billed you a token on every start would be a
  worse bug than anything it detects. Use `--offline` to skip them entirely.
- **It never prints your key** — not masked, not truncated, not length-hinted.
  Anything a gateway echoes back is redacted before it's rendered, so a report
  is safe to paste into a bug thread. Note that it *does* print binding paths,
  which contain directory names.
- **Probes are non-streaming, for every provider.** ModelScope answers a bad
  token with HTTP 200 followed by an SSE stream that dies silently — a
  streaming probe there cannot tell a rejected credential from a slow model.
  With `stream: false` the same token has to produce a real status code.

Total runtime is bounded by a hard budget (`--timeout <ms>`, 20s by default);
checks that don't fit are reported as skipped rather than silently passing.

## Providers

| Provider | Endpoint | Notes |
| --- | --- | --- |
| Anthropic | default (keeps your existing login) | clears any gateway URL left in your shell |
| z.ai | `https://api.z.ai/api/anthropic` | GLM; `glm-5.2` runs at its extended 1M window |
| OpenRouter | `https://openrouter.ai/api` | browsable catalog; pins `CLAUDE_CODE_SUBAGENT_MODEL`, which subagents need in order not to 404 |
| ModelScope | `https://api-inference.modelscope.cn` | browsable catalog; keep the `ms-` prefix on your token |
| SiliconFlow | `https://api.siliconflow.com` | use `https://api.siliconflow.cn` for mainland accounts; a `Pro/` prefix selects the paid variant |
| Ollama | `http://localhost:11434` | local models, no key; browsable catalog of what you've pulled — see [Ollama](#ollama) |
| Ollama Cloud | `https://ollama.com` | Ollama's hosted models; needs an API key |
| Custom | any Anthropic-compatible endpoint | |

Note the ModelScope, SiliconFlow and Ollama endpoints are **bare hosts**. The
`/v1` that appears alongside them in the vendors' docs is the OpenAI-compatible
route; adding it here produces `/v1/v1/messages` and a 404.

Whichever provider you pick, swisscode removes `ANTHROPIC_API_KEY` from the
child environment unless that provider is the one that uses it. A stale key left
in your shell would otherwise make Claude Code fall back to Anthropic and bill
the wrong account.

Not shipped, deliberately: **iFlow** (keys expire after seven days and the route
is undocumented), **Volcengine** (the docs reportedly warn that driving these
endpoints from your own scripts risks account suspension), and **DeepSeek
direct** (`api.deepseek.com/anthropic` returns `400 unknown variant "system"` on
Claude Code >= 2.1.154, with no verified workaround — DeepSeek weights through
OpenRouter are fine).

### Ollama

Ollama **v0.14.0+** implements the Anthropic Messages API natively — this is a
real endpoint, not an OpenAI shim being translated — so a local model is just
another provider. No proxy, and no key:

```sh
swisscode config local        # pick Ollama, leave the key blank
swisscode local               # launches Claude Code against localhost:11434
```

The picker browses the models you have actually pulled, and marks which of them
support tool calling — Claude Code cannot function without it, and plenty of
local models lack it. `qwen3-coder` and `gpt-oss` are the usual choices.

Doctor also probes tool calling for real, which catches the case a capability
flag cannot: a model that *advertises* tools but is too small to reliably emit
one.

> **The one thing that will bite you: context.** The window Ollama serves is a
> property of **how you started the server** — `OLLAMA_CONTEXT_LENGTH`, or a
> Modelfile `PARAMETER num_ctx` that overrides it — not of the model id. Claude
> Code assumes 200K regardless, and nothing errors when they disagree: the model
> just silently forgets the beginning of the conversation.
>
> So `swisscode config doctor` measures it and warns below 32K:
>
> ```
> ✓ context window       qwen3:0.6b loaded with a 32K window (model ceiling 40K)
> ! context window       qwen3:0.6b is loaded with a 4K window; Claude Code assumes
>                        200K and will not be told otherwise, so it silently forgets
>                        the start of long conversations
>   ↳ Restart Ollama with OLLAMA_CONTEXT_LENGTH=65536 (64K). A Modelfile
>     `PARAMETER num_ctx` overrides that variable, so check it too
> ```
>
> Those are two different numbers on purpose: the **loaded** window is what
> governs, while the model's **ceiling** is only an upper bound. swisscode does
> not guess either one at launch — a window set too large means the conversation
> overflows instead of compacting.

`http://` is correct for the local endpoint and is exempt from the
cleartext-credential warning, which applies to non-loopback hosts only — point
a profile at a *remote* Ollama over `http://` and swisscode will tell you.

Ollama Cloud is a separate preset because it authenticates for real, and
currently accepts only `Authorization: Bearer` rather than Anthropic's
`x-api-key` ([ollama/ollama#16922](https://github.com/ollama/ollama/issues/16922)).
swisscode already sends the bearer spelling, so it works today.

**If Ollama becomes unresponsive**, you have hit
[ollama/ollama#13949](https://github.com/ollama/ollama/issues/13949): Claude
Code polls `/v1/messages/count_tokens?beta=true`, which Ollama does not
implement. It did not reproduce here on 0.32.0, but if it happens to you:

```sh
swisscode --cc-env CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

or set `"compat": {"disableNonessentialTraffic": true}` on the profile. That
switch **also disables gateway model discovery**, so swisscode says so on
stderr when it is on — it is not shipped on by default, because a preset that
quietly removed a feature to dodge an upstream bug would be the kind of silent
behaviour this tool exists to avoid.

## Agents

The **provider** is which model backend you talk to; the **agent** is which
coding CLI you launch against it. They are orthogonal — any provider works with
any agent, because every provider preset is an Anthropic-compatible endpoint and
each agent is pointed at it.

| Agent | id | Binary | Install |
| --- | --- | --- | --- |
| Claude Code (default) | `claude-code` | `claude` | [claude.com/claude-code](https://claude.com/claude-code) |
| Kilo | `kilo` | `kilo` | `npm i -g @kilocode/cli` |
| OpenCode | `opencode` | `opencode` | `npm i -g opencode-ai` |

```sh
swisscode config agent                 # list agents and which profile uses each
swisscode config agent work opencode   # make the "work" profile launch OpenCode
swisscode --cc-agent kilo -p "…"        # one run, without changing the profile
```

A profile with no agent set launches Claude Code, so nothing changes for an
existing setup. swisscode resolves the agent's binary the same way it resolves
`claude` — PATH first, then the usual install locations — and each has its own
override: `SWISSCODE_CLAUDE_BIN`, `SWISSCODE_KILO_BIN`, `SWISSCODE_OPENCODE_BIN`.

**How it reaches the provider.** Claude Code reads `ANTHROPIC_*` variables
directly. Kilo and OpenCode instead take a full config inline
(`KILO_CONFIG_CONTENT` / `OPENCODE_CONFIG_CONTENT`) that swisscode generates on
the fly — an `@ai-sdk/anthropic` provider aimed at your endpoint and key. No
file is written to your disk.

**Capability differences are surfaced, never silently dropped.** Claude Code has
four model tiers; Kilo has one slot and OpenCode has a main plus a small model.
When a profile pins tiers an agent can't express, swisscode uses the opus-tier
model and prints which tiers it ignored. The `[1m]` extended-context suffix is a
Claude-Code-specific signal, so on Kilo/OpenCode you get a one-line warning that
a 1M-window provider is being reached at its standard window.

> **Kilo/OpenCode support is new.** The generated config matches each CLI's
> documented schema, but the exact field names live behind single constants in
> `src/adapters/agents/{kilo,opencode}/index.ts` — if a CLI update moves one,
> it's a one-line fix with a test to catch it.

## Model picker

Providers with a queryable catalog (currently OpenRouter) get a browsable
picker instead of asking you to type model ids from memory:

```
model for opus  ·  search: claude▌
19/342 shown · tools only

› anthropic/claude-fable-5     Anthropic: Claude Fable 5
  anthropic/claude-opus-4.8    anthropic/claude-fable-5
  anthropic/claude-sonnet-5
  anthropic/claude-haiku-4.5   input        $10.00 / M tokens
                               output       $50.00 / M tokens
                               context      1M  (max out 128K)
                               ✓ tools ✓ reasoning

                               artificial analysis
                               intelligence ████████████░░░░░░░░ 59.9
                               coding       ███████████████░░░░░ 76.5
```

| Key | Action |
| --- | --- |
| `↑` `↓` | move · `PgUp`/`PgDn` to jump |
| type | fuzzy search across id and name |
| `^T` | toggle the tools-only filter |
| `^F` | show only free models |
| `^R` | refetch the catalog |
| `⏎` / `esc` | select / go back |

**Tools filter.** Claude Code cannot work without tool calling, and 71 of
OpenRouter's 342 models don't support it — so they're hidden by default rather
than left to fail at runtime. `^T` reveals them, with a warning on the model.

Models are sorted best-coding-first using Artificial Analysis benchmark scores
where available. The catalog is cached for 24h at
`~/.config/swisscode/models-<catalog>.json`; if the fetch fails, a stale
cache is used and the header says so.

> **Note:** tokens/sec is not shown. OpenRouter's public API exposes
> `throughput_last_30m` and `latency_last_30m` fields, but they are `null` for
> every model and provider — the figures on their website come from a source
> the API doesn't serve. The benchmark scores stand in for it.

## Configuration

Settings live in `~/.config/swisscode/config.json` (honours
`XDG_CONFIG_HOME`), written `0600` inside a `0700` directory because the file
holds an API key in plaintext.

```json
{
  "version": 2,
  "profiles": {
    "openrouter": {
      "provider": "openrouter",
      "apiKey": "sk-or-…",
      "models": {
        "opus": "openrouter/fusion",
        "sonnet": "…",
        "haiku": "…",
        "fable": "…"
      },
      "skipPermissions": true,
      "compat": { "disableAdaptiveThinking": true },
      "contextWindows": { "openrouter/fusion": 1000000 },
      "env": { "ANY_EXTRA_VAR": "value" }
    }
  },
  "defaultProfile": "openrouter",
  "bindings": { "/Users/me/clients/acme": "acme" },
  "settings": { "quiet": false, "bindingWalkDepth": 40 }
}
```

`bindings` records absolute paths, which means client names and project layout.
That's new non-credential information in this file — worth remembering before
pasting it into a bug report.

A config written by swisscode 0.1.0 — a single flat object with a top-level
`provider` — is migrated to this shape automatically the first time a newer
version reads it. The original is kept beside it as `config.v1.bak.json`, and a
migration that cannot be written to disk is used in memory rather than blocking
the launch.

Claude Code has **four** model tiers. A tier you leave out inherits the
provider's default; a tier set to the empty string is explicitly unset. Setting
them from one table is deliberate — Claude Code reads the extended-context
`[1m]` marker per variable, so a tier that gets missed runs at the narrower
window with no error and no warning.

Instead of `apiKey` you can write `"apiKeyFromEnv": "MY_TOKEN"` to read the
credential from your environment at launch, which keeps the secret out of the
file.

The optional `env` block is applied last, so it can override anything the
provider sets. An empty string **unsets** a variable rather than setting it to
empty.

### Extended context (`[1m]`)

Claude Code assumes a 200K context window for any endpoint that is not
`api.anthropic.com`. The documented way to say otherwise is a `[1m]` suffix on
the model id — and it is read **per `ANTHROPIC_DEFAULT_*_MODEL` variable**, so
suffixing three tiers and forgetting the fourth leaves that tier at 200K
silently.

You never type the suffix. A provider declares which of its models genuinely
support the wider window, and swisscode derives the suffix for every tier from
that one list. Pin a tier to a model that is not on the list and swisscode
tells you that tier is running narrow; write a suffix by hand for a provider
that does not support it and swisscode strips it, because sending an id the
endpoint does not recognise fails hard while a narrower window merely
disappoints.

Configs written before this landed need no editing: normalisation happens on the
way out, so a stored `glm-5.2` reaches Claude Code as `glm-5.2[1m]` without
anything on disk being rewritten.

### Auto-compact window

When swisscode knows a model's real context length it sets
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, which is where Claude Code starts summarising
the conversation. This is **in addition to** `[1m]`, not a substitute: the
suffix is what widens the window, this says where to compact inside it.

The number comes from measured data only — a catalog's published context length,
recorded when you pick a model, or a window the provider documents. If any tier
is running a model with no such data, swisscode sets nothing at all rather than
guessing; a guessed window that is too large means the conversation overflows
instead of compacting. It is skipped entirely for first-party Anthropic, which
knows its own models better than we do.

### Gateway compatibility flags

Gateways disagree with Claude Code in specific, diagnosable ways. Each flag
below names the symptom it clears; set them per profile under `compat`:

```json
"compat": { "disableAdaptiveThinking": true, "skipFastModeOrgCheck": false }
```

| Flag | Clears |
| --- | --- |
| `disableExperimentalBetas` | `400 Extra inputs are not permitted` |
| `disableAdaptiveThinking` | `400 Input tag 'adaptive' found` |
| `skipFastModeOrgCheck` | fast mode reports "disabled by organization" |
| `enableToolSearch` | MCP tool search being off by default off-first-party |
| `forceIdleTimeoutOff` | long stalls on slow or locally hosted models |
| `dropAttributionHeader` | poor prompt-cache hit rate through a gateway |
| `disableNonessentialTraffic` | an endpoint wedged by background requests (Ollama) — **has a cost, see below** |

A profile's `compat` overrides the provider's defaults key by key. Setting one
to `false` actively clears the variable, so turning a flag off also defeats one
left set in your shell.

**A flag that trades something away says so.** `disableNonessentialTraffic` also
disables gateway model discovery, so swisscode prints what it costs rather than
letting it look like a free switch — loudly on stderr when a *provider* turns it
on for you, quietly (doctor-only) when you asked for it yourself. That
distinction is the rule: a compatibility flag may never remove a capability
silently.

### Warnings about your shell

Variables you exported once and forgot outrank nothing — the profile always
wins. But winning silently looks identical to never having conflicted, so
swisscode prints a line to **stderr** (never stdout, which belongs to Claude
Code) when your environment and your profile disagree about something this
launch touches.

A stale `ANTHROPIC_API_KEY` gets its own message, because it is the only failure
here that costs money: left in place it makes Claude Code fall back to Anthropic
and bill that account for traffic you meant to send to a gateway.

A clean environment produces no output. Set `"quiet": true` under `settings`, or
`SWISSCODE_QUIET=1`, to suppress the lot.

### Which profile am I using?

When a launch uses a profile you didn't get by default — because you named one,
a directory binding applied, or a `--cc-` flag changed something — one line goes
to stderr saying so:

```
swisscode: profile "acme" (binding: /Users/me/clients/acme) → openrouter · openrouter/fusion
```

The ordinary default-profile launch stays silent, which is what keeps that line
worth reading. `swisscode config use --show` answers the same question without
launching anything.

| Env var | Effect |
| --- | --- |
| `SWISSCODE_CLAUDE_BIN` | Use a specific `claude` binary |
| `SWISSCODE=1` | Set by us in the child, so hooks can detect the wrapper |
| `SWISSCODE_QUIET=1` | Suppress warnings and the profile banner |

## How it launches

`swisscode` resolves the real `claude` binary from `PATH` (skipping itself, so
`alias claude=swisscode` can't recurse), builds the environment, then calls
`process.execve` to **replace its own process image**. Claude Code inherits the
same pid, tty and process group, and no wrapper process is left behind — nothing
to relay exit codes through, no idle Node process for the length of your
session.

Where `process.execve` does not exist — Windows, IBM i, and Node older than
22.15 — it falls back to `spawn` with inherited stdio, relaying the child's exit
code and re-raising a killing signal rather than reporting a clean exit. It also
falls back if `execve` exists but *fails* (EACCES, ETXTBSY, a TOCTOU ENOENT):
dying there would be worse than spawning.

The Ink UI is loaded lazily, so the normal launch path never imports React.

## Development

swisscode is written in TypeScript and **published as compiled JavaScript**.
Nothing in the tarball relies on Node's native type stripping, which is not
reliably enabled across the whole `>=22` engines range.

```sh
npm install
npm run typecheck   # tsc --noEmit over src/ and test/
npm run build       # tsc: src/ -> dist/   +   esbuild: the Ink UI -> dist/ui.js
npm test            # typecheck, build, then the full suite
npm run dev         # build once, then tsc --watch on the launch path
```

### The inner loop

Node runs `.ts` directly, so most tests need no build at all:

```sh
node --test "test/core/**/*.test.ts"    # ~0.2s, no build step
```

The exception is the three UI suites (`ui`, `picker`, `profiles-ui`), which
drive the wizard through the built bundle and therefore need `npm run build`
first. `npm test` always builds, so it is the safe default.

### Layout

| path | what it is | shipped? |
|---|---|---|
| `bin/swisscode.js` | the published entry point. Plain JS on purpose, never compiled — it runs before anything is known about the environment, so it carries no dependencies and no syntax needing a build. Imports `../dist/cli.js`. | yes |
| `src/core/**` | pure domain logic. No I/O, no state, imports nothing outside `core/` and `node:` builtins. | as `dist/core/**` |
| `src/ports/**` | interfaces only. Every one of these files erases to `export {}`. | as `dist/ports/**` |
| `src/adapters/**` | the implementations — providers, catalogs, fs, process, net, clock, doctor probe, and the Ink UI. | all but `adapters/ui` |
| `src/composition/**` | the composition roots that wire adapters into ports. | all but `ui-root` |
| `test/**` | `.ts`, run straight from source. Never compiled, never packed. | no |

Two tsconfigs, because they do different jobs: `tsconfig.json` typechecks the
whole program (`src` + `test`) and emits nothing — it is what the editor loads
and what `npm run typecheck` runs. `tsconfig.build.json` emits `src/` to `dist/`
and **excludes the Ink UI**, which esbuild bundles separately into
`dist/ui.js`. Emitting the UI twice would put React-importing modules inside a
package whose entire selling point is that the launch path never touches them.

### Two rules worth knowing before you edit

**A relative import names the file that actually exists on disk** — write
`'./format.ts'`, not `'./format.js'`. Node's type stripper does not remap `.js`
to `.ts`, so the usual TypeScript-ESM convention would make the sources
unrunnable; `rewriteRelativeImportExtensions` converts the specifier on the way
out, so `dist/` still says `.js`.

**Nothing under `src/` may name the UI, even in type space.** A plain
`import type` is enough to pull the whole component tree into the build program
and ship a second, unbundled copy of React. `src/cli.ts` therefore declares the
bundle's shape structurally, and `test/ports.conformance.ts` — which is never
emitted — checks that declaration against the real module.

## Contributing

Contributions are very welcome, and the docs are written to make one cheap:

| | |
| --- | --- |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | setup, the inner loop, recipes, review, sign-off |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | the map, the layers, the agent seam, the invariants |
| [docs/STYLE.md](docs/STYLE.md) | the project's DNA — how code is written here, and why |
| [docs/TESTING.md](docs/TESTING.md) | the suite's structure and the 0.3s inner loop |
| [docs/SECURITY.md](docs/SECURITY.md) | threat model, and how to report a vulnerability privately |
| [AGENTS.md](AGENTS.md) | the machine-readable brief for coding agents |

**Coding agents are first-class contributors here.** Plenty of projects are
working out how to say *no* to AI-written patches; this one says yes, and is
built for it — the invariants are enforced by `test/architecture.test.ts` rather
than left as norms to infer, the file headers carry the reasoning behind each
decision, and the core test loop runs in 0.3 seconds with no build. Point your
agent at [AGENTS.md](AGENTS.md).

No disclosure is required, and human-written PRs are welcome on identical terms.
The only real standard: understand the change well enough to answer questions
about it. Sign your commits off with `git commit -s`
([DCO](https://developercertificate.org/), not a CLA).

## Licence

MIT
