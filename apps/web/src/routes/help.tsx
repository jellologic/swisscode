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
              <>Create a profile on <Code>/profiles</Code> pairing an agent with a provider —
                or start from a preset (<Code>swisscode init</Code>, or “Start from…” on{" "}
                <Code>/profiles/new</Code>).</>,
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
            <Disclosure summary="Routed profiles (model routes)">
              <Stack>
                <p>
                  A profile can send different models to different backends inside
                  one session. Matching is exact on the requested model id and{" "}
                  <strong>first row wins</strong> — put specific models above
                  general ones.
                </p>
                <p>
                  Each row picks a destination (a vault subscription account or a
                  key account) and optionally an <Code>upstreamModel</Code>{" "}
                  rewrite. The sentence under the row says what happens:{" "}
                  <Muted>
                    “Requests for `opus` → Work vault account, sent as
                    `anthropic/claude-opus-4`”.
                  </Muted>{" "}
                  Models with no row use the profile&apos;s default route.
                </p>
                <p>
                  Routes need the proxy: saving <Code>direct: true</Code> with
                  routes is an error, and launching a routed profile while{" "}
                  <Code>swisscode proxy run</Code> is down fails closed instead of
                  billing the wrong upstream. Preview the sentences with{" "}
                  <Code>swisscode show {"<profile>"}</Code> or the form&apos;s
                  Preview button.
                </p>
              </Stack>
            </Disclosure>
            <Disclosure summary="Spend estimates and route suggestions">
              <Stack>
                <p>
                  <Code>swisscode proxy report</Code>,{" "}
                  <Code>swisscode show {"<profile>"}</Code>, and the stored
                  history on <Code>/proxy</Code> estimate spend from a static
                  per-model price table, with read-only suggestions next to
                  the figures (“Opus burned $X”, “this route saw no traffic”).
                  Estimated spend, not a bill — subscriptions don&apos;t meter
                  per token, and unpriceable usage is counted, never hidden.
                </p>
              </Stack>
            </Disclosure>
            <Disclosure summary="Profile session knobs (cheat-sheet)">
              <Stack>
                <p>
                  <Muted>
                    Everything here is optional and emits flags plus an ephemeral{" "}
                    <Code>--settings</Code> file — your own settings files are
                    never rewritten. Precedence: Extra agent args win over the
                    curated fields, which win over Advanced JSON on conflict.
                  </Muted>
                </p>
                <p>
                  <strong>Model & reasoning</strong> — effort trades speed and
                  cost for depth (<Code>low</Code> fastest … <Code>max</Code>{" "}
                  deepest); fallback models are a settings-level chain that
                  applies generally.
                </p>
                <p>
                  <strong>Permissions</strong> — <Code>plan</Code> proposes first
                  and runs after approval; <Code>acceptEdits</Code> runs edits
                  and asks for the rest; <Code>auto</Code> accepts safe tools;{" "}
                  <Code>manual</Code> asks every time; <Code>dontAsk</Code>{" "}
                  denies silently; <Code>bypassPermissions</Code> skips checks
                  (sandbox only).
                </p>
                <p>
                  <strong>System prompt</strong> — replacing it disables
                  per-conversation recording optimizations; prefer Append.
                  A prompt preset (reviewer/planner/explainer) copies a starter
                  snippet into Append — the text launches, the preset is only
                  provenance, so editing afterwards keeps working. Settings{" "}
                  <Code>env</Code> beats the shell environment inside
                  Claude Code.
                </p>
                <p>
                  <strong>Isolation</strong> — uncheck a setting source
                  (user/project/local) to hide that layer from the profile.
                  Managed (org-policy) settings still beat <Code>--settings</Code>{" "}
                  — org policy wins, always.
                </p>
                <p>
                  <strong>Settings env vs launch env</strong> — Advanced JSON{" "}
                  <Code>{"{ \"env\": { \"FOO\": \"bar\" } }"}</Code> beats the
                  shell environment <em>inside</em> Claude Code and reaches its
                  subprocesses; the provider env on the launch (keys, base URL)
                  never enters that object. Both sides strip code-loading names
                  (<Code>PATH</Code>, <Code>NODE_OPTIONS</Code>,{" "}
                  <Code>LD_*</Code>/<Code>DYLD_*</Code>) — a stored profile can
                  never smuggle those into the agent.
                </p>
              </Stack>
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
