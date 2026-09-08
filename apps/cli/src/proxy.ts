// `swisscode proxy ...` — run the subscription proxy, switch its active
// account, or check its status. The proxy itself lives in @swisscode/adapters.

import {
  AnthropicOAuthClient,
  FileAccountRepository,
  SubscriptionProxy,
  defaultSubscriptionsDir,
  proxyBaseUrl,
  proxyPort,
} from "@swisscode/adapters";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

export function proxyHelp(): string {
  return [
    "swisscode proxy <command>",
    "",
    "  run [--port <n>]        Run the subscription proxy (foreground)",
    "  use <id> [--port <n>]   Switch the proxy's active account",
    "  status [--port <n>]     Show proxy status and accounts",
  ].join("\n");
}

async function proxyControl(port: number, path: string, method: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${proxyBaseUrl(port)}${path}`, { method });
  } catch {
    throw new Error(`Proxy is not running on port ${port}. Start it with \`swisscode proxy run\`.`);
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(typeof body["error"] === "string" ? body["error"] : `HTTP ${res.status}`);
  return body;
}

export async function proxyStatus(port: number): Promise<{ running: boolean; activeAccountId: string | null }> {
  const body = (await proxyControl(port, "/__swisscode/status", "GET")) as {
    running?: boolean;
    activeAccountId?: string | null;
    accounts?: { id: string; label: string }[];
  };
  console.log(`Proxy on :${port} — active: ${body.activeAccountId ?? "(none)"}`);
  for (const a of body.accounts ?? []) console.log(`  ${a.id}\t${a.label}`);
  return { running: body.running ?? true, activeAccountId: body.activeAccountId ?? null };
}

export async function proxyUse(id: string, port: number): Promise<boolean> {
  try {
    const body = (await proxyControl(port, `/__swisscode/use/${id}`, "POST")) as {
      activeAccountId?: string;
    };
    console.log(`Proxy now using "${body.activeAccountId ?? id}".`);
    return true;
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
    return false;
  }
}

/** Ensure the proxy is up and set to the account. False = caller should abort. */
export async function ensureProxyAccount(id: string, port: number): Promise<boolean> {
  return proxyUse(id, port);
}

export async function cmdProxy(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const port = proxyPort(flag(rest, "--port"));
  if (sub === "run") {
    const proxy = new SubscriptionProxy(
      new FileAccountRepository(defaultSubscriptionsDir()),
      new AnthropicOAuthClient(),
    );
    const count = (await proxy.status()).accounts.length;
    if (count === 0) {
      console.error("No subscription accounts stored. Run `swisscode accounts import <id>` first.");
      process.exitCode = 1;
      return;
    }
    await proxy.listen(port);
    console.log(`Subscription proxy on ${proxyBaseUrl(port)} (${count} account(s)). Ctrl-C to stop.`);
    const shutdown = () => {
      void proxy.close().finally(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise(() => {}); // run until signal
    return;
  }
  if (sub === "use" && rest[0]) {
    await proxyUse(rest[0] as string, port);
    return;
  }
  if (sub === "status") {
    try {
      await proxyStatus(port);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
    return;
  }
  console.log(proxyHelp());
}
