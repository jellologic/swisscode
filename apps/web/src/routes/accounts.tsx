import { useEffect, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import type { ModelEndpoint, ProviderModel } from "@swisscode/core";
import {
  Badge,
  Button,
  Card,
  Code,
  Column,
  Combobox,
  Disclosure,
  Field,
  Form,
  Input,
  Meter,
  Muted,
  Notice,
  Page,
  RowActions,
  Select,
  Stack,
  Table,
} from "../design";
import type { ComboColumn } from "../design";
import {
  accountUsageFn,
  catalogFn,
  currentLoginFn,
  importAccountFn,
  listAccountsFn,
  listProviderAccountsFn,
  providerModelEndpointsFn,
  providerModelsFn,
  providerUsageFn,
  proxyStateFn,
  proxyUseFn,
  removeAccountFn,
  removeProviderAccountFn,
  renameSubscriptionAccountFn,
  saveProviderAccountFn,
  switchSubscriptionFn,
  updateProviderAccountFn,
} from "../lib/functions";

export const Route = createFileRoute("/accounts")({
  loader: async () => {
    const catalog = await catalogFn();
    const keyed = catalog.providers.filter((p) => p.id !== "claude-subscription");
    return {
      catalog,
      login: await currentLoginFn(),
      subs: await listAccountsFn(),
      subUsage: await accountUsageFn({ data: {} }),
      proxy: await proxyStateFn(),
      generic: await listProviderAccountsFn({ data: {} }),
      genericUsage: Object.fromEntries(
        await Promise.all(
          keyed
            .filter((p) => p.accountCapabilities.usageMetrics)
            .map(async (p) => [p.id, await providerUsageFn({ data: { providerId: p.id } })]),
        ),
      ) as Record<string, { results: { accountId: string; metrics?: { label: string; value: string }[]; error?: string }[] }>,
    };
  },
  component: AccountsPage,
});

interface EditState {
  kind: "sub" | "generic";
  providerId: string;
  id: string;
  label: string;
  values: Record<string, string>;
}

/** snake_case keys ("seven_day_opus", codenames) read better with spaces. */
function prettify(key: string): string {
  return key.replace(/_/g, " ");
}

interface ModelsData {
  models: ProviderModel[];
  fetchedAt: string;
  stale: boolean;
}

interface EndpointsData {
  endpoints: ModelEndpoint[];
  fetchedAt: string;
  stale: boolean;
}

/** 1000000 → "1M", 200000 → "200K". */
function fmtTokens(n?: number): string {
  if (n === undefined) return "—";
  const trim = (x: number) => String(Number(x.toFixed(1)));
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1000) return `${trim(n / 1000)}K`;
  return String(n);
}

/** USD per 1M tokens, or "free" when the provider charges nothing. */
function fmtPerMillion(n?: number): string {
  if (n === undefined) return "—";
  if (n === 0) return "free";
  return `$${n.toFixed(2)}`;
}

/** "anthropic" / "open-ai" → "anthropic" / "open ai". */
function prettifySlug(slug?: string): string {
  return slug ? slug.replace(/[-_]/g, " ") : "—";
}

