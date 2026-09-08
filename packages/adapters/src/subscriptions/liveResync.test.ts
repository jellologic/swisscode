import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OAuthError } from "@swisscode/core";
import type { OAuthCredential, SubscriptionAccount } from "@swisscode/core";
import { liveResyncHook, resyncSubscriptionCredential } from "./liveResync.js";
import type { EmailLookup, LiveResyncDeps } from "./liveResync.js";

const future = Date.now() + 3600_000;
const past = Date.now() - 1000;

interface VaultEntry {
  account: SubscriptionAccount;
  credential?: OAuthCredential;
}

function account(id: string, email?: string): SubscriptionAccount {
  return {
    id,
    label: id,
    ...(email ? { email } : {}),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function build(
  vault: VaultEntry[],
  live: OAuthCredential | undefined,
  profile?: EmailLookup,
): { deps: LiveResyncDeps; refreshCalls: () => number } {
  let refreshCalls = 0;
  const deps: LiveResyncDeps = {
    accounts: {
      list: async () => vault.map((v) => v.account),
      get: async (id: string) => vault.find((v) => v.account.id === id)?.account,
      save: async () => {},
      loadCredential: async (id: string) => vault.find((v) => v.account.id === id)?.credential,
      saveCredential: async () => {},
      remove: async () => false,
    },
    oauth: {
      refresh: async (cred: OAuthCredential) => {
        refreshCalls += 1;
        if (cred.refreshToken === "live-r-expired") {
          return { accessToken: "rotated-access", refreshToken: "rotated-r", expiresAt: future };
        }
        throw new OAuthError("invalid_grant", "rejected");
      },
    },
    live: {
      readActive: async () =>
        live ? { backend: "file" as const, credential: live } : { backend: "none" as const },
      writeActive: async () => {},
    },
    ...(profile ? { profile } : {}),
  };
  return { deps, refreshCalls: () => refreshCalls };
}

/** The single-account vault the original cases assumed. */
function deps(
  stored: OAuthCredential | undefined,
  live: OAuthCredential | undefined,
): { deps: LiveResyncDeps; refreshCalls: () => number } {
  return build([{ account: account("main"), ...(stored ? { credential: stored } : {}) }], live);
}

describe("resyncSubscriptionCredential", () => {
  it("adopts fresh live lineage without refreshing", async () => {
    const live: OAuthCredential = { accessToken: "live-a", refreshToken: "live-r", expiresAt: future };
    const { deps: d, refreshCalls } = deps(
      { accessToken: "old-a", refreshToken: "dead-r", expiresAt: past },
      live,
    );
    const out = await resyncSubscriptionCredential(d, "main");
    assert.deepEqual(out, live);
    assert.equal(refreshCalls(), 0); // adoption consumes no rotation
  });

  it("skips the same dead lineage and missing live logins", async () => {
    const dead: OAuthCredential = { accessToken: "old-a", refreshToken: "dead-r", expiresAt: past };
    const same = await resyncSubscriptionCredential(deps(dead, { ...dead }).deps, "main");
    assert.equal(same, undefined);

    const none = await resyncSubscriptionCredential(deps(dead, undefined).deps, "main");
    assert.equal(none, undefined);
  });

  it("refreshes expired live lineage once, undefined when it is dead too", async () => {
    const { deps: d, refreshCalls } = deps(
      { accessToken: "old-a", refreshToken: "dead-r", expiresAt: past },
      { accessToken: "stale-a", refreshToken: "live-r-expired", expiresAt: past },
    );
    const out = await resyncSubscriptionCredential(d, "main");
    assert.equal(out?.refreshToken, "rotated-r");
    assert.equal(refreshCalls(), 1);

    const deadLive = await resyncSubscriptionCredential(
      deps(
        { accessToken: "old-a", refreshToken: "dead-r", expiresAt: past },
        { accessToken: "stale-a", refreshToken: "also-dead", expiresAt: past },
      ).deps,
      "main",
    );
    assert.equal(deadLive, undefined);
  });

  it("declines a live login that belongs to a different vault account", async () => {
    // The confirmed bug: `claude login` with the work account silently
    // repointed the personal account at work.
    const workCredential: OAuthCredential = {
      accessToken: "work-a",
      refreshToken: "work-r",
      expiresAt: future,
    };
    const { deps: d, refreshCalls } = build(
      [
        {
          account: account("personal"),
          credential: { accessToken: "old-a", refreshToken: "dead-r", expiresAt: past },
        },
        { account: account("work"), credential: workCredential },
      ],
      workCredential,
    );
    assert.equal(await resyncSubscriptionCredential(d, "personal"), undefined);
    assert.equal(refreshCalls(), 0);
    // The account that actually owns the lineage still adopts nothing new.
    assert.equal(await resyncSubscriptionCredential(d, "work"), undefined);
  });

  it("declines when the live token's email is not this account's", async () => {
    const live: OAuthCredential = { accessToken: "live-a", refreshToken: "live-r", expiresAt: future };
    const profile: EmailLookup = { fetchEmail: async () => "work@example.com" };
    const { deps: d } = build(
      [
        {
          account: account("personal", "me@example.com"),
          credential: { accessToken: "old-a", refreshToken: "dead-r", expiresAt: past },
        },
      ],
      live,
      profile,
    );
    assert.equal(await resyncSubscriptionCredential(d, "personal"), undefined);
  });

  it("adopts on an email match and when the endpoint cannot answer", async () => {
    const live: OAuthCredential = { accessToken: "live-a", refreshToken: "live-r", expiresAt: future };
    const vault = (): VaultEntry[] => [
      {
        account: account("personal", "Me@Example.com "),
        credential: { accessToken: "old-a", refreshToken: "dead-r", expiresAt: past },
      },
    ];
    const match = build(vault(), live, { fetchEmail: async () => "me@example.com" });
    assert.deepEqual(await resyncSubscriptionCredential(match.deps, "personal"), live);

    // Offline/expired profile endpoint: unknown is not a mismatch, and the
    // lineage guard already covered the dangerous case.
    const unknown = build(vault(), live, { fetchEmail: async () => undefined });
    assert.deepEqual(await resyncSubscriptionCredential(unknown.deps, "personal"), live);

    const failing = build(vault(), live, {
      fetchEmail: async () => {
        throw new Error("network down");
      },
    });
    assert.deepEqual(await resyncSubscriptionCredential(failing.deps, "personal"), live);
  });

  it("checks the email of the credential it would actually hand out", async () => {
    // The live access token is expired, so the identity can only be read after
    // the refresh — a check done before it would always fail.
    const seen: string[] = [];
    const { deps: d } = build(
      [
        {
          account: account("personal", "me@example.com"),
          credential: { accessToken: "old-a", refreshToken: "dead-r", expiresAt: past },
        },
      ],
      { accessToken: "stale-a", refreshToken: "live-r-expired", expiresAt: past },
      {
        fetchEmail: async (token: string) => {
          seen.push(token);
          return "me@example.com";
        },
      },
    );
    const out = await resyncSubscriptionCredential(d, "personal");
    assert.equal(out?.refreshToken, "rotated-r");
    assert.deepEqual(seen, ["rotated-access"]);
  });

  it("checks identity through the real profile endpoint with no profile injected", async () => {
    // Every shipped call site builds `liveResyncHook({accounts, oauth, live})`
    // — the CLI, the proxy and the web server all skip `profile`. With an
    // opt-in guard, `claude login` as work silently repointed the personal
    // account at work. globalThis.fetch is stubbed: no network, no keychain.
    const live: OAuthCredential = { accessToken: "live-a", refreshToken: "live-r", expiresAt: future };
    const vault = (): VaultEntry[] => [
      {
        account: account("personal", "me@example.com"),
        credential: { accessToken: "old-a", refreshToken: "dead-r", expiresAt: past },
      },
    ];
    const calls: { url: string; token: string | null }[] = [];
    const realFetch = globalThis.fetch;
    const reply = (email: string): typeof fetch =>
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(input), token: headers.get("authorization") });
        return new Response(JSON.stringify({ account: { email } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof fetch;

    try {
      globalThis.fetch = reply("work@example.com");
      const mismatch = build(vault(), live);
      assert.equal(await resyncSubscriptionCredential(mismatch.deps, "personal"), undefined);
      assert.equal(calls.length, 1);
      assert.match(calls[0]?.url ?? "", /\/api\/oauth\/profile$/);
      assert.equal(calls[0]?.token, "Bearer live-a");

      globalThis.fetch = reply("me@example.com");
      const match = build(vault(), live);
      assert.deepEqual(await resyncSubscriptionCredential(match.deps, "personal"), live);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("asks nothing of the network for an account with no known email", async () => {
    const live: OAuthCredential = { accessToken: "live-a", refreshToken: "live-r", expiresAt: future };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("the email guard must not fire without an email to compare");
    }) as unknown as typeof fetch;
    try {
      const { deps: d } = build(
        [
          {
            account: account("legacy"),
            credential: { accessToken: "old-a", refreshToken: "dead-r", expiresAt: past },
          },
        ],
        live,
      );
      assert.deepEqual(await resyncSubscriptionCredential(d, "legacy"), live);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("liveResyncHook returns undefined without a live store", () => {
    const { deps: d } = deps(undefined, undefined);
    assert.equal(liveResyncHook({ accounts: d.accounts, oauth: d.oauth, live: undefined }), undefined);
    const hook = liveResyncHook({ accounts: d.accounts, oauth: d.oauth, live: d.live });
    assert.equal(typeof hook, "function");
  });
});
