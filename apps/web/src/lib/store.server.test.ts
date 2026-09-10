// End-to-end over the real file stores, rooted at a throwaway SWISSCODE_HOME.
// Nothing here reads ~/.swisscode, ~/.claude or the Keychain: only the profile,
// account and custom-provider paths are exercised, and they all hang off the
// env var set before the module binds them.

import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskSecretValue } from "@swisscode/core";
import type { OAuthCredential } from "@swisscode/core";
import {
  ClaudeActiveCredentialStore,
  FileAccountRepository,
} from "@swisscode/adapters";
import type { ActiveWriteReport, ExecFn } from "@swisscode/adapters";

const home = await mkdtemp(join(tmpdir(), "swisscode-web-store-"));
process.env["SWISSCODE_HOME"] = home;
const store = await import("./store.server.js");

after(async () => {
  await rm(home, { recursive: true, force: true });
});

const SECRET = "gw-live-7f3a91c2b8d4";

await store.saveCustomProvider({
  id: "my-gateway",
  displayName: "My Gateway",
  fields: [
    { key: "token", label: "Token", secret: true, required: true },
    { key: "model", label: "Model", secret: false, required: false },
  ],
  envStatic: { MY_BASE_URL: "https://gateway.example.com" },
  // The whole point: a secret is free to land under a name no pattern guesses.
  envFromConfig: { MY_PASSWORD: "token" },
  modelEnvVar: "ANTHROPIC_MODEL",
  createdAt: "",
  updatedAt: "",
});
await store.saveProviderAccount({
  id: "main",
  providerId: "my-gateway",
  label: "Main",
  config: { token: SECRET, model: "gw/model-1" },
  createdAt: "",
  updatedAt: "",
});
await store.saveProfile({
  name: "work",
  agentId: "claude-code",
  providerId: "my-gateway",
  providerAccountId: "main",
});

describe("previewProfile", () => {
  it("masks the secret by value, wherever the provider mapped it", async () => {
    const preview = await store.previewProfile("work");
    assert.equal(preview.env["MY_PASSWORD"], maskSecretValue(SECRET));
    assert.ok(
      !JSON.stringify(preview).includes(SECRET),
      "the raw secret must never reach the browser",
    );
  });

  it("leaves non-secrets readable — the preview has to stay useful", async () => {
    const preview = await store.previewProfile("work");
    assert.equal(preview.env["MY_BASE_URL"], "https://gateway.example.com");
    assert.equal(preview.env["ANTHROPIC_MODEL"], "gw/model-1");
    assert.equal(preview.command, "claude");
  });
});

describe("updateProviderAccount", () => {
  it("keeps the stored key when the form submits the mask back", async () => {
    const summaries = await store.listProviderAccountSummaries("my-gateway");
    const masked = summaries[0]?.config["token"];
    assert.equal(masked, maskSecretValue(SECRET));

    await store.updateProviderAccount("my-gateway", "main", {
      label: "Renamed",
      config: { token: masked as string, model: "gw/model-2" },
    });

    const [stored] = await store.listProviderAccounts("my-gateway");
    assert.equal(stored?.config["token"], SECRET);
    assert.equal(stored?.config["model"], "gw/model-2");
    assert.equal(stored?.label, "Renamed");

    // The bug was on disk, so assert on disk.
    const raw = JSON.parse(
      await readFile(join(home, "accounts", "my-gateway", "main.json"), "utf8"),
    ) as { config: Record<string, string> };
    assert.equal(raw.config["token"], SECRET);
  });

  it("still keeps the stored key when the field is left blank", async () => {
    await store.updateProviderAccount("my-gateway", "main", { config: { token: "" } });
    const [stored] = await store.listProviderAccounts("my-gateway");
    assert.equal(stored?.config["token"], SECRET);
  });

  it("stores a genuinely retyped key", async () => {
    await store.updateProviderAccount("my-gateway", "main", { config: { token: "gw-live-new" } });
    const [stored] = await store.listProviderAccounts("my-gateway");
    assert.equal(stored?.config["token"], "gw-live-new");
    await store.updateProviderAccount("my-gateway", "main", { config: { token: SECRET } });
  });
});

