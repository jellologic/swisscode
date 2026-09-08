import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Card,
  Check,
  Code,
  Field,
  Form,
  Input,
  Muted,
  Notice,
  Page,
  RowActions,
  Select,
  Stack,
  Textarea,
} from "../design";
import {
  catalogFn,
  removeCustomProviderFn,
  saveCustomProviderFn,
} from "../lib/functions";

export const Route = createFileRoute("/providers")({
  loader: async () => catalogFn(),
  component: ProvidersPage,
});

interface FieldRow {
  key: string;
  label: string;
  placeholder: string;
  help: string;
  secret: boolean;
  required: boolean;
}

interface EnvRow {
  name: string;
  value: string;
}

const blankField = (): FieldRow => ({
  key: "",
  label: "",
  placeholder: "",
  help: "",
  secret: false,
  required: false,
});

const blankEnv = (): EnvRow => ({ name: "", value: "" });

interface CustomForm {
  id: string;
  displayName: string;
  description: string;
  hint: string;
  fields: FieldRow[];
  staticEnv: EnvRow[];
  mapEnv: EnvRow[];
  modelEnvVar: string;
  modelConfigKey: string;
  helpSummary: string;
  helpSetup: string;
  helpCommands: string;
  helpLinks: string;
}

const blankForm = (): CustomForm => ({
  id: "",
  displayName: "",
  description: "",
  hint: "",
  fields: [],
  staticEnv: [],
  mapEnv: [],
  modelEnvVar: "",
  modelConfigKey: "",
  helpSummary: "",
  helpSetup: "",
  helpCommands: "",
  helpLinks: "",
});

function lines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

