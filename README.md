# swisscode

Customize AI coding clients: add models and AI providers, bundle them into
profiles, and launch a coding agent with the right env vars.

```
swisscode <profileName>
```

## Layout (hexagonal)

- `packages/core` — domain + ports. Pure TS, zero I/O.
  Entities (`Profile`, `LaunchSpec`), plugin ports (`AgentPort`,
  `ProviderPort`), persistence port (`ProfileRepository`), and the single
  orchestration choke point `resolveLaunchSpec()` used by both UI and CLI.
- `packages/adapters` — port implementations. Agents: `claude-code`.
  Providers: `claude-subscription` (uses your `claude login`, no env),
  `openrouter` (maps to `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/
  `ANTHROPIC_MODEL`). Storage: JSON file at `~/.swisscode/profiles.json`
  (override with `SWISSCODE_HOME`).
- `apps/web` — TanStack Start UI. Manage agents (read-only catalog),
  providers (field schemas), and profiles (create/delete/preview).
- `apps/cli` — `swisscode` binary. Resolves a profile and spawns the agent.

## Quick start

```bash
npm install
npm run build --workspaces --if-present

# UI (`src/routeTree.gen.ts` is generated on first dev/build)
cd apps/web && npm run dev        # http://localhost:3000
npm start                         # serve a production build instead

# CLI (profiles created in the UI live in ~/.swisscode/profiles.json)
node apps/cli/dist/index.js list
node apps/cli/dist/index.js myprofile --dry-run
node apps/cli/dist/index.js myprofile
```

## Subscription accounts (Claude Code logins)

Store multiple Claude subscriptions, see 5h/7d limits, and switch between them:

```bash
swisscode accounts import personal     # snapshots the current `claude login`
swisscode accounts list
swisscode accounts usage                # live utilization per account
swisscode accounts use personal         # file-swap switch (warns if other
                                        # `claude` sessions are running)
```

A profile with `subscriptionAccountId` switches at launch (`swisscode <profile>`).
Vault files live in `~/.swisscode/subscriptions/` (mode 0600). Import reads
Claude Code's own store: macOS Keychain (`Claude Code-credentials`) first,
`~/.claude/.credentials.json` second — whichever holds OAuth creds wins, which
is the precedence a fresh `claude` process honors (verified live).

Switching is faithful to `/login`: same item/service (Keychain account name is
reused — a wrong `-a` would silently create a duplicate the client never reads),
read-merge-write preserving every key we don't own (`mcpOAuth`, `rateLimitTier`,
`subscriptionType`, ...), 0600 file mode with atomic rename, and a post-write
re-read that aborts on mismatch. `~/.claude.json` (`oauthAccount`) is left alone —
Claude Code re-derives that cache itself, same as with cswap. On macOS, restart
running `claude` sessions to pick up a swap immediately (Keychain reads are cached).

## Proxy (transparent switching)

Instead of swapping the shared credential file, route Claude Code through a
localhost proxy that swaps the bearer token per request:

```bash
swisscode proxy run                     # :8123 (SWISSCODE_PROXY_PORT to change)
swisscode proxy use personal
swisscode proxy status
```

Profiles with `"useProxy": true` set `ANTHROPIC_BASE_URL` to the proxy and
select the account there — the client never knows a switch happened. On 429/529
the proxy fails over to the next stored account; on 401 it refreshes once and
retries. Existing `claude` sessions are untouched (only new launches route
through the proxy).

## Adding a plugin

New agent or provider = one adapter file in `packages/adapters/src` plus one
line in `packages/adapters/src/registry.ts`. Core, UI catalog, and CLI pick
it up with no other changes.
