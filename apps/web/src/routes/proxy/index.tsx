import { useEffect, useState, type ReactNode } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Card,
  Check,
  Code,
  Column,
  Field,
  Input,
  Muted,
  Notice,
  Page,
  RowActions,
  Select,
  Stack,
  Table,
  notify,
} from "../../design";
import {
  proxyReportFn,
  proxyStateFn,
  proxyTrafficClearFn,
  proxyTrafficFn,
  proxyTrafficSizeFn,
} from "../../lib/functions";
import type { TrafficConversation } from "@swisscode/adapters";
import type { StoredTrafficExchange, SpendRow, TrafficRollupRow } from "@swisscode/core";
import { SPEND_ESTIMATE_NOTE, formatSpend } from "@swisscode/core";
import { ago } from "../../components/ModelPicker";
import { fmtBytes, fmtSpan, statusTone } from "../../components/TrafficEntryDetail";

export const Route = createFileRoute("/proxy/")({
  validateSearch: (search: Record<string, unknown>) => ({
    profile: typeof search["profile"] === "string" ? search["profile"] : "",
    route: typeof search["route"] === "string" ? search["route"] : "",
    since: typeof search["since"] === "string" ? search["since"] : "",
    until: typeof search["until"] === "string" ? search["until"] : "",
    // The router's default search parser JSON-coerces values, so a hand-typed
    // ?errorsOnly=1 arrives as the number 1 (and "true" as boolean true).
    errorsOnly:
      search["errorsOnly"] === "1" ||
      search["errorsOnly"] === 1 ||
      search["errorsOnly"] === "true" ||
      search["errorsOnly"] === true,
  }),
  loaderDeps: ({ search }) => ({
    profile: search.profile,
    route: search.route,
    since: search.since,
    until: search.until,
    errorsOnly: search.errorsOnly,
  }),
  loader: async ({ deps }) => ({
    proxy: await proxyStateFn(),
    traffic: await proxyTrafficFn({ data: { profile: deps.profile || undefined } }),
    // Store-backed history: one uncapped port query + core rollups on the
    // server (see getProxyReport). Re-runs on the live poll below — local
    // SQLite over a bounded retention, cheap enough to stay fresh.
    report: await proxyReportFn({
      data: {
        ...(deps.profile ? { profile: deps.profile } : {}),
        ...(deps.route ? { route: deps.route } : {}),
        ...(deps.since ? { since: deps.since } : {}),
        ...(deps.until ? { until: deps.until } : {}),
        ...(deps.errorsOnly ? { errorsOnly: true as const } : {}),
      },
    }),
  }),
  component: ProxyPage,
});

/** One rotation row on the proxy state card; the toggle itself lives in /settings. */
function rotationLine(rotation: NonNullable<Awaited<ReturnType<typeof proxyStateFn>>["rotation"]>): string {
  if (!rotation.enabled) return "Rotation off";
  if (rotation.lastRunAt === null) return `Rotation on (${rotation.strategy}) — waiting for first tick`;
  return `Rotation on (${rotation.strategy}) — checked ${rotation.checked} (${rotation.usable} usable), ${rotation.switched ?? "no switch"}: ${rotation.reason ?? "—"}`;
}

