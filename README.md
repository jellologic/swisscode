<p align="center">
  <img src="https://raw.githubusercontent.com/jellologic/swisscode/main/assets/hero.png" alt="swisscode — every Claude Pro and Max account you own, one command away: multi-account vault, rate-limit failover proxy, traffic inspector" width="100%">
</p>

# swisscode — run Claude Code with multiple accounts, a rate-limit failover proxy, and any Anthropic-compatible provider

<p align="center">
  <a href="https://github.com/jellologic/swisscode/actions/workflows/ci.yml"><img src="https://github.com/jellologic/swisscode/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://www.npmjs.com/package/swisscode"><img src="https://img.shields.io/npm/v/swisscode?logo=npm&logoColor=white" alt="npm version"></a>
  <img src="https://img.shields.io/npm/dm/swisscode" alt="npm monthly downloads">
  <img src="https://img.shields.io/badge/node-%3E%3D22-5fa04e?logo=node.js&logoColor=white" alt="Node.js 22 or newer">
  <img src="https://img.shields.io/badge/license-MIT-3da639" alt="MIT license">
  <img src="https://img.shields.io/badge/runs%20on-macOS%20%7C%20Linux-8957e5" alt="macOS and Linux">
</p>

**swisscode** is a launcher and account manager for [Claude Code](https://claude.com/claude-code).
Save several **Claude Pro / Max logins**, see each one's **5-hour and 7-day usage limits**,
and **switch accounts without `/login`**. Route Claude Code through a **localhost proxy**
that **fails over to the next account on a 429 rate limit**, refreshes expired tokens for
you, and records every request for a **turn-by-turn traffic inspector**. Or point Claude
Code at **OpenRouter**, **Meta**, or **any custom Anthropic-compatible endpoint** with stored API keys,
named **profiles**, and a small **web UI**.

```sh
swisscode work            # launch Claude Code as the "work" profile
swisscode accounts usage  # how much of each subscription is left
swisscode proxy run       # one endpoint, many accounts, automatic failover
```

- [Why swisscode](#why-swisscode)
- [Quick start](#quick-start)
- [Multiple Claude accounts](#multiple-claude-accounts-usage-limits-and-switching)
- [The subscription proxy](#the-subscription-proxy-rate-limit-failover-and-traffic-inspection)
- [OpenRouter, Meta, and custom providers](#openrouter-meta-and-custom-anthropic-compatible-providers)
- [Profiles](#profiles)
- [Web UI](#web-ui)
- [Backup and restore](#backup-and-restore)
- [Security model](#security-model)
- [FAQ](#faq)
- [Coming from swisscode 0.6.x](#coming-from-swisscode-06x)
- [Architecture and contributing](#architecture-and-contributing)

## Why swisscode

Claude Code stores exactly one login. If you have a personal Max plan and a work Pro
plan, or you simply hit the 5-hour window and want to keep going on another
subscription, you are back to `/logout`, `/login`, and a browser tab. If you want to
use OpenRouter or a self-hosted gateway, you maintain shell aliases full of
`ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`.

swisscode fixes both:

| Problem | What swisscode does |
| --- | --- |
| Several Claude Pro/Max accounts | A local **vault** of logins with live usage per account and one-command switching |
| Hitting the rate limit mid-task | The **proxy** fails over to the next stored account on `429` / `529`, invisibly to Claude Code |
| Expired tokens | Refreshed automatically, with a lock so parallel requests never burn the same refresh token |
| Different backends per project | **Profiles** bind an agent, a provider, a model, and an account; `swisscode <profile>` launches |
| "What did Claude actually send?" | A **traffic inspector** with conversation threads, tool calls, and token usage per turn |
| Keys scattered in aliases | Stored once as **provider accounts** (0600 files), referenced by profiles, masked everywhere |

Everything is local. swisscode never talks to any server except the provider you chose,
and it looks to Anthropic exactly like Claude Code itself.

## Quick start

```sh
npm i -g swisscode
```

Requires Node.js 22 or newer and an installed `claude` binary. To build from
source instead:

```sh
git clone https://github.com/jellologic/swisscode.git
cd swisscode
npm install
npm run build
(cd apps/cli && npm link)          # puts `swisscode` on your PATH
```

Then either use the web UI or the CLI:

```sh
# Web UI on http://localhost:8124 (binds to localhost only)
cd apps/web && npm run dev

# CLI
swisscode init                                # scaffold a profile from a starter preset
swisscode accounts import personal      # snapshot the current `claude login`
swisscode accounts usage                # 5h / 7d utilization per account
swisscode list                          # profiles (create them in the UI or profiles.json)
swisscode myprofile --dry-run           # show the command and redacted env, launch nothing
swisscode myprofile                     # launch Claude Code
swisscode myprofile -- --resume         # everything after -- goes to claude verbatim
```

Requires Node.js 22 or newer and an installed `claude` binary.

## Multiple Claude accounts: usage limits and switching

```sh
swisscode accounts current                     # who Claude Code is logged in as
swisscode accounts import <id> [--label <l>]   # save the current login to the vault
swisscode accounts list
swisscode accounts usage [id]                  # live 5-hour and 7-day limits
swisscode accounts use <id> [--force]          # make it the system-wide Claude login
swisscode accounts remove <id>
```

**Import** reads Claude Code's own credential store without modifying it: the macOS
Keychain item `Claude Code-credentials` first, then `~/.claude/.credentials.json`.
Each account is stored as a 0600 file under `~/.swisscode/subscriptions/`.

**Switching** (`accounts use`) rewrites Claude Code's store the same way `/login` does:
same Keychain item, all foreign keys preserved, atomic file replace, and a read-back
check. swisscode warns when other `claude` sessions are running because they share
that login. Restart running sessions on macOS to pick up the switch.

**Refresh** happens automatically five minutes before a token expires. When the login
you switched to is also Claude Code's live login, the rotated token is written back so
Claude Code keeps working. When Claude Code rotated a login on its own, swisscode adopts
the live credential instead of retrying a dead one, after checking that it is the same
account.

## The subscription proxy: rate-limit failover and traffic inspection

```sh
swisscode proxy run                 # http://127.0.0.1:8123 (SWISSCODE_PROXY_PORT)
swisscode proxy use <id>            # change the account new requests are signed with
swisscode proxy status
swisscode proxy log [--tail <n>]    # recent requests, redacted
swisscode proxy report [--profile <name>] [--days N] [--by profile|route|day]
```

Every profile launches through the proxy unless it sets `"direct": true`.
The launch points `ANTHROPIC_BASE_URL` at `<proxy>/p/<profileName>` and tags
`ANTHROPIC_AUTH_TOKEN` with `swisscode-profile/<name>`. That tag is an attribution
marker, not a secret: the proxy strips it and signs the upstream request with the vault
token (or the profile's key-provider account, resolved proxy-side). Existing `claude`
sessions are untouched. The old per-profile `"useProxy"` flag is legacy — still stored,
no longer read; `"direct": true` is the opt-out.

<p align="center">
  <img src="https://raw.githubusercontent.com/jellologic/swisscode/main/assets/proxy-flow.png" alt="How the swisscode proxy fails over: Claude Code sends requests to localhost:8123, the proxy signs with the work account, and on a 429 rate limit retries automatically with the personal account while the exhausted account cools down" width="100%">
</p>

What the proxy does per request:

- **Fails over** to the next stored account on `429` or `529`, and puts the exhausted
  account on a cooldown taken from `Retry-After`.
- **Refreshes once** and retries on `401`, coalescing concurrent refreshes per account
  across the proxy, the CLI, and the web UI.
- **Streams** SSE responses byte for byte, cancels the upstream request when Claude Code
  aborts, and survives upstream disconnects.
- **Records** a redacted entry: method, path, status, timing, attempts, the account that
  served it, request facts parsed by the provider, and optionally truncated bodies.
  Headers and tokens are never stored.

Open `/proxy` in the web UI to browse **conversation threads** across requests: the
verdict of each turn, the reply, tool calls decoded, cache-aware token usage, and links
to the local Claude Code session that produced them. Below the live view, **stored
history** survives restarts: totals plus per-day, per-route, and per-profile rollups
over a queryable SQLite index (`~/.swisscode/proxy-traffic.sqlite`;
`SWISSCODE_TRAFFIC_STORE_DAYS` default 30, `SWISSCODE_TRAFFIC_STORE_ROWS` default
100000, `0` = unbounded on either bound), filterable by profile, route, date, and errors-only — the same
filters as `proxy report`, and the URL carries them so a view is shareable. Token
counts are estimates from usage payloads, not bills. Spend is estimated from a
static per-model price table — the `est-spend` column on `proxy report`, a spend
summary on `swisscode show <profile>`, and per-route tables on `/proxy` — with
read-only route suggestions alongside. Estimated spend, not a bill:
subscriptions don't meter per token.

`run` flags: `--port`, `--traffic-log <path>` / `--no-traffic-log` (JSONL at
`~/.swisscode/proxy-traffic.jsonl`), `--log-bodies`, `--traffic-keep <n>` (ring buffer,
default 200), `--traffic-body-bytes <n>` (default 64 KiB per side, `0` = unlimited).

## OpenRouter, Meta, and custom Anthropic-compatible providers

Store API keys once as **provider accounts** and reference them from profiles:

```sh
swisscode accounts --provider openrouter add <id> --set apiKey=sk-or-... [--label <l>]
swisscode accounts --provider openrouter test --set apiKey=...   # check before saving
swisscode accounts --provider openrouter usage [id]              # spend and limits
swisscode accounts --provider openrouter models                  # model catalog
swisscode accounts --provider openrouter model <model-id>        # serving endpoints
swisscode accounts --provider openrouter list | show <id>        # secrets masked
swisscode accounts --provider openrouter update <id> --set key=value
swisscode accounts --provider openrouter remove <id>
```

Muse Spark models work the same way through Meta's Anthropic-compatible endpoint
(the profile also pins Claude Code's internal model tiers to the Spark model, so
subagents and tier routing follow):

```sh
swisscode accounts --provider meta add <id> --set apiKey=LLM_... [--label <l>]
swisscode accounts --provider meta test --set apiKey=...   # check before saving
swisscode accounts --provider meta models                  # model catalog
swisscode accounts --provider meta list | show <id>        # secrets masked
swisscode accounts --provider meta update <id> --set key=value
swisscode accounts --provider meta remove <id>
```

**Custom providers** need no code. Define one in the UI at `/providers/new`: an id, a
display name, config fields (marked secret or not), static env such as
`ANTHROPIC_BASE_URL`, a field-to-env mapping, an optional model env var, and an optional
HTTPS test endpoint for a pre-save connection check. Custom providers then appear in
accounts, profiles, launches, and `/help` exactly like the built-ins. This is how you
point Claude Code at a gateway, an enterprise endpoint, or any other service that speaks
the Anthropic Messages API.

Static env cannot set `PATH`, `HOME`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`, or similar
loader variables, and test endpoints must be public HTTPS hosts.

## Profiles

A profile is one line of JSON in `~/.swisscode/profiles.json`, or a form in the UI.
Skip the blank page with a starter preset: `swisscode init` lists four (solo dev,
heavy-Opus split, frugal Haiku, reviewer) and `swisscode init <preset> [--name
<name>] [--dry-run]` fills its account slots from your stored logins and keys,
prints the profile before saving, and refuses an existing name. The same gallery
sits atop `/profiles/new` as *"Start from…"* — presets copy values in, never
link, so later preset edits never surprise existing profiles.

```json
{
  "name": "work",
  "agentId": "claude-code",
  "providerId": "claude-subscription",
  "subscriptionAccountId": "work",
  "model": "claude-opus-5",
  "agentArgs": ["--verbose"]
}
```

- `providerId` + `providerAccountId` or inline `providerConfig` (inline wins) choose the
  backend and its key.
- `subscriptionAccountId` picks the Claude login. Launches go through the proxy by
  default; `"direct": true` bypasses it (loses failover, model routes, inspection).
- `modelRoutes` sends different models to different backends inside one session —
  exact match, first row wins, with an optional per-route `upstreamModel` rewrite.
- `session` holds Claude Code knobs (effort, permission mode, tools, system prompt,
  MCP, setting sources) emitted as flags plus an ephemeral `--settings` file — your
  own settings files are never rewritten. `session.promptPreset` only records which
  snippet the append text came from (reviewer/planner/explainer in the form); the
  text is what launches, so hand-edits keep working. The `/help` page cheatsheets every knob.
- `cwd` is the working directory the agent spawns in — an absolute path only
  (relative is refused at save time), blank inherits swisscode's directory. It is a
  spawn option, never env, and `show` / `--dry-run` / Preview render it.
- `model` overrides the provider default for this profile.
- `swisscode show <profile>` and `--dry-run` print the resolved command and env with
  every secret masked, by value as well as by name.

Both the CLI and the web UI resolve profiles through the same core function, so what
the preview shows is what launches.

## Web UI

`cd apps/web && npm run dev` serves on `http://localhost:8124`, bound to localhost.

| Page | What it does |
| --- | --- |
| `/` | Dashboard: counts, proxy status, getting started |
| `/profiles` | Create, edit, preview, and delete profiles |
| `/accounts` | Subscription vault and key accounts, live usage, switch actions |
| `/providers` | Built-in catalog plus custom provider editor |
| `/proxy` | Live request threads grouped into conversations |
| `/proxy/<thread>` | Turn-by-turn timeline with tool calls and token usage |
| `/settings` | Backup export and import |
| `/help` | Setup docs generated from each plugin |

## Backup and restore

`/settings` exports a versioned JSON bundle of profiles, subscription accounts, provider
accounts, and custom providers. Secrets are excluded unless you opt in. Import validates
every record before writing, merges custom providers first, and reports imported,
skipped, and errored counts per store.

## Security model

- All data lives under `~/.swisscode` (or `SWISSCODE_HOME`). Files that can hold secrets
  are written atomically with mode 0600 in 0700 directories.
- The proxy and the production web server bind `127.0.0.1` only, reject requests with a
  foreign `Host` or any `Origin`, and the proxy's control routes require a per-run token
  stored in `~/.swisscode/proxy-token`.
- Traffic records never contain headers or tokens. Display paths mask secrets by value.
- Every web server function validates its input before touching disk, the Keychain, or
  the network.
- swisscode uses Claude Code's own OAuth client and endpoints. Anthropic sees ordinary
  Claude Code traffic.

## FAQ

**Can I use two Claude Max accounts with Claude Code?**
Yes. Import both, then either `swisscode accounts use <id>` to switch the global login or
run the proxy and let it pick the account per request.

**Does the proxy get around Anthropic's rate limits?**
No. Each account keeps its own limits. The proxy moves you to another account you own
when one is exhausted, which is what you would do by hand with `/login`.

**Is swisscode a Claude Code router?**
Partly. It routes by account and by provider through profiles. It does not rewrite
prompts or split requests across models.

**Does it work with Cursor, Kilo, or OpenCode?**
v2.1 ships one agent plugin, Claude Code. Adding another is one adapter file plus one
registry line; see [Architecture](#architecture-and-contributing).

**Where are my keys?**
`~/.swisscode/accounts/<provider>/<id>.json` and `~/.swisscode/subscriptions/<id>.json`,
mode 0600. Nothing is uploaded anywhere.

**Windows?**
Untested. The Keychain path is macOS only; the credentials file path is used elsewhere.

## Coming from swisscode 0.6.x

v2 is a rewrite. Compared with the 0.6.x line on npm it adds the subscription proxy,
rate-limit failover, the traffic inspector, key-account storage, custom providers, the
backup format, and the web UI. It does not yet include per-directory bindings, the
`doctor` preflight, or the Kilo and OpenCode agents. Configuration is not migrated
automatically.

## Architecture and contributing

Hexagonal monorepo:

- `packages/core`: pure TypeScript, zero I/O. Domain types, ports, and
  `resolveLaunchSpec()`, the single function that turns a profile into
  `{ command, args, env }`.
- `packages/adapters`: everything that touches disk or network. Agent and provider
  plugins, the vault, OAuth, the proxy, traffic parsers, file stores.
- `apps/cli`: the `swisscode` binary. `apps/web`: TanStack Start UI with server-only data
  access.

A new agent or provider is one adapter file plus one line in
`packages/adapters/src/registry.ts`. See `CLAUDE.md` for the full map.

```sh
npm run build      # all workspaces
npm run test       # node:test, colocated *.test.ts
npm run typecheck
```

Storage and environment reference: `profiles.json`, `subscriptions/`, `accounts/`,
`custom-providers.json`, `proxy-token`, `proxy-traffic.jsonl`, `usage-cache.json`,
`model-catalog-cache.json` under `SWISSCODE_HOME`; `SWISSCODE_PROXY_PORT`,
`SWISSCODE_TRAFFIC_KEEP`, `SWISSCODE_TRAFFIC_BODY_BYTES`, `SWISSCODE_LOG_BODY_BYTES`,
`SWISSCODE_WEB_HOST`.

MIT licensed. Issues and pull requests welcome at
[github.com/jellologic/swisscode](https://github.com/jellologic/swisscode).
