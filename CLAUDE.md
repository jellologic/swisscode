# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What swisscode is

swisscode launches AI coding agents with the right env vars: a **profile** binds one
agent plugin to one provider plugin (`swisscode <profileName>` resolves
`Profile → LaunchSpec{command,args,env}` and spawns the agent binary). On top of that:

- **Subscription vault**: snapshot multiple `claude login` OAuth credentials, view 5h/7d
  usage, and switch between them per-profile — either by **file-swap** (rewrite Claude
  Code's own credential store) or transparently via the **proxy**.
- **Subscription proxy** (`swisscode proxy run`, default `http://127.0.0.1:8123`): a
  localhost Anthropic endpoint. Profiles with `useProxy:true` point
  `ANTHROPIC_BASE_URL` here and tag `ANTHROPIC_AUTH_TOKEN=swisscode-profile/<name>`;
  the proxy signs each request with a vault token, fails over to the next account on
  429/529, refreshes once and retries on 401, and records redacted traffic for the
  `/proxy` inspection UI (request/response summaries, conversation threads, token usage).
- **Key-based provider accounts** (OpenRouter today): store API keys once, reference
  from profiles; live usage, model catalog + per-model serving endpoints, pre-save
  connection test.
- **Custom providers** (user-defined, data-only): env mapping + declarative test
  endpoint, flowing through accounts/profiles/launch/`/help` like built-ins.
- **Backup/restore**: versioned JSON bundle over the four config stores.

## Commands

```bash
npm install
npm run build --workspaces --if-present
npm run test --workspaces --if-present
npm run typecheck --workspaces --if-present
```

- `packages/core`: tests are colocated `*.test.ts`, compiled then run with node:test —
  `test` = `tsc -p tsconfig.json && node --test dist`. Single test:
  `cd packages/core && npx tsc -p tsconfig.json && node --test dist/service.test.js`.
- `packages/adapters`: `test` = `tsc -p tsconfig.json && node --test "dist/**/*.test.js"`.
  Single test e.g. `node --test dist/proxy/trafficSummary.test.js` (after `tsc`).
- `apps/cli`: no tests. Build with `tsc -p tsconfig.json`; run
  `node apps/cli/dist/index.js list` or `... <profile> --dry-run`.
- `apps/web` (TanStack Start + Vite): `cd apps/web && npm run dev` (port 3000;
  `src/routeTree.gen.ts` generates on first dev/build), `npm start` serves a prod build.
  `typecheck` only, no tests.

## Architecture (hexagonal: core owns ports, adapters implement)

- `packages/core` — pure TS, zero I/O. `domain.ts` (Profile, LaunchSpec, FieldDef,
  PluginHelp), `ports.ts` (AgentPort, ProviderPort, ProfileRepository,
  ProviderAccountRepository, ProviderUsageReader, ProviderAccountValidator,
  ProviderModelCatalog), `service.ts` — `resolveLaunchSpec()` is the single
  env-resolution choke point used by BOTH CLI and web UI; `resolveProviderConfig()`
  merges a stored key-account under inline `providerConfig` (inline wins);
  `validateProfile` rejects `useProxy:true` without `subscriptionAccountId` at save
  time. `subscriptions.ts`/`subscriptionPorts.ts`/`subscriptionService.ts`: vault +
  OAuth + usage types; `ensureFreshCredential()` (5-min expiry buffer) refreshes and
  persists, with an `onInvalidGrant` hook to adopt a rotated lineage.
  `traffic.ts`: the `TrafficParser` port (per-provider wire-format reading) plus
  request/response summary shapes. `customProviders.ts`: `CustomProviderDef` +
  strict validator (id/field/env/test-URL rules). `configBundle.ts`: `CONFIG_BUNDLE_VERSION=1`,
  `BUNDLE_STORE_KEYS=[profiles, subscriptionAccounts, providerAccounts, customProviders]`
  (caches excluded — they reseed).
- `packages/adapters` — all I/O. `agents/claudeCode.ts` (sole agent: `command:"claude"`;
  `buildLaunch` only adds `ANTHROPIC_MODEL` via `??=` when the profile sets `model`).
  Providers: `claudeSubscription` (`fields:[]`, `buildEnv:{}` — inherits ambient login;
  owns the only built-in `trafficParser`), `openRouter` (`OPENROUTER_BASE_URL`,
  always sets `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL` =
  profile-model-first fallback to account default), `customProviderPort(def)` (static
  env + `envFromConfig` mapping with empty values skipped + model var; capabilities
  stay off). `registry.ts`: `defaultAgents/defaultProviders/create*Registry/
  defaultTrafficParsers` — **new agent/provider = one adapter file + one line here**.
  `subscriptions/`: `accountVault` (0600 per-account JSON), `activeStore`
  (reads Keychain `Claude Code-credentials` first, `~/.claude/.credentials.json`
  second; read-merge-write preserving foreign keys; reuse Keychain account name),
  `anthropic` (`OAUTH_CLIENT_ID`, token/usage/profile hosts, `oauth-2025-04-20` beta;
  `OAuthError{invalid_grant,no_refresh_token,transient}`, `UsageError` with
  Retry-After), `identity` (sha256-of-refreshToken duplicate detection),
  `liveResync` (adopt Claude Code's live lineage when the vault copy rotated),
  `usageCache` (stale-while-revalidated with 429 backoff). `proxy/server.ts`:
  `SubscriptionProxy` (binds 127.0.0.1; control routes under `/__swisscode/`;
  strips client auth/hop headers; per-request bearer swap; traffic ring buffer +
  redacted JSONL via `onTraffic`). `proxy/trafficSummary.ts` + `sessionContext.ts`:
  provider-composed summaries, union-find conversation grouping, local
  `~/.claude` transcript reads. `store/`: file repositories + `configBundle`
  (customs-first import order).
- `apps/cli` — thin shell over core (`index.ts` launch/list/show,
  `accounts.ts` subscription vault, `providerAccounts.ts` generic accounts,
  `proxy.ts` run/use/status/log). Launch: resolve stored key-account → bind
  subscription (proxy `use` or file-swap `activateAccount`, skipped on `--dry-run`)
  → `resolveLaunchSpec` → proxy-mode env rewrite → `spawn` with inherited stdio.
  File-swap warns when other `claude` processes run (`pgrep -x claude`, `--force`
  overrides).
- `apps/web` — TanStack Start. `lib/store.server.ts` is server-only (`.server.`
  suffix keeps fs/keys out of the client); `lib/functions.ts` thin
  `createServerFn` wrappers; routes under `src/routes/` (`/`, `/profiles`,
  `/accounts`, `/providers`, `/agents`, `/proxy`, `/proxy/$threadId`, `/settings`,
  `/help`). Design system in `src/design/` (`Page/Topbar/Card/controls/combobox/
  data/toast`, `sw-*` classes). Model catalog pickers appear on account add/edit
  (`ModelPicker.tsx`); `ProfileForm` model override is a plain input.

## Data, env, and secrets

All paths root at `SWISSCODE_HOME` or `~/.swisscode`: `profiles.json`,
`subscriptions/<id>.json` (0600, dir 0700), `accounts/<provider>/<id>.json` (0600),
`custom-providers.json` (0600), `proxy-token` (0600), `proxy-traffic.jsonl`, `usage-cache.json`,
`model-catalog-cache.json` (6h TTL). Net: `SWISSCODE_PROXY_PORT` (else 8123);
`SWISSCODE_TRAFFIC_KEEP` (default 200, 0 disables), `SWISSCODE_TRAFFIC_BODY_BYTES`
(default 64 KiB, 0 = unlimited), `SWISSCODE_LOG_BODY_BYTES` (default 8192). Display masking:
CLI/web use core `redactEnv` (masks by secret *value* plus `/TOKEN|KEY|SECRET|PASS|CRED|AUTH/` names, never `swisscode-profile/` tags);
`maskSecret` shows `first4…last2`; traffic entries never carry headers/tokens.
Proxy control routes (`/__swisscode/*`) require the `x-swisscode-token` header
matching the per-run token in `proxy-token`.
Account validation never throws — failure is `AccountValidation{ok:false}` data.
