import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OAuthError } from "@swisscode/core";
import type {
  AccountRepository,
  ActiveCredentialStore,
  OAuthClient,
  OAuthCredential,
} from "@swisscode/core";
import { freshVaultCredential } from "./freshCredential.js";

const future = Date.now() + 3600_000;
const past = Date.now() - 1000;

interface Harness {
  accounts: AccountRepository;
  oauth: OAuthClient;
  refreshCalls: () => number;
  saved: () => OAuthCredential[];
  stored: () => OAuthCredential | undefined;
}

/** In-memory vault + OAuth client. No fs, no network, no keychain. */
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
    stored: () => current,
  };
}

function liveStore(credential: OAuthCredential | undefined): ActiveCredentialStore {
  return {
    readActive: async () =>
      credential ? { backend: "file" as const, credential } : { backend: "none" as const },
    writeActive: async () => {
      throw new Error("freshVaultCredential must never write Claude Code's store");
    },
  };
}

describe("freshVaultCredential", () => {
  it("returns a live credential without refreshing", async () => {
    const h = harness({ accessToken: "a", refreshToken: "r", expiresAt: future }, async () => {
      throw new Error("unreachable");
    });
    const out = await freshVaultCredential(h.accounts, h.oauth, "live-account");
    assert.equal(out.credential.accessToken, "a");
    assert.equal(out.refreshed, false);
    assert.equal(h.refreshCalls(), 0);
  });

  it("collapses concurrent callers onto one refresh of a single-use token", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const h = harness({ accessToken: "old", refreshToken: "rt-1", expiresAt: past }, async () => {
      await gate;
      return { accessToken: "new", refreshToken: "rt-2", expiresAt: future };
    });
    const calls = [
      freshVaultCredential(h.accounts, h.oauth, "concurrent-account"),
      freshVaultCredential(h.accounts, h.oauth, "concurrent-account"),
      freshVaultCredential(h.accounts, h.oauth, "concurrent-account"),
    ];
    release?.();
    const results = await Promise.all(calls);
    assert.equal(h.refreshCalls(), 1);
    assert.equal(h.saved().length, 1);
    for (const r of results) assert.equal(r.credential.accessToken, "new");
    assert.equal(h.stored()?.refreshToken, "rt-2");
  });

  it("frees the key so a later expiry refreshes again", async () => {
    let round = 0;
    const h = harness({ accessToken: "old", refreshToken: "rt-1", expiresAt: past }, async () => {
      round += 1;
      // Still expired, so the next call must refresh once more.
      return { accessToken: `new-${round}`, refreshToken: `rt-${round + 1}`, expiresAt: past };
    });
    assert.equal((await freshVaultCredential(h.accounts, h.oauth, "serial-account")).credential.accessToken, "new-1");
    assert.equal((await freshVaultCredential(h.accounts, h.oauth, "serial-account")).credential.accessToken, "new-2");
    assert.equal(h.refreshCalls(), 2);
  });

  it("adopts Claude Code's rotated lineage on invalid_grant when a live store is given", async () => {
    const h = harness({ accessToken: "old", refreshToken: "dead-rt", expiresAt: past }, async () => {
      throw new OAuthError("invalid_grant", "rejected");
    });
    const live: OAuthCredential = { accessToken: "live-a", refreshToken: "live-rt", expiresAt: future };
    const out = await freshVaultCredential(h.accounts, h.oauth, "adopt-account", {
      liveStore: liveStore(live),
    });
    assert.deepEqual(out.credential, live);
    assert.equal(out.refreshed, true);
    assert.deepEqual(h.saved(), [live]);
  });

  it("surfaces invalid_grant when there is nothing to adopt", async () => {
    const h = harness({ accessToken: "old", refreshToken: "dead-rt", expiresAt: past }, async () => {
      throw new OAuthError("invalid_grant", "rejected");
    });
    await assert.rejects(
      () => freshVaultCredential(h.accounts, h.oauth, "no-adopt-account"),
      (err: unknown) => err instanceof OAuthError && err.kind === "invalid_grant",
    );
    // Concurrent joiners see the same failure, and the key is free afterwards.
    await assert.rejects(
      () =>
        freshVaultCredential(h.accounts, h.oauth, "no-adopt-account", {
          liveStore: liveStore(undefined),
        }),
      OAuthError,
    );
    assert.equal(h.refreshCalls(), 2);
  });

  it("rejects an unknown account", async () => {
    const h = harness(undefined, async () => {
      throw new Error("unreachable");
    });
    await assert.rejects(
      () => freshVaultCredential(h.accounts, h.oauth, "missing-account"),
      /Unknown subscription account/,
    );
  });
});
