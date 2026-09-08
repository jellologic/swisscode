import { createFileRoute } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Card,
  Code,
  Disclosure,
  Grid2,
  Muted,
  Page,
  RowActions,
  Stack,
} from "../design";
import {
  catalogFn,
  listAccountsFn,
  listProfilesFn,
  listProviderAccountsFn,
  proxyStateFn,
} from "../lib/functions";

export const Route = createFileRoute("/")({
  loader: async () => ({
    catalog: await catalogFn(),
    profiles: await listProfilesFn(),
    subs: await listAccountsFn(),
    generic: await listProviderAccountsFn({ data: {} }),
    proxy: await proxyStateFn(),
  }),
  component: HomePage,
});

function Stat(props: { label: string; children: React.ReactNode }) {
  return (
    <Card>
      <h2>{props.children}</h2>
      <p><Muted>{props.label}</Muted></p>
    </Card>
  );
}

function HomePage() {
  const { catalog, profiles, subs, generic, proxy } = Route.useLoaderData();
  const keyAccounts = generic.accounts.length;

  return (
    <Page
      title="swisscode"
      sub="Launch coding agents with the right provider, account, and model — every time."
    >
      <Stack>
        <Grid2>
          <Stat label="Profiles (launchable)">{profiles.profiles.length}</Stat>
          <Stat label="Stored accounts">
            {subs.accounts.length + keyAccounts}{" "}
            <Muted>
              ({subs.accounts.length} subscription · {keyAccounts} key)
            </Muted>
          </Stat>
        </Grid2>
        <Grid2>
          <Stat label="Plugins">
            {catalog.agents.length + catalog.providers.length}{" "}
            <Muted>
              ({catalog.agents.length} agent · {catalog.providers.length} providers)
            </Muted>
          </Stat>
          <Stat label="Proxy">
            {proxy.running ? (
              <>running <Muted>:{proxy.port}</Muted></>
            ) : (
              <Muted>not running</Muted>
            )}
          </Stat>
        </Grid2>

        <Card>
          <h2>Get going</h2>
          <Stack>
            <p>
              <Muted>1.</Muted> Add an account on <Code>/accounts</Code> — import a Claude
              login or store an OpenRouter key.
            </p>
            <p>
              <Muted>2.</Muted> Create a profile on <Code>/profiles</Code> pairing a
              coding agent with a provider.
            </p>
            <p>
              <Muted>3.</Muted> Launch it: <Code>swisscode {"<profileName>"}</Code>
            </p>
            <RowActions>
              <Button variant="primary" to="/profiles">Manage profiles</Button>
              <Button to="/accounts">Manage accounts</Button>
              <Button variant="ghost" to="/help">How to use</Button>
            </RowActions>
          </Stack>
        </Card>

        <Card>
          <h2>How it works</h2>
          <Stack>
            <Disclosure summary="Profiles merge an agent with a provider">
              A profile names a coding agent (e.g. claude-code), an AI provider, and
              optional overrides (model, account, proxy). <Code>swisscode {"<name>"}</Code> resolves
              it to a command plus env vars and runs it. <Code>swisscode show {"<name>"}</Code> previews
              the launch with secrets redacted.
            </Disclosure>
            <Disclosure summary="Accounts hold secrets; profiles reference them">
              Subscription logins are snapshotted from Claude Code&apos;s own store;
              key providers (OpenRouter) store API keys in <Code>~/.swisscode</Code> with
              0600 files. Secrets never leave the server side — the UI only sees masks.
            </Disclosure>
            <Disclosure summary="Two ways to switch subscriptions">
              <Badge tone="info">Proxy</Badge> routes traffic through a local server that
              swaps credentials per request — other sessions keep working. File-swap
              rewrites the shared Claude Code login, moving every session at once
              (you&apos;ll be asked to confirm when other sessions are live).
            </Disclosure>
            <Disclosure summary="Usage and models are cached">
              The Anthropic usage endpoint rate-limits aggressively, so readings are
              cached and labeled <Code>as of … — rate-limited</Code> when stale instead
              of hammering the API. The OpenRouter model list refreshes every 6 hours;
              per-model serving providers are cached the same way.
            </Disclosure>
          </Stack>
        </Card>

        {profiles.profiles.length > 0 && !proxy.running && (
          <p>
            <Muted>
              Tip: proxy profiles need <Code>swisscode proxy run</Code> up — see{" "}
              <Code>/help</Code>.
            </Muted>
          </p>
        )}
      </Stack>
    </Page>
  );
}
