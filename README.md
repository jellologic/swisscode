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
