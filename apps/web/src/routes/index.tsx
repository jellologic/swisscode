import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { Profile } from "@swisscode/core";
import {
  catalogFn,
  deleteProfileFn,
  listProfilesFn,
  previewProfileFn,
  saveProfileFn,
} from "../lib/functions";

export const Route = createFileRoute("/")({
  loader: async () => ({
    catalog: await catalogFn(),
    stored: await listProfilesFn(),
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
};

function ProfilesPage() {
  const { catalog, stored } = Route.useLoaderData();
  const router = useRouter();
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const provider = catalog.providers.find((p) => p.id === form.providerId);
  const set = (key: keyof typeof emptyForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  async function refresh() {
    await router.invalidate();
  }

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
    };
    try {
      await saveProfileFn({ data: profile });
      setForm(emptyForm);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="grid">
      <section>
        <h1>Profiles</h1>
        <p className="muted">
          A profile merges a coding agent with an AI provider. Launch it with{" "}
          <code>swisscode &lt;name&gt;</code>. Store: <code>{stored.storePath}</code>
        </p>
        {stored.profiles.length === 0 ? (
          <p className="muted">No profiles yet — create one below.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Name</th><th>Agent</th><th>Provider</th><th>Model</th><th /></tr>
            </thead>
            <tbody>
              {stored.profiles.map((p) => (
                <tr key={p.name}>
                  <td><code>{p.name}</code></td>
                  <td>{p.agentId}</td>
                  <td>{p.providerId}</td>
                  <td>{p.model ?? "—"}</td>
                  <td className="row-actions">
                    <button
                      onClick={async () => {
                        const spec = await previewProfileFn({ data: { name: p.name } });
                        setPreview(`$ ${spec.command} ${spec.args.join(" ")}\n${Object.entries(spec.env).map(([k, v]) => `${k}=${v}`).join("\n")}`);
                      }}
                    >
                      Preview
                    </button>
                    <button
                      onClick={async () => {
                        await deleteProfileFn({ data: { name: p.name } });
                        await refresh();
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {preview && <pre className="preview">{preview}</pre>}
      </section>

      <section>
        <h2>New profile</h2>
        {error && <p className="error">{error}</p>}
        <form onSubmit={onSave} className="form">
          <label>
            Profile name
            <input value={form.name} onChange={set("name")} placeholder="work" required />
          </label>
          <label>
            Coding agent
            <select value={form.agentId} onChange={set("agentId")}>
              {catalog.agents.map((a) => (
                <option key={a.id} value={a.id}>{a.displayName}</option>
              ))}
            </select>
          </label>
          <label>
            AI provider
            <select value={form.providerId} onChange={set("providerId")}>
              {catalog.providers.map((p) => (
                <option key={p.id} value={p.id}>{p.displayName}</option>
              ))}
            </select>
          </label>
          {provider?.fields.map((f) => (
            <label key={f.key}>
              {f.label}{f.required ? " *" : ""}
              <input
                type={f.secret ? "password" : "text"}
                value={f.key === "apiKey" ? form.apiKey : form.providerModel}
                onChange={f.key === "apiKey" ? set("apiKey") : set("providerModel")}
                placeholder={f.placeholder ?? ""}
              />
              {f.help && <small>{f.help}</small>}
            </label>
          ))}
          <label>
            Model override (optional)
            <input value={form.model} onChange={set("model")} placeholder="provider default" />
          </label>
          <label>
            Extra agent args (optional)
            <input value={form.agentArgs} onChange={set("agentArgs")} placeholder="--dangerously-skip-permissions" />
          </label>
          <button type="submit">Save profile</button>
        </form>
      </section>
    </div>
  );
}
