import { useState } from "react";
import type { FieldDef, Profile } from "@swisscode/core";
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
  notify,
} from "../design";
import { saveProfileFn } from "../lib/functions";

export interface ProfileFormState {
  name: string;
  agentId: string;
  providerId: string;
  model: string;
  config: Record<string, string>;
  agentArgs: string;
  subscriptionAccountId: string;
  useProxy: boolean;
  providerAccountId: string;
}

export const emptyProfileForm: ProfileFormState = {
  name: "",
  agentId: "claude-code",
  providerId: "openrouter",
  model: "",
  config: {},
  agentArgs: "",
  subscriptionAccountId: "",
  useProxy: false,
  providerAccountId: "",
};

/** Stored profile → form state (for the edit page). */
export function profileToForm(profile: Profile): ProfileFormState {
  return {
    name: profile.name,
    agentId: profile.agentId,
    providerId: profile.providerId,
    model: profile.model ?? "",
    config: { ...(profile.providerConfig ?? {}) },
    agentArgs: (profile.agentArgs ?? []).join(" "),
    subscriptionAccountId: profile.subscriptionAccountId ?? "",
    useProxy: profile.useProxy ?? false,
    providerAccountId: profile.providerAccountId ?? "",
  };
}

function formToProfile(form: ProfileFormState): Profile {
  return {
    name: form.name.trim(),
    agentId: form.agentId,
    providerId: form.providerId,
    model: form.model.trim() || undefined,
    agentArgs: form.agentArgs.split(/\s+/).filter(Boolean),
    providerConfig: Object.fromEntries(
      Object.entries(form.config).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]),
    ),
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
}

interface ProfileFormProps {
  agents: { id: string; displayName: string }[];
  providers: { id: string; displayName: string; fields: FieldDef[] }[];
  subscriptionAccounts: { id: string; label: string }[];
  keyAccounts: { id: string; label: string; providerId: string }[];
  initial?: ProfileFormState;
  /** False on the edit page: renames happen by delete + recreate. */
  nameEditable?: boolean;
  submitLabel: string;
  onSaved: (name: string) => void;
}

/** Create/edit form for one profile. Saves via saveProfileFn, toasts, then onSaved. */
export function ProfileForm(props: ProfileFormProps) {
  const [form, setForm] = useState<ProfileFormState>(props.initial ?? emptyProfileForm);
  const [error, setError] = useState<string | null>(null);

  const provider = props.providers.find((p) => p.id === form.providerId);
  const set = (key: "name" | "model" | "agentArgs") => (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setConfig = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, config: { ...f.config, [key]: e.target.value } }));
  const storedForProvider = props.keyAccounts.filter((a) => a.providerId === form.providerId);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const profile = formToProfile(form);
    try {
      await saveProfileFn({ data: profile });
      notify.success(`Profile "${profile.name}" saved`);
      props.onSaved(profile.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Form onSubmit={onSave}>
      {error && <Notice tone="danger">{error}</Notice>}
      <Field label="Profile name">
        <Input
          value={form.name}
          onChange={set("name")}
          placeholder="work"
          required
          disabled={props.nameEditable === false}
        />
      </Field>
      <Field label="Coding agent">
        <Select value={form.agentId} onChange={(e) => setForm((f) => ({ ...f, agentId: e.target.value }))}>
          {props.agents.map((a) => (
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
          {props.providers.map((p) => (
            <option key={p.id} value={p.id}>{p.displayName}</option>
          ))}
        </Select>
      </Field>
      {form.providerId === "claude-subscription" && (
        <Field label="Subscription account" hint="Blank uses the current login.">
          <Select
            value={form.subscriptionAccountId}
            onChange={(e) => setForm((f) => ({ ...f, subscriptionAccountId: e.target.value }))}
          >
            <option value="">Current Claude Code login</option>
            {props.subscriptionAccounts.map((a) => (
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
          <Select
            value={form.providerAccountId}
            onChange={(e) => setForm((f) => ({ ...f, providerAccountId: e.target.value }))}
          >
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
              value={form.config[f.key] ?? ""}
              onChange={setConfig(f.key)}
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
        <Button variant="primary" type="submit">{props.submitLabel}</Button>
      </RowActions>
    </Form>
  );
}
