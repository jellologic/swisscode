import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ensureFreshCredential } from "@swisscode/core";
import type { ActiveCredentialState, ActiveCredentialStore, OAuthCredential } from "@swisscode/core";
import { FileAccountRepository } from "./accountVault.js";
import { ClaudeActiveCredentialStore } from "./activeStore.js";
import { AnthropicOAuthClient } from "./anthropic.js";
import { defaultLiveStore, mirrorRotatedCredential, resolveLiveStore } from "./liveMirror.js";

const future = Date.now() + 3600_000;
const past = Date.now() - 1000;

/** Stand-in for Claude Code's store; records every write. No fs, no keychain. */
function recordingLiveStore(initial: OAuthCredential | undefined): {
  store: ActiveCredentialStore;
  writes: () => OAuthCredential[];
  current: () => OAuthCredential | undefined;
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
    current: () => current,
  };
}

/** Token endpoint that always rotates to the given pair. */
function tokenEndpoint(access: string, refresh: string): { fetchFn: typeof fetch; calls: () => number } {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return new Response(
      JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => calls };
}

describe("mirrorRotatedCredential", () => {
  it("hands the rotation back when Claude Code holds the token we spent", async () => {
    const live = recordingLiveStore({ accessToken: "old-a", refreshToken: "shared-rt", expiresAt: past });
    const next: OAuthCredential = { accessToken: "new-a", refreshToken: "rotated-rt", expiresAt: future };
    const wrote = await mirrorRotatedCredential(
      live.store,
      { accessToken: "old-a", refreshToken: "shared-rt", expiresAt: past },
      next,
    );
    assert.equal(wrote, true);
    assert.deepEqual(live.writes(), [next]);
  });

  it("never writes a lineage Claude Code does not share", async () => {
    const live = recordingLiveStore({ accessToken: "theirs-a", refreshToken: "theirs-rt", expiresAt: future });
    const wrote = await mirrorRotatedCredential(
      live.store,
      { accessToken: "ours-a", refreshToken: "ours-rt", expiresAt: past },
      { accessToken: "ours-a2", refreshToken: "ours-rt2", expiresAt: future },
    );
    assert.equal(wrote, false);
    assert.deepEqual(live.writes(), []);
  });

  it("is a no-op when an inner layer already mirrored the same rotation", async () => {
    // Both the OAuth client and freshVaultCredential try to mirror; the second
    // one must not write a second time (each Keychain write costs a prompt).
    const next: OAuthCredential = { accessToken: "new-a", refreshToken: "rotated-rt", expiresAt: future };
    const live = recordingLiveStore(next);
    const wrote = await mirrorRotatedCredential(
      live.store,
      { accessToken: "old-a", refreshToken: "shared-rt", expiresAt: past },
      next,
    );
    assert.equal(wrote, false);
    assert.deepEqual(live.writes(), []);
  });

  it("skips a store-less caller, a refresh-token-less credential and a no-op rotation", async () => {
    const same: OAuthCredential = { accessToken: "a", refreshToken: "rt", expiresAt: future };
    assert.equal(await mirrorRotatedCredential(undefined, same, same), false);
    const live = recordingLiveStore(same);
    // A record with a blank refresh token has no lineage to compare against.
    assert.equal(
      await mirrorRotatedCredential(live.store, { accessToken: "a", refreshToken: "" }, same),
      false,
    );
    // Same refresh token back: nothing was spent, so nothing is owed.
    assert.equal(
      await mirrorRotatedCredential(live.store, same, { ...same, accessToken: "b" }),
      false,
    );
    assert.deepEqual(live.writes(), []);
  });

  it("warns instead of throwing when Claude Code's store refuses the write", async () => {
    const store: ActiveCredentialStore = {
      readActive: async () => ({
        backend: "keychain",
        credential: { accessToken: "old-a", refreshToken: "shared-rt", expiresAt: past },
      }),
      writeActive: async () => {
        throw new Error("keychain denied");
      },
    };
    const warnings: string[] = [];
    const wrote = await mirrorRotatedCredential(
      store,
      { accessToken: "old-a", refreshToken: "shared-rt", expiresAt: past },
      { accessToken: "new-a", refreshToken: "rotated-rt", expiresAt: future },
      (message) => warnings.push(message),
    );
    assert.equal(wrote, false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] as string, /keychain denied/);
  });

  it("survives an unreadable live store", async () => {
    const store: ActiveCredentialStore = {
      readActive: async () => {
        throw new Error("keychain locked");
      },
      writeActive: async () => {
        throw new Error("must not be reached");
      },
    };
    assert.equal(
      await mirrorRotatedCredential(
        store,
        { accessToken: "a", refreshToken: "rt", expiresAt: past },
        { accessToken: "b", refreshToken: "rt2", expiresAt: future },
      ),
      false,
    );
  });
});

