import { createFileRoute } from "@tanstack/react-router";
import { catalogFn } from "../lib/functions";

export const Route = createFileRoute("/agents")({
  loader: async () => catalogFn(),
  component: AgentsPage,
});

function AgentsPage() {
  const { agents } = Route.useLoaderData();
  return (
    <section>
      <h1>Coding agents</h1>
      <p className="muted">Agent plugins know how to launch a CLI with provider env vars.</p>
      {agents.map((a) => (
        <article key={a.id} className="card">
          <h2>{a.displayName} <code>{a.id}</code></h2>
          <p>{a.description}</p>
          <p className="muted">Command: <code>{a.command} {a.defaultArgs.join(" ")}</code></p>
        </article>
      ))}
    </section>
  );
}
