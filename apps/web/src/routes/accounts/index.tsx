import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import {
  Badge,
  Button,
  Card,
  Code,
  Column,
  Meter,
  Muted,
  Notice,
  Page,
  RowActions,
  Stack,
  Table,
} from "../../design";
import { notify } from "../../design";
import {
  accountUsageFn,
  catalogFn,
  currentLoginFn,
  importAccountFn,
  listAccountsFn,
  listProviderAccountsFn,
  providerUsageFn,
  proxyStateFn,
  proxyUseFn,
  removeAccountFn,
  removeProviderAccountFn,
  switchSubscriptionFn,
} from "../../lib/functions";
import { ago, prettify } from "../../components/ModelPicker";

export const Route = createFileRoute("/accounts/")({
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

type AccountRow =
  | { kind: "sub"; id: string; label: string; detail: string }
  | { kind: "generic"; providerId: string; id: string; label: string; config: Record<string, string> };

function AccountsPage() {
  const { catalog, login, subs, subUsage, proxy, generic, genericUsage } = Route.useLoaderData();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<{ id: string; otherSessions: number } | null>(null);

  const providerById = new Map(catalog.providers.map((p) => [p.id, p]));
  const subUsageById = new Map(subUsage.results.flatMap((r) => (r.usage ? [[r.usage.accountId, r.usage]] : [])));
  const subErrors = subUsage.results.flatMap((r) => (r.error ? [r.error] : []));
  const caps = providerById.get("claude-subscription")?.accountCapabilities;

  async function refresh() {
    setPendingSwitch(null);
    await router.invalidate();
  }

  async function run(fn: () => Promise<unknown>, success?: string) {
    setError(null);
    try {
      await fn();
      if (success) notify.success(success);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doSwitch(id: string, force: boolean) {
    setError(null);
    try {
      const result = await switchSubscriptionFn({ data: { id, force } });
      if (result.needsConfirm) {
        setPendingSwitch({ id, otherSessions: result.otherSessions ?? 0 });
      } else {
        notify.success(`"${id}" is now the system login`);
        await refresh();
      }
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
                <Button size="sm" onClick={() => run(() => proxyUseFn({ data: { id: r.id } }), `Proxy now serves "${r.id}"`)}>
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
              <Button size="sm" variant="ghost" onClick={() => run(() => importAccountFn({ data: { id: r.id, overwrite: true } }), `Re-imported "${r.id}"`)}>
                Re-import
              </Button>
              <Button size="sm" variant="ghost" to={`/accounts/sub/${r.id}`}>
                Edit
              </Button>
              <Button size="sm" variant="danger" onClick={() => run(() => removeAccountFn({ data: { id: r.id } }), `Removed "${r.id}"`)}>
                Remove
              </Button>
            </RowActions>
          );
        }
        return (
          <RowActions>
            <Button size="sm" variant="ghost" to={`/accounts/key/${r.providerId}/${r.id}`}>
              Edit
            </Button>
            <Button size="sm" variant="danger" onClick={() => run(() => removeProviderAccountFn({ data: { providerId: r.providerId, id: r.id } }), `Removed "${r.id}"`)}>
              Remove
            </Button>
          </RowActions>
        );
      },
    },
  ];

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

        <RowActions>
          <Button variant="primary" to="/accounts/new">Add account</Button>
        </RowActions>

        <Table
          columns={columns}
          rows={rows}
          getKey={(r) => `${r.kind}:${r.kind === "generic" ? r.providerId : "sub"}:${r.id}`}
          empty={<Muted>No accounts yet — add one above.</Muted>}
        />
        {subErrors.map((e) => (
          <Notice key={e} tone="danger">{e}</Notice>
        ))}
        {error && <Notice tone="danger">{error}</Notice>}
      </Stack>
    </Page>
  );
}
