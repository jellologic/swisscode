# cuckoocode

A drop-in launcher for [Claude Code](https://claude.com/claude-code). Pick a
provider, models and permission flags once; after that `cuckoocode` behaves
exactly like `claude`.

It replaces shell aliases like this:

```sh
alias claudeor='ANTHROPIC_AUTH_TOKEN=sk-or-... ANTHROPIC_BASE_URL=https://openrouter.ai/api \
  ANTHROPIC_DEFAULT_OPUS_MODEL=openrouter/fusion ... claude --dangerously-skip-permissions'
```

## Usage

```sh
npx cuckoocode          # first run opens setup, then launches
npx cuckoocode          # every run after: launches straight into Claude Code
```

For daily use install it globally — `npx` re-checks the registry on every
invocation, which you'll feel on a tool you launch dozens of times a day:

```sh
npm install -g cuckoocode
```

Every argument that isn't listed below is forwarded to `claude` untouched:

```sh
cuckoocode "fix the failing test"
cuckoocode --resume --model opus
cuckoocode -p "summarise this diff" < diff.txt
```

| Command / flag | Effect |
| --- | --- |
| `cuckoocode config` | Reopen the settings UI |
| `cuckoocode <profile>` | Use that profile for this run (see [Profiles](#profiles)) |
| `cuckoocode --safe` | Force permission prompts **on** for this run |
| `cuckoocode --yolo` | Force `--dangerously-skip-permissions` **on** for this run |
| `cuckoocode --cc-…` | Per-run overrides (see [Per-run overrides](#per-run-overrides)) |
| `cuckoocode -- …` | Everything after `--` goes to `claude` verbatim |

`config`, `setup`, `--safe`, `--yolo` and the `--cc-` **prefix** are the only
reserved things. Everything else — including every subcommand below — lives
under `config`, so no ordinary English word is ever taken away from you. If you
need to pass a reserved token through literally, put it after `--`:

```sh
cuckoocode -- --cc-profile   # claude receives "--cc-profile"
```

## Profiles

A profile is a named provider + key + models. Name one after each account,
client or experiment.

```sh
cuckoocode config work           # create or edit the "work" profile
cuckoocode config list           # every profile (keys are never printed)
cuckoocode config default work   # used when nothing else applies
cuckoocode config rm old         # deletes it, and any bindings to it
```

Once a profile exists, its name is usable in `argv[0]`:

```sh
cuckoocode work --resume
```

If the first word isn't a profile name it's passed straight to `claude`, so
`cuckoocode fix the login bug` still works. To be explicit either way, use
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
cuckoocode config use acme       # bind this directory
cuckoocode config use --show     # which profile applies here, and why
cuckoocode config use --clear    # remove this directory's binding
cuckoocode config bindings       # list all of them
cuckoocode config bindings --prune   # drop ones whose dir or profile is gone
```

The nearest ancestor wins, so a binding deeper in the tree overrides a shallower
one. `--show` prints the exact path the binding came from, which is the thing
you need when a directory picks a profile you didn't expect.

Bindings live in `~/.config/cuckoocode/config.json`, keyed by absolute path.
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
| `--cc-base-url <url>` | Point at a different endpoint |
| `--cc-model <id>` | Set **all four** tiers |
| `--cc-model <tier>=<id>` | Set one tier; repeatable; applied left to right |
| `--cc-env KEY=VALUE` | Set an env var. `KEY=` **unsets** it |

```sh
cuckoocode --cc-model kimi-k3 --cc-model haiku=glm-4.6 -p "..."
cuckoocode --cc-base-url http://localhost:8080 --cc-env API_TIMEOUT_MS=600000
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
cuckoocode config doctor              # check everything
cuckoocode config doctor --offline    # skip the network probes
cuckoocode config doctor --json       # for scripts and CI
cuckoocode config doctor --fix        # apply the unambiguous repairs
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
| Custom | any Anthropic-compatible endpoint | |

Note the ModelScope and SiliconFlow endpoints are **bare hosts**. The `/v1` that
appears alongside them in the vendors' docs is the OpenAI-compatible route;
adding it here produces `/v1/v1/messages` and a 404.

Whichever provider you pick, cuckoocode removes `ANTHROPIC_API_KEY` from the
child environment unless that provider is the one that uses it. A stale key left
in your shell would otherwise make Claude Code fall back to Anthropic and bill
the wrong account.

Not shipped, deliberately: **iFlow** (keys expire after seven days and the route
is undocumented), **Volcengine** (the docs reportedly warn that driving these
endpoints from your own scripts risks account suspension), and **DeepSeek
direct** (`api.deepseek.com/anthropic` returns `400 unknown variant "system"` on
Claude Code >= 2.1.154, with no verified workaround — DeepSeek weights through
OpenRouter are fine).

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
`~/.config/cuckoocode/models-<catalog>.json`; if the fetch fails, a stale
cache is used and the header says so.

> **Note:** tokens/sec is not shown. OpenRouter's public API exposes
> `throughput_last_30m` and `latency_last_30m` fields, but they are `null` for
> every model and provider — the figures on their website come from a source
> the API doesn't serve. The benchmark scores stand in for it.

## Configuration

Settings live in `~/.config/cuckoocode/config.json` (honours
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

A config written by cuckoocode 0.1.0 — a single flat object with a top-level
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
support the wider window, and cuckoocode derives the suffix for every tier from
that one list. Pin a tier to a model that is not on the list and cuckoocode
tells you that tier is running narrow; write a suffix by hand for a provider
that does not support it and cuckoocode strips it, because sending an id the
endpoint does not recognise fails hard while a narrower window merely
disappoints.

Configs written before this landed need no editing: normalisation happens on the
way out, so a stored `glm-5.2` reaches Claude Code as `glm-5.2[1m]` without
anything on disk being rewritten.

### Auto-compact window

When cuckoocode knows a model's real context length it sets
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, which is where Claude Code starts summarising
the conversation. This is **in addition to** `[1m]`, not a substitute: the
suffix is what widens the window, this says where to compact inside it.

The number comes from measured data only — a catalog's published context length,
recorded when you pick a model, or a window the provider documents. If any tier
is running a model with no such data, cuckoocode sets nothing at all rather than
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

A profile's `compat` overrides the provider's defaults key by key. Setting one
to `false` actively clears the variable, so turning a flag off also defeats one
left set in your shell.

There is deliberately no flag for `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`: it
also disables gateway model discovery, which is not what anyone reaching for a
compatibility switch is asking for.

### Warnings about your shell

Variables you exported once and forgot outrank nothing — the profile always
wins. But winning silently looks identical to never having conflicted, so
cuckoocode prints a line to **stderr** (never stdout, which belongs to Claude
Code) when your environment and your profile disagree about something this
launch touches.

A stale `ANTHROPIC_API_KEY` gets its own message, because it is the only failure
here that costs money: left in place it makes Claude Code fall back to Anthropic
and bill that account for traffic you meant to send to a gateway.

A clean environment produces no output. Set `"quiet": true` under `settings`, or
`CUCKOOCODE_QUIET=1`, to suppress the lot.

### Which profile am I using?

When a launch uses a profile you didn't get by default — because you named one,
a directory binding applied, or a `--cc-` flag changed something — one line goes
to stderr saying so:

```
cuckoocode: profile "acme" (binding: /Users/me/clients/acme) → openrouter · openrouter/fusion
```

The ordinary default-profile launch stays silent, which is what keeps that line
worth reading. `cuckoocode config use --show` answers the same question without
launching anything.

| Env var | Effect |
| --- | --- |
| `CUCKOOCODE_CLAUDE_BIN` | Use a specific `claude` binary |
| `CUCKOOCODE=1` | Set by us in the child, so hooks can detect the wrapper |
| `CUCKOOCODE_QUIET=1` | Suppress warnings and the profile banner |

## How it launches

`cuckoocode` resolves the real `claude` binary from `PATH` (skipping itself, so
`alias claude=cuckoocode` can't recurse), builds the environment, then calls
`process.execve` to **replace its own process image**. Claude Code inherits the
same pid, tty and process group, and no wrapper process is left behind — nothing
to relay exit codes through, no idle Node process for the length of your
session. On Windows and Node < 23.11 it falls back to `spawn` with inherited
stdio.

The Ink UI is loaded lazily, so the normal launch path never imports React.

## Development

```sh
npm install
npm run build    # bundles the Ink UI into dist/
npm test         # drives the setup wizard with synthetic keystrokes
```

## Licence

MIT
