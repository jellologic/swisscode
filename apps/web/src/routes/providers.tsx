import { createFileRoute } from "@tanstack/react-router";
import { catalogFn } from "../lib/functions";

export const Route = createFileRoute("/providers")({
  loader: async () => catalogFn(),
  component: ProvidersPage,
});

function ProvidersPage() {
  const { providers } = Route.useLoaderData();
  return (
    <section>
      <h1>AI providers</h1>
      <p className="muted">Provider plugins turn stored config into env vars for the agent.</p>
      {providers.map((p) => (
        <article key={p.id} className="card">
          <h2>{p.displayName} <code>{p.id}</code></h2>
          <p>{p.description}</p>
          {p.fields.length === 0 ? (
            <p className="muted">No configuration needed.</p>
          ) : (
            <ul>
              {p.fields.map((f) => (
                <li key={f.key}>
                  <code>{f.key}</code> — {f.label}
                  {f.required ? " (required)" : " (optional)"}
                  {f.secret ? " [secret]" : ""}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}
