import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OAuthError } from "@swisscode/core";
import type {
  AccountRepository,
  ActiveCredentialState,
  ActiveCredentialStore,
  OAuthClient,
  OAuthCredential,
} from "@swisscode/core";
import { freshVaultCredential } from "./freshCredential.js";

const future = Date.now() + 3600_000;
const past = Date.now() - 1000;

/** Lock files must never land in the real ~/.swisscode. */
async function lockDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "fresh-lock-"));
}

interface Harness {
  accounts: AccountRepository;
  oauth: OAuthClient;
  refreshCalls: () => number;
  saved: () => OAuthCredential[];
  stored: () => OAuthCredential | undefined;
  setStored: (credential: OAuthCredential) => void;
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
    setStored: (credential: OAuthCredential) => {
      current = credential;
    },
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

/** Live store that records writes, i.e. Claude Code sharing our lineage. */
function recordingLiveStore(initial: OAuthCredential | undefined): {
  store: ActiveCredentialStore;
  writes: () => OAuthCredential[];
} {
  let current = initial;
  const writes: OAuthCredential[] = [];
  return {
    store: {
      readActive: async (): Promise<ActiveCredentialState> =>
        current ? { backend: "file", credential: current } : { backend: "none" },
      writeActive: async (credential: OAuthCredential) => {
        writes.push(credential);
        current = credential;
      },
    },
    writes: () => writes,
  };
}

describe("freshVaultCredential", () => {
  it("returns a live credential without refreshing", async () => {
    const h = harness({ accessToken: "a", refreshToken: "r", expiresAt: future }, async () => {
      throw new Error("unreachable");
    });
    const out = await freshVaultCredential(h.accounts, h.oauth, "live-account", {
      lockDir: await lockDir(),
    });
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
    const dir = await lockDir();
    const calls = [
      freshVaultCredential(h.accounts, h.oauth, "concurrent-account", { lockDir: dir }),
      freshVaultCredential(h.accounts, h.oauth, "concurrent-account", { lockDir: dir }),
      freshVaultCredential(h.accounts, h.oauth, "concurrent-account", { lockDir: dir }),
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
    const dir = await lockDir();
    assert.equal(
      (await freshVaultCredential(h.accounts, h.oauth, "serial-account", { lockDir: dir })).credential
        .accessToken,
      "new-1",
    );
    assert.equal(
      (await freshVaultCredential(h.accounts, h.oauth, "serial-account", { lockDir: dir })).credential
        .accessToken,
      "new-2",
    );
    assert.equal(h.refreshCalls(), 2);
  });

  it("adopts Claude Code's rotated lineage on invalid_grant when a live store is given", async () => {
    const h = harness({ accessToken: "old", refreshToken: "dead-rt", expiresAt: past }, async () => {
      throw new OAuthError("invalid_grant", "rejected");
    });
    const live: OAuthCredential = { accessToken: "live-a", refreshToken: "live-rt", expiresAt: future };
    const out = await freshVaultCredential(h.accounts, h.oauth, "adopt-account", {
      liveStore: liveStore(live),
      lockDir: await lockDir(),
    });
    assert.deepEqual(out.credential, live);
    assert.equal(out.refreshed, true);
    assert.deepEqual(h.saved(), [live]);
  });

  it("refuses stranger adoption on the switch path (adoptLive:false)", async () => {
    // The switch-that-wasn't: dead vault credential, live login belonging to
    // nobody in the vault. Adopting it would persist the stranger into this
    // slot and verify a switch that never happened — surface invalid_grant
    // with the vault untouched instead.
    const h = harness({ accessToken: "old", refreshToken: "dead-rt", expiresAt: past }, async () => {
      throw new OAuthError("invalid_grant", "rejected");
    });
    const live: OAuthCredential = { accessToken: "live-a", refreshToken: "live-rt", expiresAt: future };
    const dir = await lockDir();
    await assert.rejects(
      () =>
        freshVaultCredential(h.accounts, h.oauth, "switch-account", {
          liveStore: liveStore(live),
          adoptLive: false,
          lockDir: dir,
        }),
      (err: unknown) => err instanceof OAuthError && err.kind === "invalid_grant",
    );
    assert.deepEqual(h.saved(), []);
  });

  it("surfaces invalid_grant when there is nothing to adopt", async () => {
    const h = harness({ accessToken: "old", refreshToken: "dead-rt", expiresAt: past }, async () => {
      throw new OAuthError("invalid_grant", "rejected");
    });
    const dir = await lockDir();
    await assert.rejects(
      () => freshVaultCredential(h.accounts, h.oauth, "no-adopt-account", { lockDir: dir }),
      (err: unknown) => err instanceof OAuthError && err.kind === "invalid_grant",
    );
    // Concurrent joiners see the same failure, and the key is free afterwards.
    await assert.rejects(
      () =>
        freshVaultCredential(h.accounts, h.oauth, "no-adopt-account", {
          liveStore: liveStore(undefined),
          lockDir: dir,
        }),
      OAuthError,
    );
    assert.equal(h.refreshCalls(), 2);
  });

  it("rejects an unknown account", async () => {
    const h = harness(undefined, async () => {
      throw new Error("unreachable");
    });
    const dir = await lockDir();
    await assert.rejects(
      () => freshVaultCredential(h.accounts, h.oauth, "missing-account", { lockDir: dir }),
      /Unknown subscription account/,
    );
  });

  // ---- Shared lineage with Claude Code (never log the user out) ----

  it("adopts Claude Code's still-valid access token instead of refreshing a shared lineage", async () => {
    const h = harness({ accessToken: "stale", refreshToken: "shared-rt", expiresAt: past }, async () => {
      throw new Error("refreshing a shared lineage would log Claude Code out");
    });
    const live = recordingLiveStore({
      accessToken: "live-a",
      refreshToken: "shared-rt",
      expiresAt: future,
    });
    const out = await freshVaultCredential(h.accounts, h.oauth, "shared-account", {
      liveStore: live.store,
      lockDir: await lockDir(),
    });
    assert.equal(out.credential.accessToken, "live-a");
    assert.equal(out.refreshed, false);
    assert.equal(h.refreshCalls(), 0);
    // Vault caught up; Claude Code's store was not touched.
    assert.equal(h.stored()?.accessToken, "live-a");
    assert.deepEqual(live.writes(), []);
  });

  it("mirrors a shared-lineage refresh back into Claude Code's store", async () => {
    const h = harness({ accessToken: "old", refreshToken: "shared-rt", expiresAt: past }, async () => ({
      accessToken: "new-a",
      refreshToken: "rotated-rt",
      expiresAt: future,
    }));
    const live = recordingLiveStore({
      accessToken: "old",
      refreshToken: "shared-rt",
      expiresAt: past,
    });
    const out = await freshVaultCredential(h.accounts, h.oauth, "shared-expired", {
      liveStore: live.store,
      lockDir: await lockDir(),
    });
    assert.equal(h.refreshCalls(), 1);
    assert.equal(out.credential.refreshToken, "rotated-rt");
    assert.equal(h.stored()?.refreshToken, "rotated-rt");
    // Without this write, the old refresh token Claude Code holds is dead.
    assert.deepEqual(live.writes(), [out.credential]);
  });

  it("never writes a live store that holds a different lineage", async () => {
    const h = harness({ accessToken: "old", refreshToken: "ours-rt", expiresAt: past }, async () => ({
      accessToken: "new-a",
      refreshToken: "ours-rt-2",
      expiresAt: future,
    }));
    const live = recordingLiveStore({
      accessToken: "theirs",
      refreshToken: "theirs-rt",
      expiresAt: future,
    });
    const out = await freshVaultCredential(h.accounts, h.oauth, "unshared-account", {
      liveStore: live.store,
      lockDir: await lockDir(),
    });
    assert.equal(out.credential.refreshToken, "ours-rt-2");
    assert.deepEqual(live.writes(), []);
  });

  it("reports a failed mirror as a warning and still returns the refreshed credential", async () => {
    const h = harness({ accessToken: "old", refreshToken: "shared-rt", expiresAt: past }, async () => ({
      accessToken: "new-a",
      refreshToken: "rotated-rt",
      expiresAt: future,
    }));
    const store: ActiveCredentialStore = {
      readActive: async () => ({
        backend: "keychain",
        credential: { accessToken: "old", refreshToken: "shared-rt", expiresAt: past },
      }),
      writeActive: async () => {
        throw new Error("keychain denied");
      },
    };
    const warnings: string[] = [];
    const out = await freshVaultCredential(h.accounts, h.oauth, "mirror-fail", {
      liveStore: store,
      lockDir: await lockDir(),
      onWarning: (message) => warnings.push(message),
    });
    assert.equal(out.credential.refreshToken, "rotated-rt");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] as string, /keychain denied/);
  });

  // ---- Cross-process lock ----

  it("waits for another process's lock and skips the refresh it already did", async () => {
    const h = harness({ accessToken: "old", refreshToken: "rt-1", expiresAt: past }, async () => {
      throw new Error("another process already refreshed this account");
    });
    const dir = await lockDir();
    const lockPath = join(dir, "locked-account.lock");
    await writeFile(lockPath, "12345 other-process\n", { encoding: "utf8", mode: 0o600 });

    const pending = freshVaultCredential(h.accounts, h.oauth, "locked-account", { lockDir: dir });
    // The "other process" finishes: it writes the rotation and releases.
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.setStored({ accessToken: "from-other", refreshToken: "rt-2", expiresAt: future });
    await rm(lockPath, { force: true });

    const out = await pending;
    assert.equal(out.credential.accessToken, "from-other");
    assert.equal(out.refreshed, false);
    assert.equal(h.refreshCalls(), 0);
  });
});

