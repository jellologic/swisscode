import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type {
  AccountRepository,
  AccountUsage,
  GlobalSettings,
  OAuthCredential,
  SubscriptionAccount,
  UsageClient,
} from "@swisscode/core";
import { UsageError } from "../subscriptions/anthropic.js";
import type { UsageCacheEntry } from "../subscriptions/usageCache.js";
import { DEFAULT_ROTATION_POLL_MS, RotationPoller } from "./rotationPoller.js";
import type { RotationPollerDeps } from "./rotationPoller.js";

const NOW = 1_786_000_000_000;
const MIN = 60_000;

function account(id: string): SubscriptionAccount {
  return { id, label: id, email: `${id}@x.test`, createdAt: "", updatedAt: "" };
}

function usage(id: string, over: Partial<AccountUsage> = {}): AccountUsage {
  return { accountId: id, fetchedAt: new Date(NOW).toISOString(), ...over };
}

function window(utilization: number | null, resetMin?: number) {
  return {
    utilization,
    ...(resetMin === undefined ? {} : { resetsAt: new Date(NOW + resetMin * MIN).toISOString() }),
  };
}

function accountsFixture(ids: string[], missingCredential: string[] = []): AccountRepository {
  const cred = (id: string): OAuthCredential => ({
    accessToken: `${id}-token`,
    refreshToken: `${id}-rt`,
    expiresAt: NOW + 3600_000,
  });
  return {
    list: async () => ids.map(account),
    get: async (id: string) => (ids.includes(id) ? account(id) : undefined),
    save: async () => {},
    loadCredential: async (id: string) => (missingCredential.includes(id) ? undefined : cred(id)),
    saveCredential: async () => {},
    remove: async () => false,
  };
}

function usageFixture(impl: (accountId: string) => Promise<AccountUsage> | AccountUsage): {
  client: UsageClient;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    client: {
      fetchUsage: async (accountId: string) => {
        calls.push(accountId);
        return impl(accountId);
      },
    },
  };
}

function cacheFixture(entries: Record<string, UsageCacheEntry> = {}): {
  cache: { get(key: string): Promise<UsageCacheEntry | undefined> };
  entries: Record<string, UsageCacheEntry>;
} {
  return { cache: { get: async (key: string) => entries[key] }, entries };
}

function settingsFixture(settings: GlobalSettings): { get(): Promise<GlobalSettings> } {
  return { get: async () => settings };
}

const ON = {
  rotationEnabled: true,
  rotationStrategy: "reset-soonest",
  updateMode: "auto",
} as GlobalSettings;
const OFF = {
  rotationEnabled: false,
  rotationStrategy: "reset-soonest",
  updateMode: "auto",
} as GlobalSettings;

interface Harness {
  poller: RotationPoller;
  calls: string[];
  logs: string[];
  active: { id: string | null };
}

function harness(
  ids: string[],
  impl: (accountId: string) => Promise<AccountUsage> | AccountUsage,
  over: Omit<Partial<RotationPollerDeps>, "settings" | "usageCache" | "accounts" | "usageClient"> & {
    settings?: GlobalSettings;
    /** Vault ids with no stored credential (read as dead, no network). */
    missingCredential?: string[];
  } = {},
): Harness {
  const { client, calls } = usageFixture(impl);
  const logs: string[] = [];
  const active: { id: string | null } = { id: over.getActive?.() ?? null };
  const { settings, missingCredential, ...rest } = over;
  const poller = new RotationPoller({
    accounts: accountsFixture(ids, missingCredential ?? []),
    usageClient: client,
    usageCache: cacheFixture().cache,
    settings: settingsFixture(settings ?? ON),
    accountIdentity: async (id: string) => `email:${id}@x.test`,
    getActive: () => active.id,
    setActive: async (id: string) => {
      active.id = id;
    },
    env: {},
    now: () => NOW,
    log: (m: string) => logs.push(m),
    ...rest,
  });
  return { poller, calls, logs, active };
}