function ProxyPage() {
  const { proxy, traffic, report } = Route.useLoaderData();
  const search = Route.useSearch();
  const { profile } = search;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [keepInput, setKeepInput] = useState<string>(String(traffic.size));

  /** Filter navigation: one shareable URL carries every filter. */
  const go = (patch: Partial<typeof search>) =>
    void router.navigate({ to: "/proxy", search: { ...search, ...patch } });

  // Live view: re-run the loader every few seconds while the page is visible.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void router.invalidate();
    }, 2500);
    return () => clearInterval(id);
  }, [router]);

  useEffect(() => {
    setKeepInput(String(traffic.size));
  }, [traffic.size]);

  const entries = traffic.entries;

  // One row per conversation: turns never appear here, they live on the
  // thread page at /proxy/<threadId>. Threads sort by latest activity.
  const convLastTs = (conv: TrafficConversation): number =>
    Math.max(
      0,
      ...conv.indexes.map((i) => {
        const ts = Date.parse(entries[i]?.ts ?? "");
        return Number.isFinite(ts) ? ts : 0;
      }),
    );
  const rows: TrafficConversation[] = [...traffic.conversations].sort(
    (a, b) => convLastTs(b) - convLastTs(a),
  );

  const convTotals = (conv: TrafficConversation): { req: number; res: number; accounts: string[] } => {
    let req = 0;
    let res = 0;
    const accounts: string[] = [];
    for (const i of conv.indexes) {
      const e = entries[i];
      if (!e) continue;
      req += e.reqBytes;
      res += e.resBytes;
      if (e.accountId && !accounts.includes(e.accountId)) accounts.push(e.accountId);
    }
    return { req, res, accounts };
  };

  async function run(fn: () => Promise<unknown>, success?: string) {
    setError(null);
    try {
      await fn();
      if (success) notify.success(success);
      await router.invalidate();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      notify.error(message);
    }
  }

  const threadLink = (conv: TrafficConversation, label: ReactNode): ReactNode => (
    <Link
      to="/proxy/$threadId"
      params={{ threadId: conv.id }}
      search={search}
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </Link>
  );

  const renderThreadRequest = (conv: TrafficConversation): ReactNode => {
    const models = conv.models.length > 0 ? ` · ${conv.models.join(", ")}` : "";
    const launchNames = [...new Set(
      conv.agentLaunches.map((l) => l.agent).filter((a) => a !== "Task" && a !== "Agent"),
    )];
    const launched = conv.agentLaunches.length > 0
      ? ` · launched ${launchNames.length > 0 ? launchNames.join(", ") : "subagent"}`
      : "";
    const checks = conv.policyChecks.length > 0
      ? ` · ${conv.policyChecks.length} polic${conv.policyChecks.length === 1 ? "y check" : "y checks"}`
      : "";
    if (conv.turns <= 1) {
      // Solo request: its own one-turn thread.
      const entry = entries[conv.indexes[0]!];
      if (!entry) return <Muted>—</Muted>;
      return (
        <span>
          <Code>{entry.method}</Code> {threadLink(conv, entry.path)}{" "}
          <Muted>
            {conv.tools.slice(0, 3).join(", ")}
            {conv.tools.length > 3 ? ", …" : ""}
            {models}
          </Muted>
        </span>
      );
    }
    return (
      <span>
        {threadLink(
          conv,
          <Badge tone="info">
            thread · {conv.turns} turns
          </Badge>,
        )}{" "}
        <Muted>
          {conv.tools.slice(0, 3).join(", ")}
          {conv.tools.length > 3 ? ", …" : ""}
          {models}
          {launched}
          {checks}
        </Muted>
      </span>
    );
  };

  const columns: Column<TrafficConversation>[] = [
    {
      header: "Time",
      render: (conv) => {
        const ts = new Date(convLastTs(conv)).toISOString();
        return (
          <Muted>
            {new Date(ts).toLocaleTimeString()} · {ago(ts)}
          </Muted>
        );
      },
    },
    {
      header: "Request",
      render: (conv) => renderThreadRequest(conv),
    },
    {
      header: "Status",
      render: (conv) => (
        <>
          {conv.statuses.map((s) => (
            <span key={s}>
              <Badge tone={statusTone(s)}>{s}</Badge>{" "}
            </span>
          ))}
        </>
      ),
    },
    {
      header: "Account",
      render: (conv) => {
        const accounts = convTotals(conv).accounts;
        return accounts.length > 0 ? (
          <>
            {accounts.map((a) => (
              <span key={a}>
                <Code>{a}</Code>{" "}
              </span>
            ))}
          </>
        ) : (
          <Muted>—</Muted>
        );
      },
    },
    {
      header: "Profile",
      render: (conv) => {
        return conv.profiles.length > 0 ? (
          <>
            {conv.profiles.map((p) => (
              <span key={p}>
                <Badge tone="info">{p}</Badge>{" "}
              </span>
            ))}
          </>
        ) : (
          <Muted>untagged</Muted>
        );
      },
    },
    {
      header: "Size",
      render: (conv) => {
        const { req, res } = convTotals(conv);
        return (
          <Muted>
            ↑{fmtBytes(req)} ↓{fmtBytes(res)}
          </Muted>
        );
      },
    },
    {
      header: "Took",
      render: (conv) =>
        conv.turns <= 1 ? (
          <Muted>{entries[conv.indexes[0]!]?.ms ?? 0}ms</Muted>
        ) : (
          <Muted>
            {fmtSpan(conv.spanMs)} span · {fmtSpan(conv.upstreamMs)} upstream
          </Muted>
        ),
    },
  ];

  return (
    <Page
      title="Proxy traffic"
      sub="Claude Code runs through the proxy, grouped into threads. Open one for the full timeline. Auto-refreshes."
    >
      <Stack>
        {!proxy.running || !traffic.running ? (
          <Notice tone="warn">
            The proxy is not running. Start it with <Code>swisscode proxy run</Code> and point
            Claude Code at it with <Code>ANTHROPIC_BASE_URL</Code> — requests will appear here.
          </Notice>
        ) : (
          <>
            <Card>
              <Stack>
                <RowActions>
                  <span>
                    <Badge tone="success">live</Badge> Active account{" "}
                    <Code>{proxy.activeAccountId ?? "(none)"}</Code> · keeping{" "}
                    <strong>{traffic.kept}</strong> of last <strong>{traffic.size}</strong>
                  </span>
                  <span>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        run(async () => {
                          const r = await proxyTrafficClearFn();
                          notify.success(`Cleared ${r.cleared} entries`);
                        })
                      }
                    >
                      Clear
                    </Button>
                  </span>
                </RowActions>
                {proxy.rotation && (
                  <Muted>
                    {rotationLine(proxy.rotation)} · <Link to="/settings">change</Link>
                  </Muted>
                )}
                <RowActions>
                  <Field
                    label="Keep last N requests"
                    hint="Ring-buffer size on the running proxy (0 disables inspection)."
                  >
                    <Input
                      type="number"
                      min={0}
                      max={10000}
                      value={keepInput}
                      onChange={(e) => setKeepInput(e.target.value)}
                    />
                  </Field>
                  <Button
                    variant="primary"
                    onClick={() =>
                      run(async () => {
                        const n = Math.min(10000, Math.max(0, Math.floor(Number(keepInput) || 0)));
                        const r = await proxyTrafficSizeFn({ data: { size: n } });
                        notify.success(`Keeping last ${r.size} requests`);
                      })
                    }
                  >
                    Apply
                  </Button>
                </RowActions>
              </Stack>
            </Card>

            <Card>
              <Stack>
                <RowActions>
                  <Field label="Profile" hint="Launches via swisscode <profile> tag their traffic.">
                    <Select value={profile} onChange={(e) => go({ profile: e.target.value })}>
                      <option value="">All profiles</option>
                      {traffic.profiles.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Route" hint="Exact route match both live and stored.">
                    <Input
                      value={search.route}
                      onChange={(e) => go({ route: e.target.value })}
                      placeholder="any route"
                    />
                  </Field>
                  <Field label="Since" hint="Stored history from this date.">
                    <Input type="date" value={search.since} onChange={(e) => go({ since: e.target.value })} />
                  </Field>
                  <Field label="Until" hint="Stored history before this date.">
                    <Input type="date" value={search.until} onChange={(e) => go({ until: e.target.value })} />
                  </Field>
                </RowActions>
                <RowActions>
                  <Check checked={search.errorsOnly} onChange={(v) => go({ errorsOnly: v })}>
                    Errors only
                  </Check>
                  {(profile || search.route || search.since || search.until || search.errorsOnly) && (
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() =>
                        go({ profile: "", route: "", since: "", until: "", errorsOnly: false })
                      }
                    >
                      Clear filters
                    </Button>
                  )}
                </RowActions>
                <Table
                  columns={columns}
                  rows={rows}
                  getKey={(conv) => conv.id}
                  empty={
                    profile ? (
                      <Muted>
                        No traffic tagged with profile “{profile}” yet — launch it with{" "}
                        <Code>swisscode {profile}</Code> through the proxy.
                      </Muted>
                    ) : (
                      <Muted>No proxied requests yet — use Claude Code through the proxy.</Muted>
                    )
                  }
                  onRowClick={(conv) => {
                    void router.navigate({
                      to: "/proxy/$threadId",
                      params: { threadId: conv.id },
                      search: search,
                    });
                  }}
                />
              </Stack>
            </Card>
          </>
        )}
        <HistoryCard report={report} />
        {error && <Notice tone="danger">{error}</Notice>}
      </Stack>
    </Page>
  );
}

