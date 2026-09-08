import { useState } from "react";
import type { CustomProviderDef } from "@swisscode/core";
import {
  Button,
  Check,
  Field,
  Form,
  Input,
  Muted,
  Notice,
  RowActions,
  Select,
  Stack,
  Textarea,
  notify,
} from "../design";
import { saveCustomProviderFn } from "../lib/functions";

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

export interface CustomForm {
  id: string;
  displayName: string;
  description: string;
  hint: string;
  fields: FieldRow[];
  staticEnv: EnvRow[];
  mapEnv: EnvRow[];
  modelEnvVar: string;
  modelConfigKey: string;
  testUrl: string;
  testMethod: string;
  testHeaderName: string;
  testAuthField: string;
  testAuthScheme: string;
  testExpectStatus: string;
  helpSummary: string;
  helpSetup: string;
  helpCommands: string;
  helpLinks: string;
}

export const blankCustomForm = (): CustomForm => ({
  id: "",
  displayName: "",
  description: "",
  hint: "",
  fields: [],
  staticEnv: [],
  mapEnv: [],
  modelEnvVar: "",
  modelConfigKey: "",
  testUrl: "",
  testMethod: "GET",
  testHeaderName: "",
  testAuthField: "",
  testAuthScheme: "",
  testExpectStatus: "",
  helpSummary: "",
  helpSetup: "",
  helpCommands: "",
  helpLinks: "",
});

/** Stored def → form state (for the edit page). */
export function customDefToForm(def: CustomProviderDef): CustomForm {
  return {
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
    testUrl: def.test?.url ?? "",
    testMethod: def.test?.method ?? "GET",
    testHeaderName: def.test?.headerName ?? "",
    testAuthField: def.test?.authField ?? "",
    testAuthScheme: def.test?.authScheme ?? "",
    testExpectStatus: def.test?.expectStatus !== undefined ? String(def.test.expectStatus) : "",
    helpSummary: def.help?.summary ?? "",
    helpSetup: (def.help?.setup ?? []).join("\n"),
    helpCommands: (def.help?.commands ?? []).join("\n"),
    helpLinks: (def.help?.links ?? []).map((l) => `${l.label} | ${l.href}`).join("\n"),
  };
}

function lines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

interface CustomProviderFormProps {
  initial: CustomForm;
  /** False when editing: the id is the identity and can't change. */
  idEditable?: boolean;
  submitLabel: string;
  onSaved: (id: string) => void;
}

/** Create/edit form for one custom provider. Saves, toasts, then onSaved. */
export function CustomProviderForm(props: CustomProviderFormProps) {
  const [form, setForm] = useState<CustomForm>(props.initial);
  const [error, setError] = useState<string | null>(null);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
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
    try {
      const id = form.id.trim();
      await saveCustomProviderFn({
        data: {
          id,
          displayName: form.displayName.trim(),
          ...(form.description.trim() ? { description: form.description.trim() } : {}),
          ...(form.hint.trim() ? { hint: form.hint.trim() } : {}),
          fields,
          ...(Object.keys(staticEnv).length > 0 ? { envStatic: staticEnv } : {}),
          ...(Object.keys(mapEnv).length > 0 ? { envFromConfig: mapEnv } : {}),
          ...(form.modelEnvVar.trim() ? { modelEnvVar: form.modelEnvVar.trim() } : {}),
          ...(form.modelConfigKey.trim() ? { modelConfigKey: form.modelConfigKey.trim() } : {}),
          ...(form.testUrl.trim()
            ? {
                test: {
                  url: form.testUrl.trim(),
                  method: form.testMethod === "POST" ? ("POST" as const) : ("GET" as const),
                  ...(form.testHeaderName.trim() ? { headerName: form.testHeaderName.trim() } : {}),
                  ...(form.testAuthField ? { authField: form.testAuthField } : {}),
                  ...(form.testAuthScheme ? { authScheme: form.testAuthScheme } : {}),
                  ...(form.testExpectStatus.trim() && Number.isInteger(Number(form.testExpectStatus.trim()))
                    ? { expectStatus: Number(form.testExpectStatus.trim()) }
                    : {}),
                },
              }
            : {}),
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
      });
      notify.success(`Provider "${id}" saved`);
      props.onSaved(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const fieldKeys = form.fields.map((f) => f.key.trim()).filter(Boolean);

  return (
    <Form onSubmit={onSave}>
      {error && <Notice tone="danger">{error}</Notice>}
      <Field label="Provider id *" hint="Lowercase slug, e.g. my-gateway. Must not shadow a built-in.">
        <Input
          value={form.id}
          onChange={(e) => setForm({ ...form, id: e.target.value })}
          placeholder="my-gateway"
          required
          disabled={props.idEditable === false}
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
        <Stack key={i}>
          <Muted>Field {i + 1}</Muted>
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

      <h3>Connection test</h3>
      <p><Muted>Optional probe for the Test button on /accounts. Blank URL = no test.</Muted></p>
      <Field label="Test URL (https)">
        <Input
          value={form.testUrl}
          onChange={(e) => setForm({ ...form, testUrl: e.target.value })}
          placeholder="https://…/key"
        />
      </Field>
      <Field label="Method">
        <Select
          value={form.testMethod}
          onChange={(e) => setForm({ ...form, testMethod: e.target.value })}
        >
          <option value="GET">GET</option>
          <option value="POST">POST</option>
        </Select>
      </Field>
      <Field label="Auth header" hint="Defaults to Authorization.">
        <Input
          value={form.testHeaderName}
          onChange={(e) => setForm({ ...form, testHeaderName: e.target.value })}
          placeholder="Authorization"
        />
      </Field>
      <Field label="Auth field" hint="Config field whose value is sent. Blank = anonymous probe.">
        <Select
          value={form.testAuthField}
          onChange={(e) => setForm({ ...form, testAuthField: e.target.value })}
        >
          <option value="">— none —</option>
          {fieldKeys.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </Select>
      </Field>
      <Field label="Auth scheme" hint="Prefix before the value. Blank = “Bearer ”.">
        <Input
          value={form.testAuthScheme}
          onChange={(e) => setForm({ ...form, testAuthScheme: e.target.value })}
          placeholder="Bearer "
        />
      </Field>
      <Field label="Expected status" hint="Blank = any 2xx.">
        <Input
          value={form.testExpectStatus}
          onChange={(e) => setForm({ ...form, testExpectStatus: e.target.value })}
          placeholder="200"
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
        <Button variant="primary" type="submit">{props.submitLabel}</Button>
      </RowActions>
    </Form>
  );
}