describe("freshVaultCredential force", () => {
  it("rotates a still-valid credential and mirrors it to a shared lineage", async () => {
    // The proxy's 401 path: expiresAt is in the future, but upstream rejected
    // the token. Rotating here (rather than in the proxy) is what keeps the
    // account lock and the mirror-back in play.
    const shared: OAuthCredential = { accessToken: "rejected", refreshToken: "rt-1", expiresAt: future };
    const h = harness(shared, async () => ({
      accessToken: "rotated",
      refreshToken: "rt-2",
      expiresAt: future,
    }));
    const live = recordingLiveStore(shared);
    const out = await freshVaultCredential(h.accounts, h.oauth, "forced-account", {
      lockDir: await lockDir(),
      liveStore: live.store,
      force: true,
    });
    assert.equal(out.credential.accessToken, "rotated");
    assert.equal(h.refreshCalls(), 1);
    // Without the mirror the user's next `claude` run would be logged out.
    assert.deepEqual(live.writes().map((c) => c.accessToken), ["rotated"]);
  });

  it("does not re-adopt the very token upstream rejected", async () => {
    // Claude Code holds the SAME access token: adopting it would 401 again.
    const shared: OAuthCredential = { accessToken: "rejected", refreshToken: "rt-1", expiresAt: future };
    const h = harness(shared, async () => ({
      accessToken: "rotated",
      refreshToken: "rt-2",
      expiresAt: future,
    }));
    const out = await freshVaultCredential(h.accounts, h.oauth, "forced-same", {
      lockDir: await lockDir(),
      liveStore: liveStore({ ...shared }),
      force: true,
    });
    assert.equal(out.credential.accessToken, "rotated");
    assert.equal(h.refreshCalls(), 1);
  });

  it("adopts a live token that has already moved on, spending no rotation", async () => {
    const h = harness({ accessToken: "rejected", refreshToken: "rt-1", expiresAt: future }, async () => {
      throw new Error("must not refresh: Claude Code already rotated the access token");
    });
    const out = await freshVaultCredential(h.accounts, h.oauth, "forced-adopt", {
      lockDir: await lockDir(),
      liveStore: liveStore({ accessToken: "newer", refreshToken: "rt-1", expiresAt: future }),
      force: true,
    });
    assert.equal(out.credential.accessToken, "newer");
    assert.equal(h.refreshCalls(), 0);
  });

  it("never joins an ordinary in-flight ask, which would return the rejected token", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const h = harness({ accessToken: "rejected", refreshToken: "rt-1", expiresAt: past }, async () => {
      await gate;
      return { accessToken: "rotated", refreshToken: "rt-2", expiresAt: future };
    });
    const dir = await lockDir();
    const ordinary = freshVaultCredential(h.accounts, h.oauth, "mixed-account", { lockDir: dir });
    const forced = freshVaultCredential(h.accounts, h.oauth, "mixed-account", {
      lockDir: dir,
      force: true,
    });
    release?.();
    const [a, b] = await Promise.all([ordinary, forced]);
    assert.equal(a.credential.accessToken, "rotated");
    assert.equal(b.credential.accessToken, "rotated");
  });

  it("still coalesces concurrent forced callers onto one rotation", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const h = harness({ accessToken: "rejected", refreshToken: "rt-1", expiresAt: future }, async () => {
      await gate;
      return { accessToken: "rotated", refreshToken: "rt-2", expiresAt: future };
    });
    const dir = await lockDir();
    const calls = [0, 1, 2].map(() =>
      freshVaultCredential(h.accounts, h.oauth, "forced-storm", { lockDir: dir, force: true }),
    );
    release?.();
    const results = await Promise.all(calls);
    // Three concurrent 401s must cost one rotation, not three invalid_grants.
    assert.equal(h.refreshCalls(), 1);
    for (const r of results) assert.equal(r.credential.accessToken, "rotated");
  });
});