describe("resolveLiveStore", () => {
  it("defaults to Claude Code's own store and only opts out on null", () => {
    // The default is the whole point: a caller that never heard of the mirror
    // still repairs the login its refresh invalidated.
    const fallback = resolveLiveStore(undefined);
    assert.ok(fallback instanceof ClaudeActiveCredentialStore);
    assert.equal(fallback, defaultLiveStore());
    assert.equal(resolveLiveStore(null), undefined);
    const injected = recordingLiveStore(undefined).store;
    assert.equal(resolveLiveStore(injected), injected);
  });
});

describe("AnthropicOAuthClient rotation mirror", () => {
  it("mirrors under the wiring apps/web uses (core ensureFreshCredential, no mirror options)", async () => {
    // apps/web/src/lib/store.server.ts calls
    // `ensureFreshCredential(vault, oauth, id, { onInvalidGrant: resync })`:
    // no liveStore, no onRefreshed, no lock. Before the mirror moved into the
    // rotation itself, that usage poll rotated a shared lineage into the vault
    // alone and logged Claude Code out.
    const shared: OAuthCredential = { accessToken: "old-a", refreshToken: "shared-rt", expiresAt: past };
    const vault = new FileAccountRepository(join(await mkdtemp(join(tmpdir(), "mirror-")), "subs"));
    await vault.save({ id: "personal", label: "Personal", createdAt: "", updatedAt: "" }, shared);
    const live = recordingLiveStore({ ...shared });
    const endpoint = tokenEndpoint("new-a", "rotated-rt");
    const oauth = new AnthropicOAuthClient({
      tokenHost: "http://token.invalid",
      fetchFn: endpoint.fetchFn,
      liveStore: live.store,
    });

    const out = await ensureFreshCredential(vault, oauth, "personal", {
      onInvalidGrant: async () => undefined,
    });

    assert.equal(endpoint.calls(), 1);
    assert.equal(out.credential.refreshToken, "rotated-rt");
    assert.equal((await vault.loadCredential("personal"))?.refreshToken, "rotated-rt");
    // Claude Code keeps a working login instead of a token we just spent.
    assert.deepEqual(live.writes(), [out.credential]);
    assert.equal(live.current()?.refreshToken, "rotated-rt");
  });

  it("leaves a private lineage alone", async () => {
    const live = recordingLiveStore({ accessToken: "theirs-a", refreshToken: "theirs-rt", expiresAt: future });
    const endpoint = tokenEndpoint("new-a", "rotated-rt");
    const oauth = new AnthropicOAuthClient({
      tokenHost: "http://token.invalid",
      fetchFn: endpoint.fetchFn,
      liveStore: live.store,
    });
    const next = await oauth.refresh({ accessToken: "old-a", refreshToken: "ours-rt", expiresAt: past });
    assert.equal(next.refreshToken, "rotated-rt");
    assert.deepEqual(live.writes(), []);
  });

  it("returns the rotation even when the mirror write fails", async () => {
    const warnings: string[] = [];
    const endpoint = tokenEndpoint("new-a", "rotated-rt");
    const oauth = new AnthropicOAuthClient({
      tokenHost: "http://token.invalid",
      fetchFn: endpoint.fetchFn,
      liveStore: {
        readActive: async () => ({
          backend: "keychain",
          credential: { accessToken: "old-a", refreshToken: "shared-rt", expiresAt: past },
        }),
        writeActive: async () => {
          throw new Error("keychain denied");
        },
      },
      onWarning: (message) => warnings.push(message),
    });
    const next = await oauth.refresh({ accessToken: "old-a", refreshToken: "shared-rt", expiresAt: past });
    assert.equal(next.accessToken, "new-a");
    assert.equal(warnings.length, 1);
  });
});