function ProvidersPage() {
  const { providers } = Route.useLoaderData();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CustomForm>(blankForm());

  const builtins = providers.filter((p) => p.builtin);
  const customs = providers.filter((p) => !p.builtin);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      setEditing(false);
      setForm(blankForm());
      await router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function startEdit(providerId: string) {
    const def = providers.find((p) => p.id === providerId)?.custom;
    if (!def) return;
    setForm({
      id: def.id,
      displayName: def.displayName,
      description: def.description ?? "",
      hint: def.hint ?? "",
      fields: def.fields.map((f) => ({
        key: f.key,
        label: f.label,
        placeholder: f.placeholder ?? "",
        help: f.help ?? "",
        secret: f.secret,
        required: f.required,
      })),
      staticEnv: Object.entries(def.envStatic ?? {}).map(([name, value]) => ({ name, value })),
      mapEnv: Object.entries(def.envFromConfig ?? {}).map(([name, value]) => ({ name, value })),
      modelEnvVar: def.modelEnvVar ?? "",
      modelConfigKey: def.modelConfigKey ?? "",
      helpSummary: def.help?.summary ?? "",
      helpSetup: (def.help?.setup ?? []).join("\n"),
      helpCommands: (def.help?.commands ?? []).join("\n"),
      helpLinks: (def.help?.links ?? []).map((l) => `${l.label} | ${l.href}`).join("\n"),
    });
    setEditing(true);
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    const fields = form.fields
      .filter((f) => f.key.trim())
      .map((f) => ({
        key: f.key.trim(),
        label: f.label.trim() || f.key.trim(),
        secret: f.secret,
        required: f.required,
        ...(f.placeholder.trim() ? { placeholder: f.placeholder.trim() } : {}),
        ...(f.help.trim() ? { help: f.help.trim() } : {}),
      }));
    const staticEnv: Record<string, string> = {};
    for (const r of form.staticEnv) {
      if (r.name.trim()) staticEnv[r.name.trim()] = r.value;
    }
    const mapEnv: Record<string, string> = {};
    for (const r of form.mapEnv) {
      if (r.name.trim() && r.value.trim()) mapEnv[r.name.trim()] = r.value.trim();
    }
    const linkItems = lines(form.helpLinks)
      .map((line) => line.split("|").map((s) => s.trim()))
      .filter((parts) => parts.length === 2 && parts[0] && parts[1])
      .map((parts) => ({ label: parts[0] as string, href: parts[1] as string }));
    await run(() =>
      saveCustomProviderFn({
        data: {
          id: form.id.trim(),
          displayName: form.displayName.trim(),
          ...(form.description.trim() ? { description: form.description.trim() } : {}),
          ...(form.hint.trim() ? { hint: form.hint.trim() } : {}),
          fields,
          ...(Object.keys(staticEnv).length > 0 ? { envStatic: staticEnv } : {}),
          ...(Object.keys(mapEnv).length > 0 ? { envFromConfig: mapEnv } : {}),
          ...(form.modelEnvVar.trim() ? { modelEnvVar: form.modelEnvVar.trim() } : {}),
          ...(form.modelConfigKey.trim() ? { modelConfigKey: form.modelConfigKey.trim() } : {}),
          ...(form.helpSummary.trim() || lines(form.helpSetup).length > 0 || lines(form.helpCommands).length > 0 || linkItems.length > 0
            ? {
                help: {
                  ...(form.helpSummary.trim() ? { summary: form.helpSummary.trim() } : {}),
                  ...(lines(form.helpSetup).length > 0 ? { setup: lines(form.helpSetup) } : {}),
                  ...(lines(form.helpCommands).length > 0 ? { commands: lines(form.helpCommands) } : {}),
                  ...(linkItems.length > 0 ? { links: linkItems } : {}),
                },
              }
            : {}),
        },
      }),
    );
  }

  const fieldKeys = form.fields.map((f) => f.key.trim()).filter(Boolean);

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
              <Button size="sm" variant="ghost" onClick={() => startEdit(p.id)}>Edit</Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => void run(() => removeCustomProviderFn({ data: { id: p.id } }))}
              >
                Delete
              </Button>
            </RowActions>
          </Card>
        ))}
        {error && <Notice tone="danger">{error}</Notice>}

        {!editing && (
          <RowActions>
            <Button
              variant="primary"
              onClick={() => {
                setForm(blankForm());
                setEditing(true);
              }}
            >
              Add custom provider
            </Button>
          </RowActions>
        )}

        {editing && (
          <Card>
            <h2>{form.id && customs.some((p) => p.id === form.id) ? `Edit ${form.id}` : "New custom provider"}</h2>
            <Form onSubmit={onSave}>
              <Field label="Provider id *" hint="Lowercase slug, e.g. my-gateway. Must not shadow a built-in.">
                <Input
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                  placeholder="my-gateway"
                  required
                  disabled={customs.some((p) => p.id === form.id)}
                />
              </Field>
              <Field label="Display name *">
                <Input
                  value={form.displayName}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                  placeholder="My Gateway"
                  required
                />
              </Field>
              <Field label="Description">
                <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </Field>
              <Field label="Hint" hint="Shown on /accounts, like built-in hints.">
                <Input value={form.hint} onChange={(e) => setForm({ ...form, hint: e.target.value })} />
              </Field>

              <h3>Config fields</h3>
              <p><Muted>Collected on /accounts and validated on save — same FieldDef as built-ins.</Muted></p>
              {form.fields.map((f, i) => (
                <Card key={i}>
                  <Stack>
                    <Field label="Key *">
                      <Input
                        value={f.key}
                        onChange={(e) => {
                          const fields = [...form.fields];
                          fields[i] = { ...f, key: e.target.value };
                          setForm({ ...form, fields });
                        }}
                        placeholder="apiKey"
                      />
                    </Field>
                    <Field label="Label">
                      <Input
                        value={f.label}
                        onChange={(e) => {
                          const fields = [...form.fields];
                          fields[i] = { ...f, label: e.target.value };
                          setForm({ ...form, fields });
                        }}
                        placeholder="API Key"
                      />
                    </Field>
                    <RowActions>
                      <Check
                        checked={f.secret}
                        onChange={(v) => {
                          const fields = [...form.fields];
                          fields[i] = { ...f, secret: v };
                          setForm({ ...form, fields });
                        }}
                      >
                        Secret
                      </Check>
                      <Check
                        checked={f.required}
                        onChange={(v) => {
                          const fields = [...form.fields];
                          fields[i] = { ...f, required: v };
                          setForm({ ...form, fields });
                        }}
                      >
                        Required
                      </Check>
                      <Button
                        size="sm"
                        variant="danger"
                        type="button"
                        onClick={() => setForm({ ...form, fields: form.fields.filter((_, j) => j !== i) })}
                      >
                        Remove
                      </Button>
                    </RowActions>
                  </Stack>
                </Card>
              ))}
              <RowActions>
                <Button type="button" onClick={() => setForm({ ...form, fields: [...form.fields, blankField()] })}>
                  Add field
                </Button>
              </RowActions>

              <h3>Environment</h3>
              <p><Muted>How stored config becomes launch env vars. Empty values are skipped at launch.</Muted></p>
              {form.staticEnv.map((r, i) => (
                <RowActions key={i}>
                  <Input
                    value={r.name}
                    onChange={(e) => {
                      const staticEnv = [...form.staticEnv];
                      staticEnv[i] = { ...r, name: e.target.value };
                      setForm({ ...form, staticEnv });
                    }}
                    placeholder="ANTHROPIC_BASE_URL"
                  />
                  <Input
                    value={r.value}
                    onChange={(e) => {
                      const staticEnv = [...form.staticEnv];
                      staticEnv[i] = { ...r, value: e.target.value };
                      setForm({ ...form, staticEnv });
                    }}
                    placeholder="https://…"
                  />
                  <Button
                    size="sm"
                    variant="danger"
                    type="button"
                    onClick={() => setForm({ ...form, staticEnv: form.staticEnv.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </Button>
                </RowActions>
              ))}
              <RowActions>
                <Button type="button" onClick={() => setForm({ ...form, staticEnv: [...form.staticEnv, blankEnv()] })}>
                  Add static var
                </Button>
              </RowActions>
              {form.mapEnv.map((r, i) => (
                <RowActions key={i}>
                  <Input
                    value={r.name}
                    onChange={(e) => {
                      const mapEnv = [...form.mapEnv];
                      mapEnv[i] = { ...r, name: e.target.value };
                      setForm({ ...form, mapEnv });
                    }}
                    placeholder="ANTHROPIC_AUTH_TOKEN"
                  />
                  <Select
                    value={r.value}
                    onChange={(e) => {
                      const mapEnv = [...form.mapEnv];
                      mapEnv[i] = { ...r, value: e.target.value };
                      setForm({ ...form, mapEnv });
                    }}
                  >
                    <option value="">— field —</option>
                    {fieldKeys.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="danger"
                    type="button"
                    onClick={() => setForm({ ...form, mapEnv: form.mapEnv.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </Button>
                </RowActions>
              ))}
              <RowActions>
                <Button type="button" onClick={() => setForm({ ...form, mapEnv: [...form.mapEnv, blankEnv()] })}>
                  Add config mapping
                </Button>
              </RowActions>
              <Field label="Model env var" hint="e.g. ANTHROPIC_MODEL. Value: profile model, else the model field below.">
                <Input
                  value={form.modelEnvVar}
                  onChange={(e) => setForm({ ...form, modelEnvVar: e.target.value })}
                  placeholder="ANTHROPIC_MODEL"
                />
              </Field>
              <Field label="Model config field" hint="Defaults to “model” when blank.">
                <Input
                  value={form.modelConfigKey}
                  onChange={(e) => setForm({ ...form, modelConfigKey: e.target.value })}
                  placeholder="model"
                />
              </Field>

              <h3>Help (plugin DNA)</h3>
              <p><Muted>Rendered on /help automatically. Steps and commands are one per line; links are “label | https://…”.</Muted></p>
              <Field label="Summary">
                <Textarea
                  rows={2}
                  value={form.helpSummary}
                  onChange={(e) => setForm({ ...form, helpSummary: e.target.value })}
                />
              </Field>
              <Field label="Setup steps (one per line)">
                <Textarea
                  value={form.helpSetup}
                  onChange={(e) => setForm({ ...form, helpSetup: e.target.value })}
                />
              </Field>
              <Field label="Commands (one per line)">
                <Textarea
                  rows={2}
                  value={form.helpCommands}
                  onChange={(e) => setForm({ ...form, helpCommands: e.target.value })}
                />
              </Field>
              <Field label="Links (label | url, one per line)">
                <Textarea
                  rows={2}
                  value={form.helpLinks}
                  onChange={(e) => setForm({ ...form, helpLinks: e.target.value })}
                />
              </Field>

              <RowActions>
                <Button variant="primary" type="submit">Save provider</Button>
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setEditing(false);
                    setForm(blankForm());
                  }}
                >
                  Cancel
                </Button>
              </RowActions>
            </Form>
          </Card>
        )}
      </Stack>
    </Page>
  );
}
