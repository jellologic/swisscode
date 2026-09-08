import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Card,
  Code,
  Muted,
  Notice,
  Page,
  RowActions,
  Stack,
} from "../../design";
import { notify } from "../../design";
import { catalogFn, removeCustomProviderFn } from "../../lib/functions";

export const Route = createFileRoute("/providers/")({
  loader: async () => catalogFn(),
  component: ProvidersPage,
});

function ProvidersPage() {
  const { providers } = Route.useLoaderData();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const builtins = providers.filter((p) => p.builtin);
  const customs = providers.filter((p) => !p.builtin);

  return (
    <Page title="AI providers" sub="Built-ins ship with swisscode. Customs you define here work everywhere built-ins do.">
      <Stack>
        {builtins.map((p) => (
          <Card key={p.id}>
            <h2>
              {p.displayName} <Code>{p.id}</Code> <Badge tone="neutral">built-in</Badge>{" "}
              {p.accountCapabilities.importActive && <Badge tone="info">importable login</Badge>}{" "}
              {p.accountCapabilities.usageMetrics && <Badge tone="success">usage</Badge>}{" "}
              {p.accountCapabilities.modelCatalog && <Badge tone="info">model catalog</Badge>}{" "}
              {p.accountCapabilities.switchVia.includes("proxy") && <Badge tone="neutral">proxy</Badge>}
            </h2>
            <p>{p.description}</p>
            {p.accountCapabilities.hint && <p><Muted>{p.accountCapabilities.hint}</Muted></p>}
            {p.fields.length === 0 ? (
              <p><Muted>No configuration needed.</Muted></p>
            ) : (
              <ul>
                {p.fields.map((f) => (
                  <li key={f.key}>
                    <Code>{f.key}</Code> — {f.label}
                    {f.required ? " (required)" : " (optional)"}
                    {f.secret ? " [secret]" : ""}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}

        {customs.map((p) => (
          <Card key={p.id}>
            <h2>
              {p.displayName} <Code>{p.id}</Code> <Badge tone="info">custom</Badge>
            </h2>
            <p>{p.description || <Muted>No description.</Muted>}</p>
            {p.accountCapabilities.hint && <p><Muted>{p.accountCapabilities.hint}</Muted></p>}
            <RowActions>
              <Button size="sm" variant="ghost" to={`/providers/${p.id}`}>Edit</Button>
              <Button
                size="sm"
                variant="danger"
                onClick={async () => {
                  setError(null);
                  try {
                    await removeCustomProviderFn({ data: { id: p.id } });
                    notify.success(`Provider "${p.id}" deleted`);
                    await router.invalidate();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  }
                }}
              >
                Delete
              </Button>
            </RowActions>
          </Card>
        ))}
        {error && <Notice tone="danger">{error}</Notice>}

        <RowActions>
          <Button variant="primary" to="/providers/new">Add custom provider</Button>
        </RowActions>
      </Stack>
    </Page>
  );
}
