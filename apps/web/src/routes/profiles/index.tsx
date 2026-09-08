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
  Pre,
  RowActions,
  Stack,
  Table,
} from "../../design";
import type { Column } from "../../design";
import { notify } from "../../design";
import {
  deleteProfileFn,
  listProfilesFn,
  previewProfileFn,
} from "../../lib/functions";

export const Route = createFileRoute("/profiles/")({
  loader: async () => ({
    stored: await listProfilesFn(),
  }),
  component: ProfilesPage,
});

function ProfilesPage() {
  const { stored } = Route.useLoaderData();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const columns: Column<(typeof stored.profiles)[number]>[] = [
    { header: "Name", render: (p) => <Code>{p.name}</Code> },
    { header: "Agent", render: (p) => <Muted>{p.agentId}</Muted> },
    { header: "Provider", render: (p) => <Muted>{p.providerId}</Muted> },
    {
      header: "Model",
      render: (p) => (p.model ? <Code>{p.model}</Code> : <Muted>—</Muted>),
    },
    {
      header: "Launch",
      render: (p) => <Code>swisscode {p.name}</Code>,
    },
    {
      header: "",
      render: (p) => (
        <RowActions>
          <Button size="sm" variant="ghost" to={`/profiles/${p.name}`}>
            Edit
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              const spec = await previewProfileFn({ data: { name: p.name } });
              setPreview(`$ ${spec.command} ${spec.args.join(" ")}\n${Object.entries(spec.env).map(([k, v]) => `${k}=${v}`).join("\n")}`);
            }}
          >
            Preview
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              setError(null);
              try {
                await deleteProfileFn({ data: { name: p.name } });
                notify.success(`Profile "${p.name}" deleted`);
                await router.invalidate();
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Delete
          </Button>
        </RowActions>
      ),
    },
  ];

  return (
    <Page
      title="Profiles"
      sub={<>A profile merges a coding agent with an AI provider. Store: <Code>{stored.storePath}</Code></>}
    >
      <Stack>
        {error && <Notice tone="danger">{error}</Notice>}
        <RowActions>
          <Button variant="primary" to="/profiles/new">New profile</Button>
        </RowActions>
        <Table
          columns={columns}
          rows={stored.profiles}
          getKey={(p) => p.name}
          empty={<Muted>No profiles yet — create one.</Muted>}
        />
        {preview && <Pre>{preview}</Pre>}
        {stored.profiles.length > 0 && (
          <p><Muted>Tip: <Badge tone="info">Proxy</Badge> profiles need <Code>swisscode proxy run</Code> up.</Muted></p>
        )}
      </Stack>
    </Page>
  );
}