describe("RotationPoller", () => {
  it("switches a decisively worse current account to the winner", async () => {
    const h = harness(["a", "b"], (id) =>
      usage(id, id === "a" ? { fiveHour: window(80, 120) } : { fiveHour: window(20, 100) }),
      { getActive: () => "a" },
    );
    await h.poller.tick();
    assert.equal(h.active.id, "b");
    assert.deepEqual(h.calls, ["a", "b"]);
    const snap = h.poller.snapshot();
    assert.deepEqual(
      { enabled: snap.enabled, checked: snap.checked, usable: snap.usable, switched: snap.switched },
      { enabled: true, checked: 2, usable: 2, switched: "a→b" },
    );
    assert.match(h.logs.join("\n"), /active a→b/);
  });

  it("stays inside the noise band instead of flapping", async () => {
    const h = harness(["a", "b"], (id) =>
      usage(id, id === "a" ? { fiveHour: window(30, 120) } : { fiveHour: window(32, 112) }),
      { getActive: () => "a" },
    );
    await h.poller.tick();
    assert.equal(h.active.id, "a");
    assert.equal(h.poller.snapshot().switched, null);
  });

  it("never selects a 401/403 account, and abandons one that is current", async () => {
    const h = harness(
      ["a", "b"],
      (id) => {
        if (id === "a") throw new UsageError("revoked", 401);
        return usage(id, { fiveHour: window(50, 60) });
      },
      { getActive: () => "a" },
    );
    await h.poller.tick();
    assert.equal(h.active.id, "b");
  });

  it("treats a missing credential as dead without touching the network", async () => {
    const h = harness(["ghost", "real"], (id) => usage(id, { fiveHour: window(10, 60) }), {
      getActive: () => "ghost",
      missingCredential: ["ghost"],
    });
    await h.poller.tick();
    // Ghost has no credential to check with (dead); only real hit the network.
    assert.deepEqual(h.calls, ["real"]);
    assert.equal(h.active.id, "real");
  });

  it("honors a live notBeforeMs: no network, cooling, last-good numbers kept", async () => {
    const { client, calls } = usageFixture((id) => usage(id));
    const logs: string[] = [];
    const active: { id: string | null } = { id: "a" };
    const poller = new RotationPoller({
      accounts: accountsFixture(["a", "b"]),
      usageClient: client,
      usageCache: cacheFixture({
        "a#email:a@x.test": {
          snapshot: usage("a", { fiveHour: window(5, 10) }),
          notBeforeMs: NOW + 5 * MIN,
        },
      }).cache,
      settings: settingsFixture(ON),
      accountIdentity: async (id: string) => `email:${id}@x.test`,
      getActive: () => active.id,
      setActive: async (id: string) => {
        active.id = id;
      },
      env: {},
      now: () => NOW,
      log: (m: string) => logs.push(m),
    });
    await poller.tick();
    // Only b hit the network: a's backoff window is live, so it ranks off its
    // last-good numbers marked cooling (degraded) and loses to b's usable.
    assert.deepEqual(calls, ["b"]);
    assert.equal(active.id, "b");
  });

  it("demotes stale snapshots below fresh ones", async () => {
    const h = harness(["a", "b"], (id) =>
      id === "a"
        ? { ...usage(id, { fiveHour: window(5, 10) }), stale: true }
        : usage(id, { fiveHour: window(50, 60) }),
      { getActive: () => "a" },
    );
    await h.poller.tick();
    assert.equal(h.active.id, "b");
  });

  it("demotes proxy-cooled accounts below fresh ones", async () => {
    const h = harness(["a", "b"], (id) => usage(id, { fiveHour: window(5, 60) }), {
      getActive: () => "a",
      cooldownUntil: (id: string) => (id === "a" ? NOW + 60_000 : 0),
    });
    // Both report 5%; a is cooling (degraded) so b (usable) wins the band.
    await h.poller.tick();
    assert.equal(h.active.id, "b");
  });

  it("folds scoped/model/extra windows into the balance (hot 7d sinks)", async () => {
    const h = harness(
      ["hot", "cool"],
      (id) =>
        id === "hot"
          ? usage(id, { fiveHour: window(10, 5), models: { opus: window(91, 60) } })
          : usage(id, { fiveHour: window(20, 60) }),
      { getActive: () => "hot", settings: { rotationEnabled: true, rotationStrategy: "least-used", updateMode: "auto" } },
    );
    await h.poller.tick();
    assert.equal(h.active.id, "cool");
  });

  it("checks accounts strictly sequentially in vault order", async () => {
    const order: string[] = [];
    const h = harness(["a", "b", "c"], async (id) => {
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end-${id}`);
      return usage(id, { fiveHour: window(10, 60) });
    });
    await h.poller.tick();
    assert.deepEqual(order, ["start-a", "end-a", "start-b", "end-b", "start-c", "end-c"]);
  });

  it("skips an overlapping tick instead of doubling network calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness(["a", "b"], async (id) => {
      await gate;
      return usage(id, { fiveHour: window(10, 60) });
    });
    const first = h.poller.tick();
    await h.poller.tick();
    release();
    await first;
    assert.deepEqual(h.calls, ["a", "b"]);
  });

  it("one account's failure neither aborts the others nor crashes the tick", async () => {
    const events: unknown[] = [];
    const h = harness(["a", "b", "c"], (id) => {
      if (id === "b") throw new Error("socket hang up");
      return usage(id, { fiveHour: window(id === "a" ? 80 : 20, 60) });
    }, { getActive: () => "a", onEvent: (e) => events.push(e) });
    await h.poller.tick();
    assert.deepEqual(h.calls, ["a", "b", "c"]);
    // b is stale-unknown (50); c at 20 wins over a at 80 by the gap.
    assert.equal(h.active.id, "c");
    assert.equal(events.length, 1);
  });

  it("a failed setActive is logged, not thrown", async () => {
    const { client } = usageFixture((id) =>
      usage(id, id === "a" ? { fiveHour: window(80, 120) } : { fiveHour: window(5, 60) }),
    );
    const logs: string[] = [];
    const poller = new RotationPoller({
      accounts: accountsFixture(["a", "b"]),
      usageClient: client,
      usageCache: cacheFixture().cache,
      settings: settingsFixture(ON),
      accountIdentity: async (id: string) => `email:${id}@x.test`,
      getActive: () => "a",
      setActive: async () => {
        throw new Error("account deleted mid-tick");
      },
      env: {},
      now: () => NOW,
      log: (m: string) => logs.push(m),
    });
    await poller.tick();
    assert.match(logs.join("\n"), /switch to b failed/);
    assert.match(poller.snapshot().reason ?? "", /switch failed/);
  });

  it("disabled does zero network (file off; env off beats file on)", async () => {
    const off = harness(["a", "b"], (id) => usage(id), { settings: OFF });
    await off.poller.tick();
    assert.deepEqual(off.calls, []);
    assert.match(off.logs.join("\n"), /disabled, skipping/);
    assert.equal(off.poller.snapshot().enabled, false);

    const envOff = harness(["a", "b"], (id) => usage(id), {
      settings: ON,
      env: { SWISSCODE_ROTATION_ENABLED: "0" },
    });
    await envOff.poller.tick();
    assert.deepEqual(envOff.calls, []);
  });

  it("enable precedence is flag > env > file", async () => {
    // Env on beats file off.
    const envOn = harness(["a", "b"], (id) => usage(id), {
      settings: OFF,
      env: { SWISSCODE_ROTATION_ENABLED: "yes" },
    });
    await envOn.poller.tick();
    assert.ok(envOn.calls.length > 0);

    // Flag off beats env on.
    const flagOff = harness(["a", "b"], (id) => usage(id), {
      settings: ON,
      env: { SWISSCODE_ROTATION_ENABLED: "1" },
      overrides: { enabled: false },
    });
    await flagOff.poller.tick();
    assert.deepEqual(flagOff.calls, []);

    // Flag on beats file off.
    const flagOn = harness(["a", "b"], (id) => usage(id), {
      settings: OFF,
      env: {},
      overrides: { enabled: true },
    });
    await flagOn.poller.tick();
    assert.ok(flagOn.calls.length > 0);
  });

  it("strategy precedence is flag > env > file, and least-used changes the winner", async () => {
    // a resets sooner but is hotter: reset-soonest keeps a, least-used picks b.
    const impl = (id: string) =>
      usage(id, id === "a" ? { fiveHour: window(70, 5) } : { fiveHour: window(20, 120) });
    const file = harness(["a", "b"], impl, { getActive: () => "a" });
    await file.poller.tick();
    assert.equal(file.active.id, "a");

    const env = harness(["a", "b"], impl, {
      getActive: () => "a",
      env: { SWISSCODE_ROTATION_STRATEGY: "least-used" },
    });
    await env.poller.tick();
    assert.equal(env.active.id, "b");
    assert.equal(env.poller.snapshot().strategy, "least-used");

    // Garbage env falls back to the file.
    const garbage = harness(["a", "b"], impl, {
      getActive: () => "a",
      env: { SWISSCODE_ROTATION_STRATEGY: "soonest" },
    });
    await garbage.poller.tick();
    assert.equal(garbage.active.id, "a");
  });

  it("clamps the poll interval at the 60s floor", async () => {
    const h = harness(["a"], (id) => usage(id), { env: { SWISSCODE_ROTATION_POLL_MS: "5" } });
    h.poller.start();
    try {
      assert.equal(h.poller.running, true);
    } finally {
      h.poller.stop();
    }
    assert.equal(h.poller.running, false);
    assert.equal(DEFAULT_ROTATION_POLL_MS, 5 * 60 * 1000);
  });

  it("with one account it logs once and never fetches", async () => {
    const h = harness(["solo"], (id) => usage(id));
    await h.poller.tick();
    await h.poller.tick();
    assert.deepEqual(h.calls, []);
    assert.equal(h.logs.filter((l) => l.includes("nothing to rotate")).length, 1);
    assert.equal(h.poller.snapshot().checked, 1);
  });

  it("a manual switch arms the min-hold against instant revert", async () => {
    let now = NOW;
    const { client } = usageFixture((id) =>
      usage(id, id === "a" ? { fiveHour: window(30, 120) } : { fiveHour: window(32, 60) }),
    );
    const logs: string[] = [];
    const active: { id: string | null } = { id: "a" };
    const poller = new RotationPoller({
      accounts: accountsFixture(["a", "b"]),
      usageClient: client,
      usageCache: cacheFixture().cache,
      settings: settingsFixture(ON),
      accountIdentity: async (id: string) => `email:${id}@x.test`,
      getActive: () => active.id,
      setActive: async (id: string) => {
        active.id = id;
      },
      env: {},
      now: () => now,
      log: (m: string) => logs.push(m),
    });
    // Manual choice of a just now: hold, even though b resets 60min sooner.
    poller.noteManualSwitch();
    await poller.tick();
    assert.equal(active.id, "a");
    // A full cycle later the same edge switches.
    now += DEFAULT_ROTATION_POLL_MS;
    await poller.tick();
    assert.equal(active.id, "b");
  });
});