function rollupColumns(label: string, spendByKey?: Map<string, number>): Column<TrafficRollupRow>[] {
  return [
    { header: label, render: (r) => <Code>{r.key}</Code> },
    { header: "Requests", render: (r) => <>{r.requests}</> },
    {
      header: "Errors",
      render: (r) => (
        <span>
          {r.errors > 0 ? <Badge tone="danger">{r.errors}</Badge> : <Muted>0</Muted>}{" "}
          <Muted>{(r.errorRate * 100).toFixed(1)}%</Muted>
        </span>
      ),
    },
    {
      header: "Tokens ↑↓",
      render: (r) => (
        <Muted>
          ↑{r.reqTokens.toLocaleString()} ↓{r.resTokens.toLocaleString()}
        </Muted>
      ),
    },
    {
      header: "p50 / p95",
      render: (r) => (
        <Muted>
          {r.p50Ms}ms / {r.p95Ms}ms
        </Muted>
      ),
    },
    {
      header: "Est. spend",
      render: (r) => <Muted>{formatSpend(spendByKey?.get(r.key) ?? 0)}</Muted>,
    },
  ];
}

function spendLookup(rows: SpendRow[]): Map<string, number> {
  return new Map(rows.map((r) => [r.key, r.estSpendUsd]));
}

