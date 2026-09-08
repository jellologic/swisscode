import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CredentialStoreError, OAuthError } from "./subscriptionPorts.js";
import type { AccountRepository, OAuthClient } from "./subscriptionPorts.js";
import type { OAuthCredential } from "./subscriptions.js";
import {
  OAUTH_EXPIRY_BUFFER_MS,
  ensureFreshCredential,
  isCredentialExpired,
  validateAccountId,
} from "./subscriptionService.js";

const future = Date.now() + 3600_000;
const past = Date.now() - 1000;

interface Harness {
  accounts: AccountRepository;
  oauth: OAuthClient;
  refreshCalls: () => number;
  saved: () => OAuthCredential[];
}

/** In-memory ports: core is pure, so nothing here touches fs/net. */
function harness(
  initial: OAuthCredential | undefined,
  refresh: (cred: OAuthCredential) => Promise<OAuthCredential>,
): Harness {
  let current = initial;
  let refreshCalls = 0;
  const saved: OAuthCredential[] = [];
  return {
    accounts: {
      list: async () => [],
      get: async () => undefined,
      save: async () => {},
      loadCredential: async () => current,
      saveCredential: async (_id: string, credential: OAuthCredential) => {
        saved.push(credential);
        current = credential;
      },
      remove: async () => false,
    },
    oauth: {
      refresh: async (cred: OAuthCredential) => {
        refreshCalls += 1;
        return refresh(cred);
      },
    },
    refreshCalls: () => refreshCalls,
    saved: () => saved,
  };
}

describe("isCredentialExpired", () => {
  it("treats an unknown expiry as expired and applies the 5-minute buffer", () => {
    assert.equal(isCredentialExpired({ accessToken: "a", refreshToken: "r" }), true);
    assert.equal(isCredentialExpired({ accessToken: "a", refreshToken: "r", expiresAt: 0 }), true);
    const now = 1_000_000_000;
    // Inside the buffer: still "expired" so callers refresh before a request
    // can die mid-flight.
    assert.equal(
      isCredentialExpired(
        { accessToken: "a", refreshToken: "r", expiresAt: now + OAUTH_EXPIRY_BUFFER_MS - 1 },
        now,
      ),
      true,
    );
    assert.equal(
      isCredentialExpired(
        { accessToken: "a", refreshToken: "r", expiresAt: now + OAUTH_EXPIRY_BUFFER_MS + 1 },
        now,
      ),
      false,
    );
  });
});

describe("validateAccountId", () => {
  it("accepts CLI/URL-safe ids and rejects path tricks", () => {
    validateAccountId("personal");
    validateAccountId("work-2_b");
    for (const bad of ["", "-lead", "_lead", "../escape", "with space", "a/b", "a.json"]) {
      assert.throws(() => validateAccountId(bad), /Invalid account id/);
    }
  });
});