describe("globalSettings", () => {
  it("reads as rotation-off defaults before the first save", async () => {
    assert.deepEqual(await store.getGlobalSettings(), {
      rotationEnabled: false,
      rotationStrategy: "reset-soonest",
    });
  });

  it("round-trips a save", async () => {
    await store.saveGlobalSettings({ rotationEnabled: true, rotationStrategy: "least-used" });
    assert.deepEqual(await store.getGlobalSettings(), {
      rotationEnabled: true,
      rotationStrategy: "least-used",
    });
    await store.saveGlobalSettings({ rotationEnabled: false, rotationStrategy: "reset-soonest" });
  });

  it("counts settings in the bundle inventory", async () => {
    await store.saveGlobalSettings({ rotationEnabled: false, rotationStrategy: "reset-soonest" });
    const inventory = await store.getBundleInventory();
    assert.equal(inventory["settings"], 1);
  });

  it("imports a pre-settings bundle clean, leaving rotation alone", async () => {
    const before = await store.getGlobalSettings();
    const results = await store.importConfigBundle(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        includeSecrets: false,
        profiles: [],
        subscriptionAccounts: [],
        providerAccounts: [],
        customProviders: [],
      },
      false,
    );
    const settings = results.find((r) => r.store === "settings");
    assert.deepEqual(settings, { store: "settings", imported: 0, skipped: 0, errors: [] });
    assert.ok(results.every((r) => r.errors.length === 0));
    assert.deepEqual(await store.getGlobalSettings(), before);
  });
});

describe("switchSubscriptionAccount verify", () => {
  const scratch: string[] = [];
  after(async () => {
    await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
  });
  afterEach(() => {
    store.setActiveStoreOverride(undefined);
    store.setEmailLookupOverride(undefined);
  });

  const oldCred: OAuthCredential = {
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    expiresAt: Date.now() + 3_600_000,
  };
  const newCred: OAuthCredential = {
    accessToken: "new-access-token",
    refreshToken: "new-refresh-token",
    expiresAt: Date.now() + 3_600_000,
  };

  async function seedVault(): Promise<void> {
    // The server module binds its vault to SWISSCODE_HOME at import — seed the
    // same directory it reads. Unexpired, so freshVaultCredential takes the
    // fast path and no network is touched.
    const repo = new FileAccountRepository(join(home, "subscriptions"));
    const now = new Date().toISOString();
    await repo.save(
      { id: "old", label: "Old", email: "old@example.com", createdAt: now, updatedAt: now },
      oldCred,
    );
    await repo.save(
      { id: "new", label: "New", email: "new@example.com", createdAt: now, updatedAt: now },
      newCred,
    );
  }

  async function scratchHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "swisscode-switch-"));
    scratch.push(dir);
    return dir;
  }

  function stubEmails(): void {
    store.setEmailLookupOverride({
      fetchEmail: async (token: string) => {
        if (token === newCred.accessToken) return "new@example.com";
        if (token === oldCred.accessToken) return "old@example.com";
        return undefined;
      },
    });
  }

  it("returns email proof when the switch lands", async () => {
    await seedVault();
    stubEmails();
    const active = new ClaudeActiveCredentialStore({
      configHome: await scratchHome(),
      keychain: false,
    });
    await active.writeActive(oldCred);
    store.setActiveStoreOverride(active);

    const result = await store.switchSubscriptionAccount("new", true);

    assert.equal(result.switched, true);
    assert.equal(result.verified, true);
    assert.equal(result.verifiedEmail, "new@example.com");
    assert.equal(result.matchedAccountId, "new");
    assert.equal(result.writtenBackend, "file");
  });

  it("reports a revert instead of success when a session writes back", async () => {
    await seedVault();
    stubEmails();
    // A running `claude` on the old lineage persists it into the shared store
    // after our write — the switch must say so, not toast success.
    class RevertingStore extends ClaudeActiveCredentialStore {
      override async writeActiveReport(credential: OAuthCredential): Promise<ActiveWriteReport> {
        const report = await super.writeActiveReport(credential);
        await super.writeActiveReport(oldCred);
        return report;
      }
    }
    const active = new RevertingStore({
      configHome: await scratchHome(),
      keychain: false,
    });
    await active.writeActive(oldCred);
    store.setActiveStoreOverride(active);

    const result = await store.switchSubscriptionAccount("new", true);

    assert.equal(result.switched, false);
    assert.equal(result.verified, false);
    assert.equal(result.revertSuspected, true);
    assert.match(result.warning ?? "", /Old/);
  });

  it("verifies a file-only switch when no Keychain item exists", async () => {
    await seedVault();
    stubEmails();
    const alwaysMissing: ExecFn = async () => {
      throw Object.assign(new Error("security exited 44"), { code: 44 });
    };
    const active = new ClaudeActiveCredentialStore({
      configHome: await scratchHome(),
      execFn: alwaysMissing,
    });
    store.setActiveStoreOverride(active);

    const result = await store.switchSubscriptionAccount("new", true);

    assert.equal(result.switched, true);
    assert.equal(result.verified, true);
    assert.equal(result.verifiedEmail, "new@example.com");
    assert.match(result.warning ?? "", /No Keychain item/);
  });
});
