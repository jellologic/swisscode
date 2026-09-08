# swisscode

Customize AI coding clients: add models and AI providers, bundle them into
profiles, and launch a coding agent with the right env vars.

```
swisscode <profileName>
```

A **profile** binds one agent plugin (today: Claude Code) to one provider plugin
(Claude subscription, OpenRouter, or a user-defined custom provider) plus a model
and config. Both the CLI and the web UI resolve profiles through the same core
function, so launches never drift between the two.

## Quick start

```bash
npm install
npm run build --workspaces --if-present

# UI (`src/routeTree.gen.ts` is generated on first dev/build)
cd apps/web && npm run dev        # http://localhost:3000
npm start                         # serve a production build instead

# CLI (profiles created in the UI live in ~/.swisscode/profiles.json)
node apps/cli/dist/index.js list
node apps/cli/dist/index.js myprofile --dry-run   # print command + redacted env
node apps/cli/dist/index.js myprofile             # launch
node apps/cli/dist/index.js myprofile -- args...  # extra args after --
```

## Profiles

A profile is `{ name, agentId, agentArgs?, providerId, providerConfig?, model?,
subscriptionAccountId?, useProxy?, providerAccountId? }`:

- `providerConfig` holds inline provider fields (e.g. OpenRouter `apiKey`).
  `providerAccountId` references a stored key-account instead; stored config merges
  *under* inline values (inline wins).
- `model` overrides the provider's default model for this profile.
- `subscriptionAccountId` (claude-subscription only) switches to that stored login
  at launch. Omitted = use whatever Claude Code is currently logged in as.
- `useProxy: true` (requires `subscriptionAccountId`) routes through
  `swisscode proxy` instead of swapping the shared credential file.

`swisscode list` / `swisscode show <profile>` inspect profiles;
`--dry-run` prints the resolved `{command, args, env}` (secrets redacted) without
touching credentials or spawning anything.

## Web UI

| Page | What it does |
| --- | --- |
| `/` | Dashboard: profile/account/plugin counts, proxy status, getting-started guide |
| `/profiles` | Create/edit/preview/delete profiles (preview shows command + env) |
| `/accounts` | Subscription vault + key-based accounts, live usage, switch actions |
| `/providers` | Built-in catalog plus custom-provider create/edit |
| `/agents` | Agent catalog (read-only) |
| `/proxy` | Live request threads through the proxy, grouped into conversations |
| `/proxy/<thread>` | Turn-by-turn timeline: verdict, reply, tool calls, token usage |
| `/settings` | Backup export / import (with or without secrets) |
| `/help` | Quick start plus per-plugin setup docs (plugins document themselves) |

## Subscription accounts (Claude Code logins)

Store multiple Claude subscriptions, see 5h/7d limits, and switch between them:

```bash
swisscode accounts current               # show the active `claude` login
swisscode accounts import <id> [--label <label>] [--force]
swisscode accounts list
swisscode accounts usage [id]            # live utilization per account
swisscode accounts use <id> [--force]    # file-swap switch (warns if other
                                         # `claude` sessions are running)
swisscode accounts remove <id>
```

A profile with `subscriptionAccountId` switches at launch (`swisscode <profile>`).
Vault files live in `~/.swisscode/subscriptions/` (mode 0600). Import snapshots
Claude Code's own store read-only: macOS Keychain (`Claude Code-credentials`)
first, `~/.claude/.credentials.json` second — whichever holds OAuth creds wins,
which is the precedence a fresh `claude` process honors (verified live).

Switching is faithful to `/login`: same item/service (Keychain account name is
reused — a wrong `-a` would silently create a duplicate the client never reads),
read-merge-write preserving every key we don't own (`mcpOAuth`, `rateLimitTier`,
`subscriptionType`, ...), 0600 file mode with atomic rename, and a post-write
re-read that aborts on mismatch. `~/.claude.json` (`oauthAccount`) is left alone —
Claude Code re-derives that cache itself, same as with cswap. On macOS, restart
running `claude` sessions to pick up a swap immediately (Keychain reads are cached).

Expired vault tokens refresh automatically (5-minute buffer) and persist back to
the vault. If Claude Code itself rotated the refresh lineage elsewhere, swisscode
adopts the live credential instead of retrying a dead one.

## Proxy (transparent switching + traffic inspection)

Instead of swapping the shared credential file, route Claude Code through a
localhost proxy that swaps the bearer token per request:

```bash
swisscode proxy run                     # :8123 (SWISSCODE_PROXY_PORT to change)
swisscode proxy use <id>                # switch the proxy's active account
swisscode proxy status
swisscode proxy log [--tail <n>]        # recent proxied requests
```