describe("ensureFreshCredential", () => {
  it("returns a live credential untouched", async () => {
    const h = harness({ accessToken: "a", refreshToken: "r", expiresAt: future }, async () => {
      throw new Error("unreachable");
    });
    const out = await ensureFreshCredential(h.accounts, h.oauth, "id");
    assert.equal(out.refreshed, false);
    assert.equal(out.credential.accessToken, "a");
    assert.equal(h.refreshCalls(), 0);
    assert.equal(h.saved().length, 0);
  });

  it("refreshes, persists, then notifies onRefreshed with the persisted credential", async () => {
    const h = harness({ accessToken: "old", refreshToken: "rt-1", expiresAt: past }, async () => ({
      accessToken: "new",
      refreshToken: "rt-2",
      expiresAt: future,
    }));
    const mirrored: OAuthCredential[] = [];
    const out = await ensureFreshCredential(h.accounts, h.oauth, "id", {
      onRefreshed: async (credential) => {
        // The vault write must already have happened when the mirror runs.
        assert.deepEqual(h.saved(), [credential]);
        mirrored.push(credential);
      },
    });
    assert.equal(out.refreshed, true);
    assert.equal(out.credential.refreshToken, "rt-2");
    assert.deepEqual(mirrored, [out.credential]);
  });

  it("does not call onRefreshed on the adopt path", async () => {
    const h = harness({ accessToken: "old", refreshToken: "dead", expiresAt: past }, async () => {
      throw new OAuthError("invalid_grant", "rejected");
    });
    const adopted: OAuthCredential = { accessToken: "live", refreshToken: "live-rt", expiresAt: future };
    let mirrored = 0;
    const out = await ensureFreshCredential(h.accounts, h.oauth, "id", {
      onInvalidGrant: async () => adopted,
      onRefreshed: async () => {
        mirrored += 1;
      },
    });
    assert.deepEqual(out.credential, adopted);
    assert.deepEqual(h.saved(), [adopted]);
    assert.equal(mirrored, 0);
  });

  it("surfaces a failing mirror after the vault already holds the rotation", async () => {
    const h = harness({ accessToken: "old", refreshToken: "rt-1", expiresAt: past }, async () => ({
      accessToken: "new",
      refreshToken: "rt-2",
      expiresAt: future,
    }));
    await assert.rejects(
      () =>
        ensureFreshCredential(h.accounts, h.oauth, "id", {
          onRefreshed: async () => {
            throw new CredentialStoreError("write-failed", "keychain denied");
          },
        }),
      CredentialStoreError,
    );
    // The rotated token is not lost: a retry finds it and refreshes nothing.
    const retry = await ensureFreshCredential(h.accounts, h.oauth, "id");
    assert.equal(retry.refreshed, false);
    assert.equal(retry.credential.refreshToken, "rt-2");
    assert.equal(h.refreshCalls(), 1);
  });

  it("rejects an unknown account and a credential with no refresh token", async () => {
    const missing = harness(undefined, async () => {
      throw new Error("unreachable");
    });
    await assert.rejects(
      () => ensureFreshCredential(missing.accounts, missing.oauth, "nope"),
      /Unknown subscription account/,
    );
    const noRefresh = harness({ accessToken: "a", refreshToken: "", expiresAt: past }, async () => {
      throw new Error("unreachable");
    });
    await assert.rejects(
      () => ensureFreshCredential(noRefresh.accounts, noRefresh.oauth, "id"),
      (err: unknown) => err instanceof OAuthError && err.kind === "no_refresh_token",
    );
  });

  it("keeps the original error when the invalid_grant hook has nothing to adopt", async () => {
    const h = harness({ accessToken: "old", refreshToken: "dead", expiresAt: past }, async () => {
      throw new OAuthError("invalid_grant", "rejected");
    });
    await assert.rejects(
      () =>
        ensureFreshCredential(h.accounts, h.oauth, "id", {
          onInvalidGrant: async () => undefined,
        }),
      (err: unknown) => err instanceof OAuthError && err.kind === "invalid_grant",
    );
    assert.equal(h.saved().length, 0);
  });
});

describe("ensureFreshCredential force", () => {
  it("rotates a credential our clock still calls fresh", async () => {
    // The 401 case: the server rejected a token whose expiresAt is in the
    // future. Without `force` the caller has to refresh on its own, outside
    // the lock and the shared-lineage mirror.
    const h = harness({ accessToken: "rejected", refreshToken: "r", expiresAt: future }, async () => ({
      accessToken: "rotated",
      refreshToken: "r2",
      expiresAt: future,
    }));
    const out = await ensureFreshCredential(h.accounts, h.oauth, "personal", { force: true });
    assert.equal(out.credential.accessToken, "rotated");
    assert.equal(out.refreshed, true);
    assert.equal(h.refreshCalls(), 1);
    assert.deepEqual(h.saved().map((c) => c.accessToken), ["rotated"]);
  });

  it("still short-circuits without it", async () => {
    const h = harness({ accessToken: "a", refreshToken: "r", expiresAt: future }, async () => {
      throw new Error("must not refresh");
    });
    const out = await ensureFreshCredential(h.accounts, h.oauth, "personal");
    assert.equal(out.credential.accessToken, "a");
    assert.equal(h.refreshCalls(), 0);
  });

  it("still mirrors a forced rotation back to a shared owner", async () => {
    const mirrored: string[] = [];
    const h = harness({ accessToken: "rejected", refreshToken: "r", expiresAt: future }, async () => ({
      accessToken: "rotated",
      refreshToken: "r2",
      expiresAt: future,
    }));
    await ensureFreshCredential(h.accounts, h.oauth, "personal", {
      force: true,
      onRefreshed: async (credential) => {
        mirrored.push(credential.accessToken);
      },
    });
    assert.deepEqual(mirrored, ["rotated"]);
  });
});
