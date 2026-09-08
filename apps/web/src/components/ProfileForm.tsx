import { useEffect, useRef, useState } from "react";
import {
  EFFORT_LEVELS,
  MODEL_ID_RE,
  PERMISSION_MODES,
  SETTING_SOURCES,
  describeModelRoute,
  type ClaudeSessionOptions,
  type FieldDef,
  type ModelRoute,
  type ModelRouteLabels,
  type Profile,
} from "@swisscode/core";
import {
  Button,
  Check,
  Code,
  Disclosure,
  Field,
  Form,
  Input,
  Muted,
  Notice,
  Pre,
  RowActions,
  Section,
  Select,
  Stack,
  Table,
  Textarea,
  notify,
} from "../design";
import { previewLaunchFn, providerModelsFn, saveProfileFn } from "../lib/functions";

type Preview = Awaited<ReturnType<typeof previewLaunchFn>>;

/** One routes-editor row. `dest` encodes the destination select value. */
export interface RouteFormRow {
  match: string;
  /** "subscription:" (base), "subscription:<id>", or "key:<providerId>:<accountId>". */
  dest: string;
  upstreamModel: string;
}

export interface SessionFormState {
  effort: string;
  permissionMode: string;
  allowedTools: string;
  disallowedTools: string;
  tools: string;
  addDirs: string;
  systemPrompt: string;
  appendSystemPrompt: string;
  /** Which snippet the append text was copied from (provenance — emission reads the text). */
  promptPreset: string;
  agent: string;
  mcpConfig: string;
  strictMcp: boolean;
  settingSources: string[];
  fallbackModel: string;
  claudeSettings: string;
}

export interface ProfileFormState {
  name: string;
  agentId: string;
  providerId: string;
  model: string;
  config: Record<string, string>;
  agentArgs: string;
  subscriptionAccountId: string;
  providerAccountId: string;
  /** Advanced opt-out: bypass the proxy (loses failover, routes, inspection). */
  direct: boolean;
  /** Working-directory template: absolute path the agent spawns in (blank = inherit). */
  cwd: string;
  routes: RouteFormRow[];
  session: SessionFormState;
}

export const emptySessionForm: SessionFormState = {
  effort: "",
  permissionMode: "",
  allowedTools: "",
  disallowedTools: "",
  tools: "",
  addDirs: "",
  systemPrompt: "",
  appendSystemPrompt: "",
  promptPreset: "",
  agent: "",
  mcpConfig: "",
  strictMcp: false,
  settingSources: [],
  fallbackModel: "",
  claudeSettings: "",
};

export const emptyProfileForm: ProfileFormState = {
  name: "",
  agentId: "claude-code",
  providerId: "openrouter",
  model: "",
  config: {},
  agentArgs: "",
  subscriptionAccountId: "",
  providerAccountId: "",
  direct: false,
  cwd: "",
  routes: [],
  session: { ...emptySessionForm },
};

function routeToRow(route: ModelRoute): RouteFormRow {
  const dest =
    route.kind === "providerAccount"
      ? `key:${route.providerId ?? ""}:${route.providerAccountId ?? ""}`
      : `subscription:${route.subscriptionAccountId?.trim() ?? ""}`;
  return { match: route.match, dest, upstreamModel: route.upstreamModel ?? "" };
}

function sessionToForm(session?: ClaudeSessionOptions): SessionFormState {
  if (!session) return { ...emptySessionForm };
  const join = (v?: string[]) => (v ?? []).join("\n");
  return {
    effort: session.effort ?? "",
    permissionMode: session.permissionMode ?? "",
    allowedTools: join(session.allowedTools),
    disallowedTools: join(session.disallowedTools),
    tools: session.tools ?? "",
    addDirs: join(session.addDirs),
    systemPrompt: session.systemPrompt ?? "",
    appendSystemPrompt: session.appendSystemPrompt ?? "",
    promptPreset: session.promptPreset ?? "",
    agent: session.agent ?? "",
    mcpConfig: session.mcpConfig ?? "",
    strictMcp: session.strictMcp === true,
    settingSources: [...(session.settingSources ?? [])],
    fallbackModel: join(session.fallbackModel),
    claudeSettings: session.claudeSettings ? JSON.stringify(session.claudeSettings, null, 2) : "",
  };
}