const recentColumns: Column<StoredTrafficExchange>[] = [
  {
    header: "Time",
    render: (e) => (
      <Muted>
        {new Date(e.ts).toLocaleTimeString()} · {ago(e.ts)}
      </Muted>
    ),
  },
  {
    header: "Profile",
    render: (e) =>
      e.profile ? <Badge tone="info">{e.profile}</Badge> : <Muted>untagged</Muted>,
  },
  {
    header: "Route",
    render: (e) => (e.route ? <Code>{e.route}</Code> : <Muted>base</Muted>),
  },
  {
    header: "Model",
    render: (e) => (
      <span>
        <Code>{e.upstreamModel ?? e.model ?? "—"}</Code>{" "}
        {e.upstreamModel && e.model && e.upstreamModel !== e.model && (
          <Muted>as {e.model}</Muted>
        )}
      </span>
    ),
  },
  {
    header: "Status",
    render: (e) => <Badge tone={statusTone(e.status)}>{e.status}</Badge>,
  },
  { header: "Took", render: (e) => <Muted>{e.ms}ms</Muted> },
  {
    header: "Tokens ↑↓",
    render: (e) =>
      e.reqTokens || e.resTokens ? (
        <Muted>
          ↑{(e.reqTokens ?? 0).toLocaleString()} ↓{(e.resTokens ?? 0).toLocaleString()}
        </Muted>
      ) : (
        <Muted>—</Muted>
      ),
  },
];

/**
 * Store-backed history: survives proxy restarts, unlike the live ring buffer
 * above. Thread detail stays live-only — store rows carry entry ids, not
 * conversation ids, so they render as facts without thread links.
 */
function HistoryCard({ report }: { report: Awaited<ReturnType<typeof proxyReportFn>> }) {
  if (!report.available) {
    return (
      <Card>
        <Muted>
          No stored history yet — run <Code>swisscode proxy run</Code> and send
          traffic through it. History survives restarts; the live list covers
          only the running process.
        </Muted>
      </Card>
    );
  }
  const t = report.total;
  const spend = report.spendTotal;
  const byDaySpend = spendLookup(report.spendByDay);
  const byRouteSpend = spendLookup(report.spendByRoute);
  const byProfileSpend = spendLookup(report.spendByProfile);
  return (
    <Card>
      <Stack>
        <Muted>
          Stored history{" "}
          {t ? (
            <span>
              · <strong>{t.requests}</strong> requests ·{" "}
              <strong>{t.errors}</strong> errors ({(t.errorRate * 100).toFixed(1)}
              %) · ↑{t.reqTokens.toLocaleString()} ↓
              {t.resTokens.toLocaleString()} tokens · p50 {t.p50Ms}ms / p95{" "}
              {t.p95Ms}ms
              {spend && spend.pricedRequests > 0 && (
                <span> · est. <strong>{formatSpend(spend.estSpendUsd)}</strong></span>
              )}
            </span>
          ) : (
            "· no rows match these filters"
          )}
        </Muted>
        {report.byDay.length > 0 && (
          <Table
            columns={rollupColumns("Day", byDaySpend)}
            rows={report.byDay}
            getKey={(r) => r.key}
            empty={<Muted>No rows.</Muted>}
          />
        )}
        {report.byRoute.length > 0 && (
          <Table
            columns={rollupColumns("Route", byRouteSpend)}
            rows={report.byRoute}
            getKey={(r) => r.key}
            empty={<Muted>No rows.</Muted>}
          />
        )}
        {report.byProfile.length > 0 && (
          <Table
            columns={rollupColumns("Profile", byProfileSpend)}
            rows={report.byProfile}
            getKey={(r) => r.key}
            empty={<Muted>No rows.</Muted>}
          />
        )}
        {report.suggestions.length > 0 && (
          <Stack>
            {report.suggestions.map((tip) => (
              <Muted key={tip}>- {tip}</Muted>
            ))}
          </Stack>
        )}
        {(spend && spend.requests > 0) || report.suggestions.length > 0 ? (
          <Muted>{SPEND_ESTIMATE_NOTE}</Muted>
        ) : null}
        <Table
          columns={recentColumns}
          rows={report.recent}
          getKey={(e) => e.id}
          empty={<Muted>No stored requests match these filters.</Muted>}
        />
      </Stack>
    </Card>
  );
}