/** Live model list for a provider with a catalog; cached server-side. */
function useProviderModels(providerId: string | undefined, enabled: boolean) {
  const [state, setState] = useState<{ data?: ModelsData; loading: boolean; error?: string }>({
    loading: false,
  });
  useEffect(() => {
    if (!enabled || !providerId) return;
    let cancelled = false;
    setState({ loading: true });
    providerModelsFn({ data: { providerId } }).then(
      (data) => {
        if (!cancelled) setState({ data, loading: false });
      },
      (err) => {
        if (!cancelled) {
          setState({ loading: false, error: err instanceof Error ? err.message : String(err) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [providerId, enabled]);
  return state;
}

const modelColumns: ComboColumn<ProviderModel>[] = [
  {
    key: "model",
    header: "Model",
    sortValue: (m) => m.name ?? m.id,
    render: (m) =>
      m.name ? (
        <>
          <span className="sw-combo-primary">{m.name}</span>
          <span className="sw-combo-sub">{m.id}</span>
        </>
      ) : (
        <span className="sw-combo-primary">{m.id}</span>
      ),
  },
  {
    key: "creator",
    header: "Creator",
    render: (m) => prettifySlug(m.creator),
    sortValue: (m) => m.creator,
  },
  {
    key: "released",
    header: "Released",
    render: (m) => m.created?.slice(0, 10) ?? "—",
    sortValue: (m) => m.created,
  },
  {
    key: "context",
    header: "Context",
    align: "right",
    render: (m) => fmtTokens(m.contextLength),
    sortValue: (m) => m.contextLength,
  },
  {
    key: "maxout",
    header: "Max out",
    align: "right",
    render: (m) => fmtTokens(m.maxCompletionTokens),
    sortValue: (m) => m.maxCompletionTokens,
  },
  {
    key: "in",
    header: "In $/1M",
    align: "right",
    render: (m) => fmtPerMillion(m.promptPerMillion),
    sortValue: (m) => m.promptPerMillion,
  },
  {
    key: "out",
    header: "Out $/1M",
    align: "right",
    render: (m) => fmtPerMillion(m.completionPerMillion),
    sortValue: (m) => m.completionPerMillion,
  },
  {
    key: "modalities",
    header: "Inputs",
    render: (m) => (m.inputModalities ? m.inputModalities.join(" + ") : "—"),
    sortValue: (m) => m.inputModalities?.join(" + "),
  },
];

const endpointColumns: Column<ModelEndpoint>[] = [
  {
    header: "Provider",
    render: (e) =>
      e.tag ? (
        <>
          <strong>{e.provider}</strong> <Code>{e.tag}</Code>
        </>
      ) : (
        <strong>{e.provider}</strong>
      ),
  },
  { header: "Quant", render: (e) => <Muted>{e.quantization ?? "—"}</Muted> },
  { header: "Context", render: (e) => <Muted>{fmtTokens(e.contextLength)}</Muted> },
  { header: "Max out", render: (e) => <Muted>{fmtTokens(e.maxCompletionTokens)}</Muted> },
  { header: "In $/1M", render: (e) => <Muted>{fmtPerMillion(e.promptPerMillion)}</Muted> },
  { header: "Out $/1M", render: (e) => <Muted>{fmtPerMillion(e.completionPerMillion)}</Muted> },
  {
    header: "Up 1d",
    render: (e) => <Muted>{e.uptime1d !== undefined ? `${e.uptime1d.toFixed(1)}%` : "—"}</Muted>,
  },
];

/**
 * Serving providers for the selected model, loaded lazily when opened.
 * Read-only compare: launches can't pin a serving provider (OpenRouter
 * routes automatically), so this informs model choice, not launch config.
 */
function ModelEndpoints(props: { providerId: string; modelId: string }) {
  const [state, setState] = useState<{ data?: EndpointsData; loading: boolean; error?: string }>({
    loading: false,
  });
  function load() {
    if (state.data || state.loading) return;
    setState({ loading: true });
    providerModelEndpointsFn({ data: { providerId: props.providerId, modelId: props.modelId } }).then(
      (data) => setState({ data, loading: false }),
      (err) => setState({ loading: false, error: err instanceof Error ? err.message : String(err) }),
    );
  }
  return (
    <Disclosure
      summary={<>Serving providers{state.data ? ` (${state.data.endpoints.length})` : ""}</>}
      onOpen={load}
    >
      {state.loading && <Muted>Loading providers…</Muted>}
      {state.error && <Notice tone="danger">{state.error}</Notice>}
      {state.data && (
        <Stack>
          <Table
            columns={endpointColumns}
            rows={state.data.endpoints}
            getKey={(e) => `${e.provider}::${e.tag ?? ""}`}
            empty={<Muted>No serving providers listed.</Muted>}
          />
          <Muted>
            {state.data.stale ? `As of ${ago(state.data.fetchedAt)} — upstream failed. ` : ""}
            Informational: launches can&apos;t pin a serving provider; OpenRouter routes
            automatically. Compare price, quantization, and context here.
          </Muted>
        </Stack>
      )}
    </Disclosure>
  );
}

/**
 * Search + table combobox over the provider's model catalog. Free-text values
 * are kept (custom ids still allowed). Used for `model` fields on catalog
 * providers.
 */
function ModelField(props: {
  providerId: string;
  label: string;
  hint?: string;
  value: string;
  placeholder?: string;
  showEndpoints: boolean;
  onChange: (value: string) => void;
}) {
  const { data, loading, error } = useProviderModels(props.providerId, true);
  const status = loading
    ? "Loading models…"
    : error
      ? `Model list unavailable (${error})`
      : data
        ? `${data.models.length} models${data.stale ? ` · as of ${ago(data.fetchedAt)}` : ""}`
        : "";
  const selected = data?.models.find((m) => m.id === props.value);
  return (
    <Field label={props.label} hint={[props.hint, status].filter(Boolean).join(" · ") || undefined}>
      {data ? (
        <Combobox
          value={props.value}
          onChange={props.onChange}
          items={data.models}
          getKey={(m) => m.id}
          searchText={(m) => `${m.id} ${m.name ?? ""} ${m.creator ?? ""}`}
          columns={modelColumns}
          placeholder={props.placeholder ?? ""}
          statusText={`${data.models.length} models`}
          emptyText="No matches — custom value kept."
        />
      ) : (
        <Input
          type="text"
          value={props.value}
          placeholder={props.placeholder ?? ""}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
      {selected && props.showEndpoints && (
        <ModelEndpoints providerId={props.providerId} modelId={selected.id} />
      )}
    </Field>
  );
}

/** "12 min ago" style relative time for cache staleness. */
function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}

type AccountRow =
  | { kind: "sub"; id: string; label: string; detail: string }
  | { kind: "generic"; providerId: string; id: string; label: string; config: Record<string, string> };

function AccountsPage() {
  const { catalog, login, subs, subUsage, proxy, generic, genericUsage } = Route.useLoaderData();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<{ id: string; otherSessions: number } | null>(null);
  const [addProvider, setAddProvider] = useState(catalog.providers[0]?.id ?? "");
  const [addId, setAddId] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addValues, setAddValues] = useState<Record<string, string>>({});

  const providerById = new Map(catalog.providers.map((p) => [p.id, p]));
  const subUsageById = new Map(subUsage.results.flatMap((r) => (r.usage ? [[r.usage.accountId, r.usage]] : [])));
  const subErrors = subUsage.results.flatMap((r) => (r.error ? [r.error] : []));
  const addSpec = providerById.get(addProvider);
  const caps = providerById.get("claude-subscription")?.accountCapabilities;

  async function refresh() {
    setEditing(null);
    setPendingSwitch(null);
    await router.invalidate();
  }

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const rows: AccountRow[] = [
    ...subs.accounts.map((a): AccountRow => ({
      kind: "sub", id: a.id, label: a.label, detail: a.email ?? "—",
    })),
    ...generic.accounts.map((a): AccountRow => ({
      kind: "generic", providerId: a.providerId, id: a.id, label: a.label, config: a.config,
    })),
  ];

  const columns: Column<AccountRow>[] = [
    {
      header: "Account",
      render: (r) => <><strong>{r.label}</strong> <Code>{r.id}</Code></>,
    },
    {
      header: "Provider",
      render: (r) => (
        <Badge tone={r.kind === "sub" ? "info" : "neutral"}>
          {r.kind === "sub" ? "Claude Subscription" : (providerById.get(r.providerId)?.displayName ?? r.providerId)}
        </Badge>
      ),
    },
    {
      header: "Details",
      render: (r) =>
        r.kind === "sub" ? (
          <Muted>{r.detail}</Muted>
        ) : (
          <>
            {Object.entries(r.config).map(([k, v]) => (
              <span key={k}><Code>{k}</Code>: <Code>{v}</Code><br /></span>
            ))}
          </>
        ),
    },
    {
      header: "Usage",
      render: (r) => {
        if (r.kind === "sub") {
          const u = subUsageById.get(r.id);
          if (!u) return <Muted>unavailable</Muted>;
          return (
            <Stack>
              {u.stale && (
                <Badge tone="warn">as of {ago(u.fetchedAt)} — rate-limited</Badge>
              )}
              <Meter label="5h" value={u.fiveHour?.utilization} hint={u.fiveHour?.resetsAt ? `resets ${u.fiveHour.resetsAt}` : undefined} />
              <Meter label="7d" value={u.sevenDay?.utilization} hint={u.sevenDay?.resetsAt ? `resets ${u.sevenDay.resetsAt}` : undefined} />
              {u.models && Object.entries(u.models).map(([model, window]) => (
                <Meter key={model} label={prettify(model)} value={window.utilization} hint={window.resetsAt ? `resets ${window.resetsAt}` : undefined} />
              ))}
              {u.scoped?.map((entry) => (
                <Meter key={entry.name} label={entry.name} value={entry.utilization} hint={entry.resetsAt ? `resets ${entry.resetsAt}` : undefined} />
              ))}
              {u.windows?.map((window) => (
                <Meter key={window.key} label={prettify(window.key)} value={window.utilization} hint={window.resetsAt ? `resets ${window.resetsAt}` : undefined} />
              ))}
              {u.spend && (
                <Muted>
                  Extra usage ${u.spend.used.toFixed(2)}
                  {u.spend.limit !== null ? ` of $${u.spend.limit.toFixed(2)}` : " (no cap)"}
                </Muted>
              )}
            </Stack>
          );
        }
        const metrics = genericUsage[r.providerId]?.results.find((x) => x.accountId === r.id);
        if (metrics?.metrics) return <Muted>{metrics.metrics.map((m) => `${m.label}: ${m.value}`).join(" · ")}</Muted>;
        return <Muted>{metrics?.error ?? "—"}</Muted>;
      },
    },
    {
      header: "Actions",
      render: (r) => {
        if (r.kind === "sub") {
          const canProxy = caps?.switchVia.includes("proxy") && proxy.running && proxy.activeAccountId !== r.id;
          const canSwap = caps?.switchVia.includes("file-swap") && login.login?.matchedAccountId !== r.id;
          const confirming = pendingSwitch?.id === r.id;
          return (
            <RowActions>
              {canProxy && (
                <Button size="sm" onClick={() => run(() => proxyUseFn({ data: { id: r.id } }))}>
                  Use via proxy
                </Button>
              )}
              {canSwap && !confirming && (
                <Button size="sm" onClick={() => void doSwitch(r.id, false)}>Make system active</Button>
              )}
              {confirming && (
                <span>
                  <Muted>{pendingSwitch.otherSessions} session(s) move too.</Muted>{" "}
                  <Button size="sm" variant="primary" onClick={() => void doSwitch(r.id, true)}>Switch anyway</Button>{" "}
                  <Button size="sm" variant="ghost" onClick={() => setPendingSwitch(null)}>Cancel</Button>
                </span>
              )}
              <Button size="sm" variant="ghost" onClick={() => run(() => importAccountFn({ data: { id: r.id, overwrite: true } }))}>
                Re-import
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing({ kind: "sub", providerId: "claude-subscription", id: r.id, label: r.label, values: {} })}>
                Edit
              </Button>
              <Button size="sm" variant="danger" onClick={() => run(() => removeAccountFn({ data: { id: r.id } }))}>
                Remove
              </Button>
            </RowActions>
          );
        }
        return (
          <RowActions>
            <Button size="sm" variant="ghost" onClick={() => setEditing({ kind: "generic", providerId: r.providerId, id: r.id, label: r.label, values: {} })}>
              Edit
            </Button>
            <Button size="sm" variant="danger" onClick={() => run(() => removeProviderAccountFn({ data: { providerId: r.providerId, id: r.id } }))}>
              Remove
            </Button>
          </RowActions>
        );
      },
    },
  ];

  async function doSwitch(id: string, force: boolean) {
    setError(null);
    try {
      const result = await switchSubscriptionFn({ data: { id, force } });
      if (result.needsConfirm) {
        setPendingSwitch({ id, otherSessions: result.otherSessions ?? 0 });
      } else {
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Page title="Accounts" sub="Every AI account in one list. Secrets stay on the server.">
      <Stack>
        {login.login && (
          <Card>
            <h2>Current Claude Code login</h2>
            <p>Backend: <Code>{login.login.backend}</Code>{login.login.source ? <> (<Code>{login.login.source}</Code>)</> : null}</p>
            <p>Login: <Code>{login.login.email ?? "(email unavailable)"}</Code></p>
            <p><Muted>
              {login.login.matchedAccountId
                ? <>Matches stored account <Code>{login.login.matchedAccountId}</Code>.</>
                : "Not imported yet — snapshot it below to keep it."}
            </Muted></p>
          </Card>
        )}

        {proxy.running && (
          <p><Muted>Proxy running on <Code>:{proxy.port}</Code>, active account <Code>{proxy.activeAccountId ?? "(none)"}</Code>.</Muted></p>
        )}
        {!proxy.running && (
          <p><Muted>Proxy not running — start it with <Code>swisscode proxy run</Code>.</Muted></p>
        )}

        <Table
          columns={columns}
          rows={rows}
          getKey={(r) => `${r.kind}:${r.kind === "generic" ? r.providerId : "sub"}:${r.id}`}
          empty={<Muted>No accounts yet — add one below.</Muted>}
        />
        {subErrors.map((e) => (
          <Notice key={e} tone="danger">{e}</Notice>
        ))}
        {error && <Notice tone="danger">{error}</Notice>}

        {editing && (
          <Card>
            <h2>Edit {editing.id}</h2>
            <Form
              onSubmit={(e) => {
                e.preventDefault();
                if (editing.kind === "sub") {
                  void run(() => renameSubscriptionAccountFn({ data: { id: editing.id, label: editing.label } }));
                } else {
                  void run(() => updateProviderAccountFn({
                    data: { providerId: editing.providerId, id: editing.id, label: editing.label, config: editing.values },
                  }));
                }
              }}
            >
              <Field label="Label">
                <Input value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} />
              </Field>
              {editing.kind === "generic" &&
                (providerById.get(editing.providerId)?.fields ?? []).map((f) =>
                  f.key === "model" && providerById.get(editing.providerId)?.accountCapabilities.modelCatalog ? (
                    <ModelField
                      key={f.key}
                      providerId={editing.providerId}
                      label={f.label}
                      hint={f.help}
                      value={editing.values[f.key] ?? ""}
                      placeholder={f.placeholder}
                      showEndpoints={providerById.get(editing.providerId)?.accountCapabilities.modelEndpoints ?? false}
                      onChange={(v) => setEditing({ ...editing, values: { ...editing.values, [f.key]: v } })}
                    />
                  ) : (
                    <Field key={f.key} label={f.secret ? `${f.label} (blank keeps stored)` : f.label} hint={f.secret ? undefined : f.help}>
                      <Input
                        type={f.secret ? "password" : "text"}
                        value={editing.values[f.key] ?? ""}
                        placeholder={f.placeholder ?? ""}
                        onChange={(e) => setEditing({ ...editing, values: { ...editing.values, [f.key]: e.target.value } })}
                      />
                    </Field>
                  ),
                )}
              {editing.kind === "sub" && (
                <p><Muted>Credentials update via Re-import; only the label is editable here.</Muted></p>
              )}
              <RowActions>
                <Button variant="primary" type="submit">Save</Button>
                <Button variant="ghost" type="button" onClick={() => setEditing(null)}>Cancel</Button>
              </RowActions>
            </Form>
          </Card>
        )}

        <Card>
          <h2>Add account</h2>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              if (!addSpec) return;
              if (addSpec.accountCapabilities.importActive) {
                void run(() => importAccountFn({ data: { id: addId.trim(), label: addLabel.trim() || undefined } }));
              } else {
                void run(() => saveProviderAccountFn({
                  data: { providerId: addSpec.id, id: addId.trim(), label: addLabel.trim(), config: addValues },
                }));
              }
              setAddId("");
              setAddLabel("");
              setAddValues({});
            }}
          >
            <Field label="Provider">
              <Select
                value={addProvider}
                onChange={(e) => { setAddProvider(e.target.value); setAddValues({}); }}
              >
                {catalog.providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.displayName}</option>
                ))}
              </Select>
            </Field>
            {addSpec?.accountCapabilities.hint && <p><Muted>{addSpec.accountCapabilities.hint}</Muted></p>}
            <Field label="Account id">
              <Input value={addId} onChange={(e) => setAddId(e.target.value)} placeholder="personal" required />
            </Field>
            <Field label="Label" hint="Defaults to email / id.">
              <Input value={addLabel} onChange={(e) => setAddLabel(e.target.value)} />
            </Field>
            {addSpec && !addSpec.accountCapabilities.importActive &&
              addSpec.fields.map((f) =>
                f.key === "model" && addSpec.accountCapabilities.modelCatalog ? (
                  <ModelField
                    key={f.key}
                    providerId={addSpec.id}
                    label={`${f.label}${f.required ? " *" : ""}`}
                    hint={f.help}
                    value={addValues[f.key] ?? ""}
                    placeholder={f.placeholder}
                    showEndpoints={addSpec.accountCapabilities.modelEndpoints ?? false}
                    onChange={(v) => setAddValues({ ...addValues, [f.key]: v })}
                  />
                ) : (
                  <Field key={f.key} label={`${f.label}${f.required ? " *" : ""}`} hint={f.help}>
                    <Input
                      type={f.secret ? "password" : "text"}
                      value={addValues[f.key] ?? ""}
                      placeholder={f.placeholder ?? ""}
                      onChange={(e) => setAddValues({ ...addValues, [f.key]: e.target.value })}
                    />
                  </Field>
                ),
              )}
            <RowActions>
              <Button variant="primary" type="submit">
                {addSpec?.accountCapabilities.importActive ? "Import current login" : "Save account"}
              </Button>
            </RowActions>
          </Form>
        </Card>
      </Stack>
    </Page>
  );
}