/** Stored profile → form state (for the edit page). Legacy `useProxy` is not read. */
export function profileToForm(profile: Profile): ProfileFormState {
  return {
    name: profile.name,
    agentId: profile.agentId,
    providerId: profile.providerId,
    model: profile.model ?? "",
    config: { ...(profile.providerConfig ?? {}) },
    agentArgs: (profile.agentArgs ?? []).join(" "),
    subscriptionAccountId: profile.subscriptionAccountId ?? "",
    providerAccountId: profile.providerAccountId ?? "",
    direct: profile.direct === true,
    cwd: profile.cwd ?? "",
    routes: (profile.modelRoutes ?? []).map(routeToRow),
    session: sessionToForm(profile.session),
  };
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isSessionEmpty(s: SessionFormState): boolean {
  return (
    !s.effort &&
    !s.permissionMode &&
    !s.allowedTools.trim() &&
    !s.disallowedTools.trim() &&
    !s.tools &&
    !s.addDirs.trim() &&
    !s.systemPrompt.trim() &&
    !s.appendSystemPrompt.trim() &&
    !s.promptPreset.trim() &&
    !s.agent.trim() &&
    !s.mcpConfig.trim() &&
    !s.strictMcp &&
    s.settingSources.length === 0 &&
    !s.fallbackModel.trim() &&
    !s.claudeSettings.trim()
  );
}

function rowToRoute(row: RouteFormRow): ModelRoute {
  const match = row.match.trim();
  const upstream = row.upstreamModel.trim();
  const extra = upstream ? { upstreamModel: upstream } : {};
  if (row.dest.startsWith("key:")) {
    const rest = row.dest.slice("key:".length);
    const sep = rest.indexOf(":");
    return {
      match,
      kind: "providerAccount",
      providerId: rest.slice(0, sep),
      providerAccountId: rest.slice(sep + 1),
      ...extra,
    };
  }
  const accountId = row.dest.slice("subscription:".length);
  return {
    match,
    kind: "subscription",
    ...(accountId ? { subscriptionAccountId: accountId } : {}),
    ...extra,
  };
}

function sessionToOptions(s: SessionFormState): ClaudeSessionOptions | undefined {
  const out: ClaudeSessionOptions = {};
  if (s.effort) out.effort = s.effort;
  if (s.permissionMode) out.permissionMode = s.permissionMode;
  const allowed = lines(s.allowedTools);
  if (allowed.length > 0) out.allowedTools = allowed;
  const disallowed = lines(s.disallowedTools);
  if (disallowed.length > 0) out.disallowedTools = disallowed;
  if (s.tools) out.tools = s.tools;
  const dirs = lines(s.addDirs);
  if (dirs.length > 0) out.addDirs = dirs;
  if (s.systemPrompt.trim()) out.systemPrompt = s.systemPrompt.trim();
  if (s.appendSystemPrompt.trim()) out.appendSystemPrompt = s.appendSystemPrompt.trim();
  if (s.promptPreset.trim()) out.promptPreset = s.promptPreset.trim();
  if (s.agent.trim()) out.agent = s.agent.trim();
  if (s.mcpConfig.trim()) out.mcpConfig = s.mcpConfig.trim();
  if (s.strictMcp) out.strictMcp = true;
  // All-on or all-off both mean "load every layer" — store neither.
  const picked = s.settingSources.filter((v) => (SETTING_SOURCES as readonly string[]).includes(v));
  if (picked.length > 0 && picked.length < SETTING_SOURCES.length) out.settingSources = picked;
  const fallback = lines(s.fallbackModel);
  if (fallback.length > 0) out.fallbackModel = fallback;
  if (s.claudeSettings.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s.claudeSettings);
    } catch {
      throw new Error("Claude Code session: Advanced JSON does not parse — fix it or clear the field.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Claude Code session: Advanced JSON must be an object of settings keys.");
    }
    out.claudeSettings = parsed as ClaudeSessionOptions["claudeSettings"];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Empty = omitted, never ""/defaults persisted. Throws on bad Advanced JSON. */
function formToProfile(form: ProfileFormState): Profile {
  const session = sessionToOptions(form.session);
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
    ...(form.providerId !== "claude-subscription" && form.providerAccountId
      ? { providerAccountId: form.providerAccountId }
      : {}),
    ...(form.direct ? { direct: true as const } : {}),
    ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}),
    ...(form.routes.length > 0 ? { modelRoutes: form.routes.map(rowToRoute) } : {}),
    ...(session ? { session } : {}),
  };
}

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  plan: "Proposes first, runs after approval",
  acceptEdits: "Runs file edits, asks for the rest",
  auto: "Runs vetted actions, asks otherwise",
  manual: "Asks before each action",
  dontAsk: "Denies silently instead of asking",
  bypassPermissions: "No checks — sandbox only",
};

