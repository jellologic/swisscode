import { useEffect, useState } from "react";
import type { ModelEndpoint, ProviderModel } from "@swisscode/core";
import {
  Code,
  Combobox,
  Disclosure,
  Field,
  Input,
  Muted,
  Notice,
  Stack,
  Table,
} from "../design";
import type { Column, ComboColumn } from "../design";
import { providerModelEndpointsFn, providerModelsFn } from "../lib/functions";

/** snake_case keys ("seven_day_opus", codenames) read better with spaces. */
export function prettify(key: string): string {
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
export function ModelField(props: {
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

/** "12 min ago" style relative time for cache staleness. Shared with usage cells. */
export function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
}