`run` flags: `--port <n>`, `--traffic-log <path>` / `--no-traffic-log`
(default `~/.swisscode/proxy-traffic.jsonl`, redacted JSONL), `--log-bodies`,
`--traffic-keep <n>` (memory ring, default 200, 0 disables),
`--traffic-body-bytes <n>` / `--log-body-bytes <n>` (caps, 0 = unlimited).

Profiles with `"useProxy": true` set `ANTHROPIC_BASE_URL` to the proxy and put a
`swisscode-profile/<name>` tag in `ANTHROPIC_AUTH_TOKEN` — an attribution marker,
not a credential; the proxy reads it, then signs upstream with the vault token.
On 429/529 the proxy fails over to the next stored account; on 401 it refreshes
once and retries. Existing `claude` sessions are untouched (only new launches
route through the proxy).

Every proxied request is captured (never headers/tokens) and explained per
provider: request/response summaries, plain-English verdicts, cache-aware token
lines, tool-call decoding, and conversation threading that links follow-ups,
safety screens, and subagent launches. Browse it at `/proxy` in the UI.

## Provider accounts (API keys)

Key-based providers (OpenRouter today) store credentials once and reference them
from profiles:

```bash
swisscode accounts --provider openrouter add <id> --set apiKey=sk-or-... [--label <l>]
swisscode accounts --provider openrouter update <id> [--set key=value ...]
swisscode accounts --provider openrouter list | show <id>   # masked
swisscode accounts --provider openrouter usage [id]
swisscode accounts --provider openrouter models             # published model list
swisscode accounts --provider openrouter model <id>         # detail + serving providers
swisscode accounts --provider openrouter test --set apiKey=...  # check without saving
swisscode accounts --provider openrouter remove <id>
```

`show`/`list` mask secrets (`first4…last2`); `update` only changes sent keys.

## Custom providers

Providers that speak an Anthropic-compatible endpoint need no code: define one in
the UI at `/providers/new` — id, display name, config fields, static env
(`ANTHROPIC_BASE_URL=…`), env-from-config mapping, model env var, and an optional
HTTPS test endpoint for pre-save credential checks. Custom providers immediately
work in accounts, profiles, launches, and `/help` like built-ins. They intentionally
expose no usage reader, model catalog, or login import — env mapping only.

## Backup / restore

`/settings` exports a versioned JSON bundle over profiles, subscription accounts,
provider accounts, and custom providers — with or without secrets (without means
keys/logins must be re-entered after restore). Import merges customs-first with an
overwrite toggle and per-store imported/skipped/error counts. Usage and
model-catalog caches are excluded; they reseed from the network.

## Architecture (hexagonal)

- `packages/core` — domain + ports. Pure TS, zero I/O.
  Entities (`Profile`, `LaunchSpec`), plugin ports (`AgentPort`,
  `ProviderPort`), persistence ports, and the single orchestration choke point
  `resolveLaunchSpec()` used by both UI and CLI.
- `packages/adapters` — port implementations. Agents: `claude-code`.
  Providers: `claude-subscription` (uses your `claude login`, no env),
  `openrouter` (maps to `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/
  `ANTHROPIC_MODEL`), plus stored custom providers. Storage: JSON under
  `~/.swisscode/` (override with `SWISSCODE_HOME`).
- `apps/web` — TanStack Start UI (server-only data access via `.server.`
  modules; all domain logic delegates to core).
- `apps/cli` — `swisscode` binary. Resolves a profile and spawns the agent.

### Adding a plugin

New agent or provider = one adapter file in `packages/adapters/src` plus one
line in `packages/adapters/src/registry.ts`. Core, UI catalog, and CLI pick
it up with no other changes. Each provider owns its wire-format knowledge via an
optional `trafficParser` (request parsing, response summaries, conversation
keys) — the proxy and inspection UI only touch that interface, so unmatched
traffic falls back to a shape-only summary.

## Reference

Storage roots at `SWISSCODE_HOME` (default `~/.swisscode`): `profiles.json`,
`subscriptions/`, `accounts/`, `custom-providers.json`, `proxy-traffic.jsonl`,
`usage-cache.json`, `model-catalog-cache.json`. Proxy: `SWISSCODE_PROXY_PORT`
(default 8123), `SWISSCODE_TRAFFIC_KEEP`, `SWISSCODE_TRAFFIC_BODY_BYTES`,
`SWISSCODE_LOG_BODY_BYTES`.

Dev commands: `npm run build|test|typecheck --workspaces --if-present` from the
root; per-package `test` compiles `*.test.ts` and runs node:test
(`node --test dist/...` for a single file after `tsc`).
