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
| `cuckoocode --safe` | Force permission prompts **on** for this run |
| `cuckoocode --yolo` | Force `--dangerously-skip-permissions` **on** for this run |
| `cuckoocode -- …` | Everything after `--` goes to `claude` verbatim |

`config`, `setup`, `--safe` and `--yolo` are the only reserved words. If you
need to pass one of them through literally, put it after `--`.

## Providers

| Provider | Endpoint |
| --- | --- |
| Anthropic | default (keeps your existing login) |
| z.ai | `https://api.z.ai/api/anthropic` |
| OpenRouter | `https://openrouter.ai/api` |
| Custom | any Anthropic-compatible endpoint |

Each provider ships sensible default models and handles its own quirks — the
OpenRouter profile clears `ANTHROPIC_API_KEY` and pins
`CLAUDE_CODE_SUBAGENT_MODEL`, which subagents need in order not to 404.

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
`~/.config/cuckoocode/models-openrouter.json`; if the fetch fails, a stale
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
  "provider": "openrouter",
  "apiKey": "sk-or-…",
  "models": { "opus": "openrouter/fusion", "sonnet": "…", "haiku": "…" },
  "skipPermissions": true,
  "env": { "ANY_EXTRA_VAR": "value" }
}
```

The optional `env` block is applied last, so it can override anything the
provider sets. An empty string **unsets** a variable rather than setting it to
empty.

| Env var | Effect |
| --- | --- |
| `CUCKOOCODE_CLAUDE_BIN` | Use a specific `claude` binary |
| `CUCKOOCODE=1` | Set by us in the child, so hooks can detect the wrapper |

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
