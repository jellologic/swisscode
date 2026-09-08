import { useEffect, useState, type ReactNode } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Card,
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
  proxyStateFn,
  proxyTrafficClearFn,
  proxyTrafficFn,
  proxyTrafficSizeFn,
} from "../../lib/functions";
import type { TrafficConversation } from "@swisscode/adapters";
import { ago } from "../../components/ModelPicker";
import { fmtBytes, fmtSpan, statusTone } from "../../components/TrafficEntryDetail";

export const Route = createFileRoute("/proxy/")({
  validateSearch: (search: Record<string, unknown>) => ({
    profile: typeof search["profile"] === "string" ? search["profile"] : "",
  }),
  loaderDeps: ({ search }) => ({ profile: search.profile }),
  loader: async ({ deps }) => ({
    proxy: await proxyStateFn(),
    traffic: await proxyTrafficFn({ data: { profile: deps.profile || undefined } }),
  }),
  component: ProxyPage,
});

function ProxyPage() {
  const { proxy, traffic } = Route.useLoaderData();
  const { profile } = Route.useSearch();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [keepInput, setKeepInput] = useState<string>(String(traffic.size));

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
      search={{ profile }}
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
                    <Select
                      value={profile}
                      onChange={(e) =>
                        void router.navigate({
                          to: "/proxy",
                          search: { profile: e.target.value },
                        })
                      }
                    >
                      <option value="">All profiles</option>
                      {traffic.profiles.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </Select>
                  </Field>
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
                      search: { profile },
                    });
                  }}
                />
              </Stack>
            </Card>
          </>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </Stack>
    </Page>
  );
}

