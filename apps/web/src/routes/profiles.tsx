import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { Profile } from "@swisscode/core";
import {
  Badge,
  Button,
  Card,
  Check,
  Code,
  Field,
  Form,
  Grid2,
  Input,
  Muted,
  Notice,
  Page,
  Pre,
  RowActions,
  Select,
  Stack,
  Table,
} from "../design";
import type { Column } from "../design";
import {
  catalogFn,
  deleteProfileFn,
  listAccountsFn,
  listProfilesFn,
  listProviderAccountsFn,
  previewProfileFn,
  saveProfileFn,
} from "../lib/functions";

export const Route = createFileRoute("/profiles")({
  loader: async () => ({
    catalog: await catalogFn(),
    stored: await listProfilesFn(),
    accounts: await listAccountsFn(),
    providerAccounts: await listProviderAccountsFn({ data: {} }),
  }),
  component: ProfilesPage,
});

const emptyForm = {
  name: "",
  agentId: "claude-code",
  providerId: "openrouter",
  model: "",
  apiKey: "",
  providerModel: "",
  agentArgs: "",
  subscriptionAccountId: "",
  useProxy: false,
  providerAccountId: "",
};

function ProfilesPage() {
  const { catalog, stored, accounts, providerAccounts } = Route.useLoaderData();
  const router = useRouter();
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const provider = catalog.providers.find((p) => p.id === form.providerId);
  const set = (key: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const storedForProvider = providerAccounts.accounts.filter((a) => a.providerId === form.providerId);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const profile: Profile = {
      name: form.name.trim(),
      agentId: form.agentId,
      providerId: form.providerId,
      model: form.model.trim() || undefined,
      agentArgs: form.agentArgs.split(/\s+/).filter(Boolean),
      providerConfig: {
        ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
        ...(form.providerModel.trim() ? { model: form.providerModel.trim() } : {}),
      },
      ...(form.providerId === "claude-subscription" && form.subscriptionAccountId
        ? { subscriptionAccountId: form.subscriptionAccountId }
        : {}),
      ...(form.providerId === "claude-subscription" && form.subscriptionAccountId && form.useProxy
        ? { useProxy: true as const }
        : {}),
      ...(form.providerId !== "claude-subscription" && form.providerAccountId
        ? { providerAccountId: form.providerAccountId }
        : {}),
    };
    try {
      await saveProfileFn({ data: profile });
      setForm(emptyForm);
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

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
              await deleteProfileFn({ data: { name: p.name } });
              await router.invalidate();
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
      <Grid2>
        <Stack>
          <Table
            columns={columns}
            rows={stored.profiles}
            getKey={(p) => p.name}
            empty={<Muted>No profiles yet — create one.</Muted>}
          />
          {preview && <Pre>{preview}</Pre>}
        </Stack>

        <Card>
          <h2>New profile</h2>
          {error && <Notice tone="danger">{error}</Notice>}
          <Form onSubmit={onSave}>
            <Field label="Profile name">
              <Input value={form.name} onChange={set("name")} placeholder="work" required />
            </Field>
            <Field label="Coding agent">
              <Select value={form.agentId} onChange={set("agentId")}>
                {catalog.agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.displayName}</option>
                ))}
              </Select>
            </Field>
            <Field label="AI provider">
              <Select
                value={form.providerId}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    providerId: e.target.value,
                    providerAccountId: "",
                    subscriptionAccountId: "",
                    useProxy: false,
                  }))
                }
              >
                {catalog.providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName}</option>
                ))}
              </Select>
            </Field>
            {form.providerId === "claude-subscription" && (
              <Field label="Subscription account" hint="Blank uses the current login.">
                <Select value={form.subscriptionAccountId} onChange={set("subscriptionAccountId")}>
                  <option value="">Current Claude Code login</option>
                  {accounts.accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.label} ({a.id})</option>
                  ))}
                </Select>
              </Field>
            )}
            {form.providerId === "claude-subscription" && form.subscriptionAccountId && (
              <Check checked={form.useProxy} onChange={(v) => setForm((f) => ({ ...f, useProxy: v }))}>
                Route via proxy <Muted>(transparent switching, no credential-file swap)</Muted>
              </Check>
            )}
            {form.providerId !== "claude-subscription" && storedForProvider.length > 0 && (
              <Field label={`Stored ${provider?.displayName} account`}>
                <Select value={form.providerAccountId} onChange={set("providerAccountId")}>
                  <option value="">Enter manually below</option>
                  {storedForProvider.map((a) => (
                    <option key={a.id} value={a.id}>{a.label} ({a.id})</option>
                  ))}
                </Select>
              </Field>
            )}
            {(!form.providerAccountId || form.providerId === "claude-subscription") &&
              provider?.fields.map((f) => (
                <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`} hint={f.help}>
                  <Input
                    type={f.secret ? "password" : "text"}
                    value={f.key === "apiKey" ? form.apiKey : form.providerModel}
                    onChange={f.key === "apiKey" ? set("apiKey") : set("providerModel")}
                    placeholder={f.placeholder ?? ""}
                  />
                </Field>
              ))}
            <Field label="Model override" hint="Optional.">
              <Input value={form.model} onChange={set("model")} placeholder="provider default" />
            </Field>
            <Field label="Extra agent args" hint="Optional.">
              <Input value={form.agentArgs} onChange={set("agentArgs")} placeholder="--dangerously-skip-permissions" />
            </Field>
            <RowActions>
              <Button variant="primary" type="submit">Save profile</Button>
            </RowActions>
          </Form>
        </Card>
      </Grid2>
      {stored.profiles.length > 0 && (
        <p><Muted>Tip: <Badge tone="info">Proxy</Badge> profiles need <Code>swisscode proxy run</Code> up.</Muted></p>
      )}
    </Page>
  );
}
