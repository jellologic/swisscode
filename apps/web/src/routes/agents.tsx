import { createFileRoute } from "@tanstack/react-router";
import { Card, Code, Muted, Page, Stack } from "../design";
import { catalogFn } from "../lib/functions";

export const Route = createFileRoute("/agents")({
  loader: async () => catalogFn(),
  component: AgentsPage,
});

function AgentsPage() {
  const { agents } = Route.useLoaderData();
  return (
    <Page title="Coding agents" sub="Agent plugins know how to launch a CLI with provider env vars.">
      <Stack>
        {agents.map((a) => (
          <Card key={a.id}>
            <h2>{a.displayName} <Code>{a.id}</Code></h2>
            <p>{a.description}</p>
            <p><Muted>Command: <Code>{a.command}{a.defaultArgs.length > 0 ? ` ${a.defaultArgs.join(" ")}` : ""}</Code></Muted></p>
          </Card>
        ))}
      </Stack>
    </Page>
  );
}
