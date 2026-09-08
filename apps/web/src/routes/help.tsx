import { createFileRoute } from "@tanstack/react-router";
import type { PluginHelp } from "@swisscode/core";
import {
  Badge,
  Card,
  Code,
  Disclosure,
  ExtLink,
  Muted,
  Notice,
  Page,
  Section,
  Stack,
  Steps,
} from "../design";
import { catalogFn } from "../lib/functions";

export const Route = createFileRoute("/help")({
  loader: async () => catalogFn(),
  component: HelpPage,
});

/** One plugin's help DNA, rendered verbatim. Adding a plugin documents it. */
function PluginCard(props: {
  kind: string;
  name: string;
  id: string;
  description: string;
  help?: PluginHelp;
}) {
  const help = props.help;
  return (
    <Card>
      <h2>
        {props.name} <Code>{props.id}</Code> <Badge tone="neutral">{props.kind}</Badge>
      </h2>
      <p>{help?.summary ?? props.description}</p>
      {help?.setup && help.setup.length > 0 && (
        <Steps items={help.setup} />
      )}
      {help?.commands && help.commands.length > 0 && (
        <p>
          {help.commands.map((c) => (
            <span key={c}><Code>{c}</Code> </span>
          ))}
        </p>
      )}
      {help?.links && help.links.length > 0 && (
        <p>
          {help.links.map((l) => (
            <span key={l.href}>
              <ExtLink href={l.href}>{l.label}</ExtLink>{" "}
            </span>
          ))}
        </p>
      )}
      {!help && (
        <p><Muted>No setup notes ship with this plugin yet.</Muted></p>
      )}
    </Card>
  );
}

function HelpPage() {
  const { agents, providers } = Route.useLoaderData();
  return (
    <Page
      title="Help"
      sub="How to use swisscode, from first launch to daily switching. Plugin sections below come from the adapters themselves."
    >
      <Stack>
        <Card>
          <h2>Quick start</h2>
          <Steps
            items={[
              <>Start the UI (this page) and open <Code>/accounts</Code>.</>,
              <>Import your Claude login, or add an OpenRouter account with an API key.</>,
              <>Create a profile on <Code>/profiles</Code> pairing an agent with a provider.</>,
              <>
                Launch it: <Code>swisscode {"<profileName>"}</Code>. Preview first
                with <Code>swisscode show {"<profileName>"}</Code>.
              </>,
            ]}
          />
        </Card>

        <Card>
          <h2>Daily use</h2>
          <Stack>
            <Disclosure summary="Switching Claude subscriptions">
              <Stack>
                <p>
                  <Muted>On /accounts, each stored subscription offers two switches:</Muted>
                </p>
                <p>
                  <Badge tone="info">Use via proxy</Badge> routes that account through the
                  local proxy (needs <Code>swisscode proxy run</Code>). Other Claude
                  sessions are untouched.
                </p>
                <p>
                  <Badge tone="neutral">Make system active</Badge> rewrites the shared
                  Claude Code login — every live session moves. You&apos;ll confirm first
                  when other sessions are running.
                </p>
              </Stack>
            </Disclosure>
            <Disclosure summary="Usage says “as of … — rate-limited”">
              The Anthropic usage endpoint throttles hard. swisscode caches the last good
              reading per account, backs off per Retry-After, and labels cached numbers
              with their age instead of refetching in a loop. Nothing is broken — wait
              a few minutes and it refreshes.
            </Disclosure>
            <Disclosure summary="Picking an OpenRouter model">
              The Default Model field searches the live catalog (cached 6h): filter by
              typing, click headers to sort by price, context, or release date. Opening{" "}
              <Code>Serving providers</Code> compares who serves the model and at what
              price — informational only, launches can&apos;t pin a provider.
            </Disclosure>
            <Disclosure summary="“Re-login needed” / “key rejected”">
              Subscription credentials expire or get revoked: log in again with Claude
              Code, then Re-import the account. Key providers: check the key at the
              provider&apos;s dashboard and update it via Edit (blank secrets are kept).
            </Disclosure>
          </Stack>
        </Card>

        <Section title="Agents">
          {agents.map((a) => (
            <PluginCard
              key={a.id}
              kind="agent"
              name={a.displayName}
              id={a.id}
              description={a.description}
              help={a.help}
            />
          ))}
        </Section>

        <Section title="Providers">
          {providers.map((p) => (
            <PluginCard
              key={p.id}
              kind="provider"
              name={p.displayName}
              id={p.id}
              description={p.description}
              help={p.help}
            />
          ))}
        </Section>
        <Notice tone="info">
          Plugin authors: help lives on the port (
          <Code>help: {"{ summary, setup, commands, links }"}</Code>). Fill it in and this
          page documents the plugin automatically.
        </Notice>
      </Stack>
    </Page>
  );
}
