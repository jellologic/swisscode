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

## Adding a plugin

New agent or provider = one adapter file in `packages/adapters/src` plus one
line in `packages/adapters/src/registry.ts`. Core, UI catalog, and CLI pick
it up with no other changes.
