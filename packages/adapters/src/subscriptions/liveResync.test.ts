import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OAuthError } from "@swisscode/core";
import type { OAuthCredential } from "@swisscode/core";
import { liveResyncHook, resyncSubscriptionCredential } from "./liveResync.js";
import type { LiveResyncDeps } from "./liveResync.js";

const future = Date.now() + 3600_000;
const past = Date.now() - 1000;

function deps(stored: OAuthCredential | undefined, live: OAuthCredential | undefined): {
  deps: LiveResyncDeps;
  refreshCalls: () => number;
} {
  let refreshCalls = 0;
  const full: LiveResyncDeps = {
    accounts: {
      list: async () => [],
      get: async () => undefined,
      save: async () => {},
      loadCredential: async () => stored,
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
  };
  return { deps: full, refreshCalls: () => refreshCalls };
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

  it("liveResyncHook returns undefined without a live store", () => {
    const { deps: d } = deps(undefined, undefined);
    assert.equal(liveResyncHook({ accounts: d.accounts, oauth: d.oauth, live: undefined }), undefined);
    const hook = liveResyncHook({ accounts: d.accounts, oauth: d.oauth, live: d.live });
    assert.equal(typeof hook, "function");
  });
});
