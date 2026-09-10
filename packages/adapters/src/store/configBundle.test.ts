import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Profile } from "@swisscode/core";
import { createBundleRegistry } from "./configBundle.js";
import { FileProfileRepository } from "./fileProfiles.js";
import { FileProviderAccountRepository } from "./providerAccounts.js";
import { FileCustomProviderStore } from "./customProviders.js";
import { FileSettingsStore } from "./fileSettings.js";
import { FileAccountRepository } from "../subscriptions/accountVault.js";

async function registry() {
  const home = await mkdtemp(join(tmpdir(), "swb-"));
  return createBundleRegistry({
    profiles: new FileProfileRepository(join(home, "profiles.json")),
    vault: new FileAccountRepository(join(home, "subscriptions")),
    providerAccounts: new FileProviderAccountRepository(join(home, "accounts")),
    customProviders: new FileCustomProviderStore(join(home, "custom-providers.json")),
    settings: new FileSettingsStore(join(home, "settings.json")),
    secretKeysFor: async () => new Set(["apiKey"]),
  });
}

/** A profile using every Track A/B field, so the bundle must carry them all. */
function routed(): Profile {
  return {
    name: "work",
    agentId: "claude-code",
    providerId: "openrouter",
    providerConfig: { apiKey: "sk-or-test" },
    modelRoutes: [{ kind: "subscription", match: "claude-opus-4-6", upstreamModel: "opus-max" }],
    session: {
      effort: "high",
      permissionMode: "plan",
      claudeSettings: { env: { FOO: "bar" } },
    },
  };
}

describe("config bundle carries the new profile fields", () => {
  it("export → import round-trips modelRoutes/session byte-identical", async () => {
    const src = await registry();
    await src.importBundle(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        includeSecrets: true,
        profiles: [routed()],
        subscriptionAccounts: [],
        providerAccounts: [],
        customProviders: [],
      },
      { overwrite: false },
    );
    const exported = await src.exportBundle(true);
    assert.equal(exported.version, 1);
    assert.deepEqual(exported.profiles, [routed()]);

    const dst = await registry();
    const results = await dst.importBundle(exported, { overwrite: false });
    const profiles = results.find((r) => r.store === "profiles");
    assert.equal(profiles?.imported, 1);
    assert.deepEqual(profiles?.errors, []);
    assert.deepEqual((await dst.exportBundle(true)).profiles, [routed()]);
  });

  it("secrets-excluded export blanks keys but keeps routes/session", async () => {
    const src = await registry();
    await src.importBundle(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        includeSecrets: true,
        profiles: [routed()],
        subscriptionAccounts: [],
        providerAccounts: [],
        customProviders: [],
      },
      { overwrite: false },
    );
    const stripped = await src.exportBundle(false);
    assert.equal(stripped.secretsStripped, true);
    assert.equal(stripped.profiles[0]?.providerConfig?.["apiKey"], "");
    assert.deepEqual(stripped.profiles[0]?.modelRoutes, routed().modelRoutes);
    assert.deepEqual(stripped.profiles[0]?.session, routed().session);
  });
});

describe("config bundle carries the global settings record", () => {
  const settings = { rotationEnabled: true, rotationStrategy: "least-used", updateMode: "auto" } as const;

  it("export always writes settings; import restores them onto a fresh home", async () => {
    const src = await registry();
    assert.deepEqual((await src.exportBundle(true)).settings, {
      rotationEnabled: false,
      rotationStrategy: "reset-soonest",
      updateMode: "auto",
    });
    const dst = await registry();
    const results = await dst.importBundle(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        includeSecrets: true,
        profiles: [],
        subscriptionAccounts: [],
        providerAccounts: [],
        customProviders: [],
        settings,
      },
      { overwrite: false },
    );
    const row = results.find((r) => r.store === "settings");
    assert.deepEqual({ imported: row?.imported, skipped: row?.skipped, errors: row?.errors }, {
      imported: 1,
      skipped: 0,
      errors: [],
    });
    assert.deepEqual((await dst.exportBundle(true)).settings, settings);
  });

  it("an old bundle without settings imports clean and keeps the local toggle", async () => {
    const dst = await registry();
    const results = await dst.importBundle(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        includeSecrets: true,
        profiles: [],
        subscriptionAccounts: [],
        providerAccounts: [],
        customProviders: [],
      },
      { overwrite: false },
    );
    const row = results.find((r) => r.store === "settings");
    assert.deepEqual({ imported: row?.imported, skipped: row?.skipped, errors: row?.errors }, {
      imported: 0,
      skipped: 0,
      errors: [],
    });
    // Defaults, and the inventory counts no settings file yet.
    assert.deepEqual((await dst.exportBundle(true)).settings, {
      rotationEnabled: false,
      rotationStrategy: "reset-soonest",
      updateMode: "auto",
    });
    assert.equal((await dst.inventory()).settings, 0);
  });

  it("no-overwrite import keeps the local toggle; overwrite takes the bundle's", async () => {
    const dst = await registry();
    const first = await dst.importBundle(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        includeSecrets: true,
        profiles: [],
        subscriptionAccounts: [],
        providerAccounts: [],
        customProviders: [],
        settings,
      },
      { overwrite: false },
    );
    assert.equal(first.find((r) => r.store === "settings")?.imported, 1);
    assert.equal((await dst.inventory()).settings, 1);

    const kept = await dst.importBundle(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        includeSecrets: true,
        profiles: [],
        subscriptionAccounts: [],
        providerAccounts: [],
        customProviders: [],
        settings: { rotationEnabled: false, rotationStrategy: "reset-soonest" },
      },
      { overwrite: false },
    );
    assert.equal(kept.find((r) => r.store === "settings")?.skipped, 1);
    assert.deepEqual((await dst.exportBundle(true)).settings, settings);

    await dst.importBundle(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        includeSecrets: true,
        profiles: [],
        subscriptionAccounts: [],
        providerAccounts: [],
        customProviders: [],
        settings: { rotationEnabled: false, rotationStrategy: "reset-soonest" },
      },
      { overwrite: true },
    );
    assert.deepEqual((await dst.exportBundle(true)).settings, {
      rotationEnabled: false,
      rotationStrategy: "reset-soonest",
      updateMode: "auto",
    });
  });

  it("keys() covers settings in import order", async () => {
    const reg = await registry();
    assert.deepEqual(reg.keys(), [
      "customProviders",
      "profiles",
      "providerAccounts",
      "subscriptionAccounts",
      "settings",
    ]);
  });
});