interface ProfileFormProps {
  agents: { id: string; displayName: string }[];
  providers: { id: string; displayName: string; fields: FieldDef[] }[];
  subscriptionAccounts: { id: string; label: string }[];
  keyAccounts: { id: string; label: string; providerId: string }[];
  initial?: ProfileFormState;
  /** Snippet library for the Append box (copy-fill, never linked). */
  promptPresets?: readonly { id: string; title: string; text: string }[];
  /** False on the edit page: renames happen by delete + recreate. */
  nameEditable?: boolean;
  submitLabel: string;
  onSaved: (name: string) => void;
}

/** Create/edit form for one profile. Saves via saveProfileFn, toasts, then onSaved. */
export function ProfileForm(props: ProfileFormProps) {
  const [form, setForm] = useState<ProfileFormState>(props.initial ?? emptyProfileForm);
  const [error, setError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Record<string, string[]>>({});
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [preview, setPreview] = useState<{ loading: boolean; error?: string; data?: Preview } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Editing a profile that already has routes: suggestions needed immediately.
  useEffect(() => {
    if ((props.initial?.routes.length ?? 0) > 0) loadSuggestions();
    // Once on mount — loadSuggestions self-guards against refetching.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const provider = props.providers.find((p) => p.id === form.providerId);
  const set = (key: "name" | "model" | "agentArgs" | "cwd") => (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const setConfig = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, config: { ...f.config, [key]: e.target.value } }));
  const setSession = (key: keyof SessionFormState) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => {
    const value = e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value;
    setForm((f) => ({ ...f, session: { ...f.session, [key]: value } }));
    if (key === "claudeSettings") validateSettingsJson(String(value));
  };
  const storedForProvider = props.keyAccounts.filter((a) => a.providerId === form.providerId);

  const vaultIds = new Set(props.subscriptionAccounts.map((a) => a.id));
  const keyIds = new Set(props.keyAccounts.map((a) => `${a.providerId}:${a.id}`));
  const labels: ModelRouteLabels = {
    subscriptionAccountLabel: (id) => props.subscriptionAccounts.find((a) => a.id === id)?.label,
    providerAccountLabel: (providerId, id) =>
      props.keyAccounts.find((a) => a.providerId === providerId && a.id === id)?.label,
    providerDisplayName: (providerId) => props.providers.find((p) => p.id === providerId)?.displayName,
  };

  function validateSettingsJson(value: string): boolean {
    if (!value.trim()) {
      setSettingsError(null);
      return true;
    }
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        setSettingsError("Must be a JSON object of settings keys, not an array or scalar.");
        return false;
      }
    } catch {
      setSettingsError("Does not parse as JSON.");
      return false;
    }
    setSettingsError(null);
    return true;
  }

  /** Per-row route validation: unknown account, dup match, bad charset. */
  function rowProblem(row: RouteFormRow, index: number): string | null {
    const match = row.match.trim();
    if (!match) return "Match is required — the exact model id (aliases resolve client-side, so use full ids).";
    if (!MODEL_ID_RE.test(match)) {
      return "Match must be a vendor model id (letters, digits, . _ : @ / -).";
    }
    if (form.routes.findIndex((r) => r.match.trim() === match) !== index) {
      return `Duplicate match — the first row wins, so this one would never fire.`;
    }
    if (row.dest.startsWith("key:")) {
      if (!keyIds.has(row.dest.slice("key:".length))) return "Unknown stored account — pick one from the list.";
    } else {
      const id = row.dest.slice("subscription:".length);
      if (id && !vaultIds.has(id)) return "Unknown vault account — pick one from the list.";
    }
    const upstream = row.upstreamModel.trim();
    if (upstream && !MODEL_ID_RE.test(upstream)) {
      return "Upstream model must be a vendor model id — or blank for same-as-requested.";
    }
    return null;
  }

  const rowProblems = form.routes.map((row, i) => rowProblem(row, i));

  /** Catalog model ids for upstream suggestions, loaded once when routes open. */
  function loadSuggestions() {
    if (suggestionsLoading || Object.keys(suggestions).length > 0) return;
    const providerIds = [...new Set(props.keyAccounts.map((a) => a.providerId))];
    if (providerIds.length === 0) return;
    setSuggestionsLoading(true);
    void Promise.all(
      providerIds.map(async (providerId) => {
        try {
          const data = await providerModelsFn({ data: { providerId } });
          return [providerId, (data.models ?? []).map((m) => m.id)] as const;
        } catch {
          return [providerId, []] as const;
        }
      }),
    ).then((pairs) => {
      setSuggestions(Object.fromEntries(pairs));
      setSuggestionsLoading(false);
    });
  }

  function updateRoute(index: number, patch: Partial<RouteFormRow>) {
    setForm((f) => ({ ...f, routes: f.routes.map((r, i) => (i === index ? { ...r, ...patch } : r)) }));
  }

  function buildProfile(): Profile | null {
    if (form.direct && form.routes.length > 0) {
      setError("Direct mode bypasses the proxy, so model routes would never fire — remove the routes or turn direct off.");
      return null;
    }
    const bad = rowProblems.findIndex((p) => p !== null);
    if (bad !== -1) {
      setError(`Route row ${bad + 1} needs attention before saving.`);
      return null;
    }
    try {
      return formToProfile(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const profile = buildProfile();
    if (!profile) return;
    try {
      await saveProfileFn({ data: profile });
      notify.success(`Profile "${profile.name}" saved`);
      props.onSaved(profile.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onPreview() {
    setError(null);
    const profile = buildProfile();
    if (!profile) return;
    setPreview({ loading: true });
    dialogRef.current?.showModal();
    try {
      const data = await previewLaunchFn({ data: profile });
      setPreview({ loading: false, data });
    } catch (err) {
      setPreview({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const routesBody = (
    <Stack>
      <Muted>
        Send different models to different backends inside one session. Matching is exact and
        first-row-wins.
      </Muted>
      {form.routes.map((row, i) => {
        const problem = rowProblems[i];
        const destProvider = row.dest.startsWith("key:")
          ? row.dest.slice("key:".length).split(":")[0]!
          : undefined;
        const modelIds = (destProvider && suggestions[destProvider]) || [];
        return (
          <div key={i}>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ flex: "2 1 160px" }}>
                <Field label={i === 0 ? "Match (model id)" : ""}>
                  <Input
                    value={row.match}
                    onChange={(e) => updateRoute(i, { match: e.target.value })}
                    placeholder="claude-opus-5"
                  />
                </Field>
              </div>
              <div style={{ flex: "3 1 220px" }}>
                <Field label={i === 0 ? "Destination" : ""}>
                  <Select value={row.dest} onChange={(e) => updateRoute(i, { dest: e.target.value })}>
                    <optgroup label="Subscription (via proxy)">
                      <option value="subscription:">Profile base account</option>
                      {props.subscriptionAccounts.map((a) => (
                        <option key={a.id} value={`subscription:${a.id}`}>{a.label} ({a.id})</option>
                      ))}
                    </optgroup>
                    {props.keyAccounts.length > 0 && (
                      <optgroup label="Keys">
                        {props.keyAccounts.map((a) => (
                          <option key={`${a.providerId}:${a.id}`} value={`key:${a.providerId}:${a.id}`}>
                            {a.label} · {props.providers.find((p) => p.id === a.providerId)?.displayName ?? a.providerId}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </Select>
                </Field>
              </div>
              <div style={{ flex: "2 1 160px" }}>
                <Field label={i === 0 ? "Upstream model" : ""}>
                  <Input
                    value={row.upstreamModel}
                    onChange={(e) => updateRoute(i, { upstreamModel: e.target.value })}
                    placeholder="same as requested"
                    list={`upstream-models-${i}`}
                  />
                  <datalist id={`upstream-models-${i}`}>
                    {modelIds.map((id) => (
                      <option key={id} value={id} />
                    ))}
                  </datalist>
                </Field>
              </div>
              <Button type="button" onClick={() => setForm((f) => ({ ...f, routes: f.routes.filter((_, j) => j !== i) }))}>
                ×
              </Button>
            </div>
            {problem ? (
              <Notice tone="danger">{problem}</Notice>
            ) : (
              <Muted>{describeModelRoute(rowToRoute(row), labels)}</Muted>
            )}
          </div>
        );
      })}
      <RowActions>
        <Button
          type="button"
          onClick={() => {
            if (form.routes.length === 0) loadSuggestions();
            setForm((f) => ({
              ...f,
              routes: [...f.routes, { match: "", dest: "subscription:", upstreamModel: "" }],
            }));
          }}
        >
          + Add route
        </Button>
        {suggestionsLoading && <Muted>Loading model suggestions…</Muted>}
      </RowActions>
      {form.routes.length > 0 && !form.direct && (
        <Notice tone="info">
          This profile always launches via the proxy (<Code>swisscode proxy run</Code> must be
          up). Edits apply to the next request — even in a running session.
        </Notice>
      )}
    </Stack>
  );

  const sessionBody = (
    <Stack>
      <Muted>
        Optional Claude Code knobs for this profile. Absent means today&apos;s behavior — nothing
        here ever rewrites your own settings files. Managed settings still win (org policy).
      </Muted>
      <Field label="Model & reasoning">
        <Stack>
          <Field label="Effort" hint="Higher is more thorough — and slower and pricier.">
            <Select value={form.session.effort} onChange={setSession("effort")}>
              <option value="">Default</option>
              {EFFORT_LEVELS.map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </Select>
          </Field>
          <Field label="Fallback models" hint="Settings-level chain, one per line — applies generally.">
            <Textarea
              rows={2}
              value={form.session.fallbackModel}
              onChange={setSession("fallbackModel")}
              placeholder={"claude-sonnet-5\nclaude-haiku-5"}
            />
          </Field>
        </Stack>
      </Field>
      <Field label="Permissions">
        <Stack>
          <Field label="Permission mode">
            <Select value={form.session.permissionMode} onChange={setSession("permissionMode")}>
              <option value="">Default</option>
              {PERMISSION_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode} — {PERMISSION_DESCRIPTIONS[mode]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Allowed tools" hint="One per line, each stays one flag — e.g. Bash(npm test:*).">
            <Textarea
              rows={2}
              value={form.session.allowedTools}
              onChange={setSession("allowedTools")}
              placeholder="Bash(npm test:*)"
            />
          </Field>
          <Field label="Disallowed tools" hint="One per line.">
            <Textarea
              rows={2}
              value={form.session.disallowedTools}
              onChange={setSession("disallowedTools")}
            />
          </Field>
          <Field label="Additional directories" hint="Extra working directories (--add-dir), one per line.">
            <Textarea rows={2} value={form.session.addDirs} onChange={setSession("addDirs")} />
          </Field>
        </Stack>
      </Field>
      <Field label="Tools & identity">
        <Stack>
          <Field label="Available tools (--tools)" hint="Blank = agent default.">
            <Input value={form.session.tools} onChange={setSession("tools")} placeholder="agent default" />
          </Field>
          <Field label="Session agent (--agent)" hint="Subagent override.">
            <Input value={form.session.agent} onChange={setSession("agent")} />
          </Field>
          <Field label="System prompt" hint="Replacing the system prompt disables per-conversation recording optimizations — prefer Append below.">
            <Textarea rows={2} value={form.session.systemPrompt} onChange={setSession("systemPrompt")} />
          </Field>
          <Field
            label="Prompt preset"
            hint="Copies a starter snippet into Append below — the text is what launches, the preset only records where it came from."
          >
            <Select
              value={form.session.promptPreset}
              onChange={(e) => {
                const id = e.target.value;
                const snippet = props.promptPresets?.find((p) => p.id === id)?.text ?? "";
                setForm((f) => ({
                  ...f,
                  session: {
                    ...f.session,
                    promptPreset: id,
                    ...(id ? { appendSystemPrompt: snippet } : {}),
                  },
                }));
              }}
            >
              <option value="">None (custom text)</option>
              {(props.promptPresets ?? []).map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </Select>
          </Field>
          {form.session.promptPreset.trim() &&
            props.promptPresets?.find((p) => p.id === form.session.promptPreset)?.text !==
              form.session.appendSystemPrompt && (
              <Muted>Edited after copying — the launch uses the text below, the preset stays as provenance.</Muted>
            )}
          <Field label="Append to system prompt">
            <Textarea
              rows={2}
              value={form.session.appendSystemPrompt}
              onChange={setSession("appendSystemPrompt")}
            />
          </Field>
        </Stack>
      </Field>
      <Field label="Integrations">
        <Stack>
          <Field
            label="MCP config"
            hint="Inline JSON (starts with { or [) goes to a temp file; a file path is passed through. Auto-detected."
          >
            <Textarea rows={2} value={form.session.mcpConfig} onChange={setSession("mcpConfig")} />
          </Field>
          <Check
            checked={form.session.strictMcp}
            onChange={(v) => setForm((f) => ({ ...f, session: { ...f.session, strictMcp: v } }))}
          >
            Strict MCP <Muted>(ignore every MCP source except the one above)</Muted>
          </Check>
          <Field label="Settings layers" hint="Uncheck to isolate this profile from that layer. All on or all off = load every layer.">
            <RowActions>
              {(SETTING_SOURCES as readonly string[]).map((layer) => (
                <Check
                  key={layer}
                  checked={form.session.settingSources.length === 0 || form.session.settingSources.includes(layer)}
                  onChange={(v) =>
                    setForm((f) => {
                      const current =
                        f.session.settingSources.length === 0
                          ? [...(SETTING_SOURCES as readonly string[])]
                          : f.session.settingSources;
                      return {
                        ...f,
                        session: {
                          ...f.session,
                          settingSources: v
                            ? [...new Set([...current, layer])]
                            : current.filter((l) => l !== layer),
                        },
                      };
                    })
                  }
                >
                  {layer}
                </Check>
              ))}
            </RowActions>
          </Field>
        </Stack>
      </Field>
      <Field label="Advanced JSON (claudeSettings)" hint="Free-form settings merged UNDER the fields above (curated wins). Keys: sandbox.*, hooks, env, fallbackModel — no output-style knob exists here; put vendor settings JSON in this object.">
        <Textarea
          rows={5}
          value={form.session.claudeSettings}
          onChange={setSession("claudeSettings")}
          placeholder={'{\n  "env": { "FOO": "bar" }\n}'}
        />
      </Field>
      {settingsError && <Notice tone="danger">{settingsError}</Notice>}
    </Stack>
  );

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
      <Field
        label={form.routes.length > 0 ? "Default route model" : "Model override"}
        hint={form.routes.length > 0 ? "Used for any model with no route below." : "Optional."}
      >
        <Input value={form.model} onChange={set("model")} placeholder="provider default" />
      </Field>
      <Field
        label="Working directory"
        hint="Absolute path the agent spawns in (blank = inherit swisscode's directory). Relative paths are refused at save time."
      >
        <Input value={form.cwd} onChange={set("cwd")} placeholder="/Users/me/project" />
      </Field>
      <Notice tone="info">
        Launches through the proxy by default — transparent account switching, 429 failover and
        traffic inspection. Requires <Code>swisscode proxy run</Code>.
      </Notice>
      <Disclosure summary={`Connection: ${form.direct ? "direct (proxy bypassed)" : "via proxy (default)"}`}>
        <Stack>
          <Check
            checked={form.direct}
            onChange={(v) => setForm((f) => ({ ...f, direct: v }))}
          >
            Bypass the proxy <Muted>(advanced — loses failover, model routes and traffic inspection)</Muted>
          </Check>
        </Stack>
      </Disclosure>
      {form.routes.length > 0 ? (
        <Section title="Model routes">{routesBody}</Section>
      ) : (
        <Disclosure summary="Model routes (none)" onOpen={loadSuggestions}>{routesBody}</Disclosure>
      )}
      {!isSessionEmpty(form.session) || props.initial?.session && !isSessionEmpty(props.initial.session) ? (
        <Section title="Claude Code session">{sessionBody}</Section>
      ) : (
        <Disclosure summary="Claude Code session (none set)">{sessionBody}</Disclosure>
      )}
      <Field
        label="Extra agent args"
        hint="Appended after the fields above, so it wins conflicts — see Preview."
      >
        <Input value={form.agentArgs} onChange={set("agentArgs")} placeholder="--dangerously-skip-permissions" />
      </Field>
      <RowActions>
        <Button variant="primary" type="submit">{props.submitLabel}</Button>
        <Button type="button" onClick={() => void onPreview()}>Preview launch</Button>
      </RowActions>
      <dialog ref={dialogRef} style={{ maxWidth: "720px", width: "calc(100% - 32px)" }}>
        <Stack>
          <h2 style={{ margin: 0 }}>Launch preview</h2>
          {preview?.loading && <Muted>Resolving…</Muted>}
          {preview?.error && <Notice tone="danger">{preview.error}</Notice>}
          {preview?.data && <PreviewBody preview={preview.data} />}
          <RowActions>
            <Button type="button" onClick={() => dialogRef.current?.close()}>Close</Button>
          </RowActions>
        </Stack>
      </dialog>
    </Form>
  );
}

function PreviewBody({ preview }: { preview: Preview }) {
  const envRows = Object.entries(preview.launch.env).map(([key, value]) => ({ key, value }));
  return (
    <Stack>
      <div>
        <Muted>Command</Muted>
        <Pre>{[preview.launch.command, ...preview.launch.args].join(" ")}</Pre>
      </div>
      {preview.launch.cwd && (
        <div>
          <Muted>Working directory</Muted>
          <Pre>{preview.launch.cwd}</Pre>
        </div>
      )}
      <div>
        <Muted>Environment ({envRows.length})</Muted>
        <Table
          columns={[
            { header: "Key", render: (r) => <Code>{r.key}</Code> },
            { header: "Value", render: (r) => <Code>{r.value}</Code> },
          ]}
          rows={envRows}
          getKey={(r) => r.key}
          empty={<Muted>No extra env.</Muted>}
        />
      </div>
      {preview.ephemeralFiles.map((f) => (
        <div key={f.rel}>
          <Muted>{f.rel} (ephemeral, 0600)</Muted>
          <Pre>{f.content}</Pre>
        </div>
      ))}
      {preview.routes.length > 0 && (
        <div>
          <Muted>Routes</Muted>
          {preview.routes.map((sentence) => (
            <div key={sentence}><Muted>{sentence}</Muted></div>
          ))}
        </div>
      )}
      {preview.proxy ? (
        <Notice tone="info">
          Launches via the proxy — route edits apply to the next request, even in a running session.
        </Notice>
      ) : (
        <Notice tone="warn">Direct launch — bypasses the proxy (no failover, routes or traffic).</Notice>
      )}
    </Stack>
  );
}
