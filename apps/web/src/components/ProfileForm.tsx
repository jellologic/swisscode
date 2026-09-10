import { useEffect, useRef, useState } from "react";
import {
  BASE_ROUTE_KEY,
  EFFORT_LEVELS,
  MODEL_ID_RE,
  PERMISSION_MODES,
  SETTING_SOURCES,
  type ClaudeSessionOptions,
  type FieldDef,
  type ModelRouteLabels,
  type Profile,
} from "@swisscode/core";
import {
  Button,
  Check,
  Code,
  Combobox,
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
import type { ComboColumn } from "../design";
import { previewLaunchFn, proxyReportFn, saveProfileFn } from "../lib/functions";
import { ModelField, useProviderModels } from "./ModelPicker";
import {
  SUBSCRIPTION_KNOWN_MODELS,
  destinationOptions,
  effectiveMapping,
  routeToRow,
  rowToRoute,
  type DestinationOption,
  type RouteFormRow,
} from "./routeSummary";

type Preview = Awaited<ReturnType<typeof previewLaunchFn>>;

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
  providers: {
    id: string;
    displayName: string;
    fields: FieldDef[];
    accountCapabilities?: { modelCatalog?: boolean };
  }[];
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

const destColumns: ComboColumn<DestinationOption>[] = [
  {
    key: "dest",
    header: "Destination",
    sortValue: (o) => o.label,
    render: (o) => <span className="sw-combo-primary">{o.label}</span>,
  },
  {
    key: "backend",
    header: "Backend",
    sortValue: (o) => o.kind,
    render: (o) => <span className="sw-combo-sub">{o.kind}</span>,
  },
];

interface ModelChoice {
  id: string;
  source: string;
}

const modelChoiceColumns: ComboColumn<ModelChoice>[] = [
  {
    key: "model",
    header: "Model",
    sortValue: (m) => m.id,
    render: (m) => <span className="sw-combo-primary">{m.id}</span>,
  },
  {
    key: "source",
    header: "Source",
    sortValue: (m) => m.source,
    render: (m) => <span className="sw-combo-sub">{m.source}</span>,
  },
];

/**
 * Backend picker shared by the default and every override row: profile base,
 * vault accounts, stored key accounts — plus per-key-provider manual entries
 * for the default (routes must point at a real account). Same `dest` string
 * encoding everywhere, so rows and the default round-trip identically.
 */
function DestinationPicker(props: {
  value: string;
  onChange: (value: string) => void;
  subscriptionAccounts: { id: string; label: string }[];
  keyAccounts: { id: string; label: string; providerId: string }[];
  providerDisplayName: (providerId: string) => string | undefined;
  /** Key providers that accept manual entry (default only, never rows). */
  manualProviders?: { id: string; displayName: string }[];
  placeholder?: string;
}) {
  const items: DestinationOption[] = [
    ...(props.manualProviders ?? []).map((p) => ({
      value: `provider:${p.id}`,
      label: `${p.displayName} (manual entry)`,
      kind: p.displayName,
    })),
    ...destinationOptions(
      props.subscriptionAccounts,
      props.keyAccounts,
      props.providerDisplayName,
    ),
  ];
  const known = new Set(items.map((o) => o.value));
  return (
    <Combobox
      value={known.has(props.value) ? props.value : ""}
      // A typed-then-blurred label maps back to its encoding; anything else
      // passes through to validation (rowProblem flags unknown backends).
      onChange={(text) => props.onChange(items.find((o) => o.label === text)?.value ?? text)}
      items={items}
      getKey={(o) => o.value}
      // The closed input reads "E2E key (main)", never "key:openrouter:main".
      displayValue={(v, list) => list.find((o) => o.value === v)?.label}
      searchText={(o) => `${o.label} ${o.kind} ${o.value}`}
      columns={destColumns}
      placeholder={props.placeholder ?? "Pick a backend…"}
      statusText={`${items.length} backends`}
      emptyText="No matches — pick from the list."
    />
  );
}

/**
 * What the provider APIs actually report, first: live catalog ids, then
 * recently-seen traffic ids, then the form's own entries, then the curated
 * fallback. First source wins per id; free text is always kept.
 */
function matchChoices(
  apiSources: { ids: string[]; source: string }[],
  recentIds: string[],
  formIds: string[],
): ModelChoice[] {
  const seen = new Set<string>();
  const out: ModelChoice[] = [];
  const add = (id: string, source: string) => {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push({ id: trimmed, source });
  };
  for (const { ids, source } of apiSources) for (const id of ids) add(id, source);
  for (const id of recentIds) add(id, "Recently seen");
  for (const id of formIds) add(id, "This form");
  for (const id of SUBSCRIPTION_KNOWN_MODELS) add(id, "Curated list");
  return out;
}

/** Create/edit form for one profile. Saves via saveProfileFn, toasts, then onSaved. */
export function ProfileForm(props: ProfileFormProps) {
  const [form, setForm] = useState<ProfileFormState>(props.initial ?? emptyProfileForm);
  const [error, setError] = useState<string | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [recentModels, setRecentModels] = useState<string[]>([]);
  const [routesActive, setRoutesActive] = useState((props.initial?.routes.length ?? 0) > 0);
  const [preview, setPreview] = useState<{ loading: boolean; error?: string; data?: Preview } | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  // First stored Meta account funds the key-gated catalog; without one the
  // Meta section stays empty and free text still works.
  const metaAccountId = props.keyAccounts.find((a) => a.providerId === "meta")?.id;
  const openrouterCatalog = useProviderModels("openrouter", routesActive);
  const metaCatalog = useProviderModels("meta", routesActive, metaAccountId);

  // Editing a profile that already has routes: suggestions needed immediately.
  useEffect(() => {
    if ((props.initial?.routes.length ?? 0) > 0) void loadRecentModels();
    // Once on mount — loadRecentModels self-guards against refetching.
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
    } else if (row.dest.startsWith("subscription:")) {
      const id = row.dest.slice("subscription:".length);
      if (id && !vaultIds.has(id)) return "Unknown vault account — pick one from the list.";
    } else {
      return "Unknown destination — pick a backend from the list.";
    }
    const upstream = row.upstreamModel.trim();
    if (upstream && !MODEL_ID_RE.test(upstream)) {
      return "Upstream model must be a vendor model id — or blank for same-as-requested.";
    }
    return null;
  }

  const rowProblems = form.routes.map((row, i) => rowProblem(row, i));

  const providerDisplayName = (id: string) =>
    props.providers.find((p) => p.id === id)?.displayName;
  const manualProviders = props.providers.filter((p) => p.id !== "claude-subscription");
  const defaultDest =
    form.providerId === "claude-subscription"
      ? `subscription:${form.subscriptionAccountId}`
      : form.providerAccountId
        ? `key:${form.providerId}:${form.providerAccountId}`
        : `provider:${form.providerId}`;

  /** Default picker commits: listed backends apply, free text is ignored. */
  function applyDefaultDest(value: string) {
    if (value.startsWith("key:")) {
      const rest = value.slice("key:".length);
      const sep = rest.indexOf(":");
      setForm((f) => ({
        ...f,
        providerId: rest.slice(0, sep),
        providerAccountId: rest.slice(sep + 1),
        subscriptionAccountId: "",
      }));
    } else if (value.startsWith("provider:")) {
      setForm((f) => ({
        ...f,
        providerId: value.slice("provider:".length),
        providerAccountId: "",
        subscriptionAccountId: "",
      }));
    } else if (value.startsWith("subscription:")) {
      setForm((f) => ({
        ...f,
        providerId: "claude-subscription",
        subscriptionAccountId: value.slice("subscription:".length),
        providerAccountId: "",
      }));
    }
  }

  /** The default must name a real backend — stale refs can't sneak through. */
  function defaultDestProblem(): string | null {
    if (defaultDest.startsWith("provider:")) {
      return manualProviders.some((p) => p.id === defaultDest.slice("provider:".length))
        ? null
        : "Unknown default backend — pick one from the list.";
    }
    if (defaultDest.startsWith("key:")) {
      return keyIds.has(defaultDest.slice("key:".length))
        ? null
        : "Unknown default backend — pick one from the list.";
    }
    if (defaultDest.startsWith("subscription:")) {
      const id = defaultDest.slice("subscription:".length);
      return id === "" || vaultIds.has(id)
        ? null
        : "Unknown default backend — pick one from the list.";
    }
    return "Unknown default backend — pick one from the list.";
  }

  function defaultBackendSentence(): string {
    const providerName = provider?.displayName ?? form.providerId;
    const account =
      form.providerId === "claude-subscription"
        ? form.subscriptionAccountId
          ? (props.subscriptionAccounts.find((a) => a.id === form.subscriptionAccountId)?.label ??
            form.subscriptionAccountId)
          : "current Claude Code login"
        : form.providerAccountId
          ? (storedForProvider.find((a) => a.id === form.providerAccountId)?.label ??
            form.providerAccountId)
          : "manual entry below";
    return `Everything else → ${providerName} via ${account} (${form.model.trim() || "provider default"})`;
  }

  const formMatchIds = form.routes.map((r) => r.match);
  const matchItems = matchChoices(
    [
      ...(openrouterCatalog.data
        ? [{ ids: openrouterCatalog.data.models.map((m) => m.id), source: "OpenRouter API" }]
        : []),
      ...(metaCatalog.data
        ? [{ ids: metaCatalog.data.models.map((m) => m.id), source: "Meta API" }]
        : []),
    ],
    recentModels,
    formMatchIds,
  );
  const catalogHint = [openrouterCatalog.error, metaCatalog.error]
    .filter(Boolean)
    .join(" · ");

  /** Upstream options follow the ROW's destination, not the default. */
  function upstreamItemsFor(dest: string): ModelChoice[] {
    const uniq = (items: ModelChoice[]): ModelChoice[] => [
      ...new Map(items.map((m) => [m.id, m])).values(),
    ];
    if (dest.startsWith("key:")) {
      const pid = dest.slice("key:".length).split(":")[0];
      if (pid === "openrouter" && openrouterCatalog.data) {
        return uniq(openrouterCatalog.data.models.map((m) => ({ id: m.id, source: "OpenRouter API" })));
      }
      if (pid === "meta" && metaCatalog.data) {
        return uniq(metaCatalog.data.models.map((m) => ({ id: m.id, source: "Meta API" })));
      }
      return uniq(recentModels.map((id) => ({ id, source: "Recently seen" })));
    }
    return matchItems;
  }

  /** Model ids the proxy has actually seen (route grain), for suggestions. */
  async function loadRecentModels() {
    try {
      const report = await proxyReportFn({ data: {} });
      setRecentModels(
        (report.byRoute ?? []).map((r) => r.key).filter((k) => k && k !== BASE_ROUTE_KEY),
      );
    } catch {
      setRecentModels([]);
    }
  }

  /** First open of the routes section: catalog hooks fire, traffic loads. */
  function activateRoutes() {
    setRoutesActive(true);
    void loadRecentModels();
  }

  function updateRoute(index: number, patch: Partial<RouteFormRow>) {
    setForm((f) => ({ ...f, routes: f.routes.map((r, i) => (i === index ? { ...r, ...patch } : r)) }));
    // A fixed row should not keep wearing its old save-time verdict.
    setError(null);
  }

  function buildProfile(): Profile | null {
    const defaultProblem = defaultDestProblem();
    if (defaultProblem) {
      setError(defaultProblem);
      return null;
    }
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

  const mapping = effectiveMapping(form.routes, labels, defaultBackendSentence());

  const routesBody = (
    <Stack>
      <Muted>
        Send different models to different backends inside one session. Matching is
        exact (<Code>claude-opus-4</Code> does not match <Code>claude-opus-4-1</Code>) and
        first-row-wins; anything unmatched uses the default backend above.
      </Muted>
      {catalogHint && (
        <Muted>API model lists unavailable ({catalogHint}) — recent + curated still work.</Muted>
      )}
      {form.routes.length > 0 && (
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <div style={{ flex: "2 1 160px" }}><Muted>Match (model id)</Muted></div>
          <div style={{ flex: "3 1 220px" }}><Muted>Destination</Muted></div>
          <div style={{ flex: "2 1 160px" }}><Muted>Upstream model</Muted></div>
          <div style={{ flex: "0 0 40px" }} />
        </div>
      )}
      {form.routes.map((row, i) => {
        const problem = rowProblems[i];
        const upstreamItems = upstreamItemsFor(row.dest);
        return (
          <div key={i}>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ flex: "2 1 160px" }}>
                <Combobox
                  value={row.match}
                  onChange={(value) => updateRoute(i, { match: value })}
                  items={matchItems}
                  getKey={(m) => m.id}
                  searchText={(m) => `${m.id} ${m.source}`}
                  columns={modelChoiceColumns}
                  placeholder="claude-opus-5"
                  statusText={`${matchItems.length} models`}
                  emptyText="No matches — custom value kept."
                />
              </div>
              <div style={{ flex: "3 1 220px" }}>
                <DestinationPicker
                  value={row.dest}
                  onChange={(value) => updateRoute(i, { dest: value })}
                  subscriptionAccounts={props.subscriptionAccounts}
                  keyAccounts={props.keyAccounts}
                  providerDisplayName={providerDisplayName}
                />
              </div>
              <div style={{ flex: "2 1 160px" }}>
                <Combobox
                  value={row.upstreamModel}
                  onChange={(value) => updateRoute(i, { upstreamModel: value })}
                  items={upstreamItems}
                  getKey={(m) => m.id}
                  searchText={(m) => `${m.id} ${m.source}`}
                  columns={modelChoiceColumns}
                  placeholder="same as requested"
                  statusText={upstreamItems.length > 0 ? `${upstreamItems.length} models` : "free text"}
                  emptyText="No matches — custom value kept."
                />
              </div>
              <Button type="button" onClick={() => setForm((f) => ({ ...f, routes: f.routes.filter((_, j) => j !== i) }))}>
                ×
              </Button>
            </div>
            {problem && <Notice tone="danger">{problem}</Notice>}
          </div>
        );
      })}
      <RowActions>
        <Button
          type="button"
          disabled={form.direct}
          onClick={() => {
            setForm((f) => ({
              ...f,
              routes: [...f.routes, { match: "", dest: "subscription:", upstreamModel: "" }],
            }));
          }}
        >
          + Add override
        </Button>
        {(openrouterCatalog.loading || metaCatalog.loading) && routesActive && (
          <Muted>Loading API models…</Muted>
        )}
      </RowActions>
      {form.direct ? (
        <Notice tone="warn">Direct launch — bypasses the proxy (no failover, overrides or traffic).</Notice>
      ) : (
        <Stack>
          <Muted>Effective mapping</Muted>
          {mapping.map((m) => (
            <div key={m.sentence}>
              {m.kind === "duplicate" ? (
                <Notice tone="danger">{m.sentence} — never fires, the first row wins.</Notice>
              ) : (
                <Muted>{m.sentence}</Muted>
              )}
            </div>
          ))}
          <Notice tone="info">
            This profile always launches via the proxy (<Code>swisscode proxy run</Code> must be
            up). Edits apply to the next request — even in a running session.
          </Notice>
        </Stack>
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
      <Field
        label="Default backend"
        hint="Catches every model with no override below — vault, stored keys, or manual entry in one list."
      >
        <DestinationPicker
          value={defaultDest}
          onChange={applyDefaultDest}
          subscriptionAccounts={props.subscriptionAccounts}
          keyAccounts={props.keyAccounts}
          providerDisplayName={providerDisplayName}
          manualProviders={manualProviders}
        />
      </Field>
      {/* Inline keys for manual entry. The provider's `model` field is skipped:
          profile.model wins at launch on every provider, so the dedicated
          Default model picker below is the one place to set it. */}
      {(!form.providerAccountId || form.providerId === "claude-subscription") &&
        provider?.fields.filter((f) => f.key !== "model").map((f) => (
          <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`} hint={f.help}>
            <Input
              type={f.secret ? "password" : "text"}
              value={form.config[f.key] ?? ""}
              onChange={setConfig(f.key)}
              placeholder={f.placeholder ?? ""}
            />
          </Field>
        ))}
      {provider?.accountCapabilities?.modelCatalog === true ? (
        <ModelField
          providerId={form.providerId}
          label="Default model"
          hint="Used for any model with no override below."
          value={form.model}
          placeholder="provider default"
          showEndpoints={form.providerId === "openrouter"}
          accountId={form.providerAccountId || undefined}
          onChange={(value) => setForm((f) => ({ ...f, model: value }))}
        />
      ) : (
        <Field
          label="Default model"
          hint="Used for any model with no override below."
        >
          <Input value={form.model} onChange={set("model")} placeholder="provider default" />
        </Field>
      )}
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
      <Check
        checked={form.direct}
        onChange={(v) => setForm((f) => ({ ...f, direct: v }))}
      >
        Bypass the proxy <Muted>(advanced — loses failover, model overrides and traffic inspection)</Muted>
      </Check>
      {form.routes.length > 0 ? (
        <Section title="Model overrides">{routesBody}</Section>
      ) : (
        <Disclosure summary="Model overrides (none)" onOpen={activateRoutes}>{routesBody}</Disclosure>
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
          {preview?.data && <PreviewBody preview={preview.data} fallback={defaultBackendSentence()} />}
          <RowActions>
            <Button type="button" onClick={() => dialogRef.current?.close()}>Close</Button>
          </RowActions>
        </Stack>
      </dialog>
    </Form>
  );
}

function PreviewBody({ preview, fallback }: { preview: Preview; fallback?: string }) {
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
      {(preview.routes.length > 0 || fallback) && (
        <div>
          <Muted>Effective mapping</Muted>
          {fallback && <div><Muted>{fallback}</Muted></div>}
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
