import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProfileError } from "@swisscode/core";
import { customProviderPort } from "../providers/customProvider.js";
import { FileCustomProviderStore } from "./customProviders.js";
import { createBundleRegistry } from "./configBundle.js";
import { FileProfileRepository } from "./fileProfiles.js";
import { FileAccountRepository } from "../subscriptions/accountVault.js";
import { FileProviderAccountRepository } from "./providerAccounts.js";
import type { CustomProviderDef } from "@swisscode/core";

function def(over: Partial<CustomProviderDef> = {}): CustomProviderDef {
  return {
    id: "my-gateway",
    displayName: "My Gateway",
    fields: [
      { key: "apiKey", label: "API Key", secret: true, required: true },
      { key: "model", label: "Model", secret: false, required: false },
    ],
    envStatic: { ANTHROPIC_BASE_URL: "https://gw.example.com" },
    envFromConfig: { ANTHROPIC_AUTH_TOKEN: "apiKey" },
    modelEnvVar: "ANTHROPIC_MODEL",
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

describe("custom provider validation", () => {
  it("rejects bad ids, shadows, and dangling mappings", async () => {
    const store = new FileCustomProviderStore(join(await mkdtemp(join(tmpdir(), "swc-")), "p.json"));
    await assert.rejects(() => store.save(def({ id: "Bad id" })), ProfileError);
    await assert.rejects(() => store.save(def({ id: "openrouter" }), ["openrouter"]), ProfileError);
    await assert.rejects(
      () => store.save(def({ envFromConfig: { X: "nope" } })),
      /unknown field/,
    );
    await assert.rejects(() => store.save(def({ modelEnvVar: "bad-name" })), /env var name/);
  });

  it("round-trips definitions sorted by id", async () => {
    const store = new FileCustomProviderStore(join(await mkdtemp(join(tmpdir(), "swc-")), "p.json"));
    await store.save(def({ id: "b-def", displayName: "B" }));
    await store.save(def({ id: "a-def", displayName: "A" }));
    assert.deepEqual((await store.list()).map((d) => d.id), ["a-def", "b-def"]);
    assert.equal(await store.remove("a-def"), true);
    assert.equal(await store.remove("a-def"), false);
  });
});

describe("customProviderPort", () => {
  it("maps static + config + model env", () => {
    const port = customProviderPort(def());
    assert.equal(port.accountCapabilities.usageMetrics, false);
    assert.deepEqual(
      port.buildEnv({ apiKey: "k", model: "m1" }, { model: "m2" }),
      {
        ANTHROPIC_BASE_URL: "https://gw.example.com",
        ANTHROPIC_AUTH_TOKEN: "k",
        ANTHROPIC_MODEL: "m2",
      },
    );
    // Profile model wins; config model is the fallback; empties skipped.
    assert.equal(port.buildEnv({ apiKey: "k", model: "m1" }, {})["ANTHROPIC_MODEL"], "m1");
    assert.deepEqual(port.buildEnv({}, {}), { ANTHROPIC_BASE_URL: "https://gw.example.com" });
  });
});

describe("bundle registry", () => {
  async function deps() {
    const dir = await mkdtemp(join(tmpdir(), "swb-"));
    const stores = {
      profiles: new FileProfileRepository(join(dir, "profiles.json")),
      vault: new FileAccountRepository(join(dir, "subscriptions")),
      providerAccounts: new FileProviderAccountRepository(join(dir, "accounts")),
      customProviders: new FileCustomProviderStore(join(dir, "custom-providers.json")),
      secretKeysFor: async (providerId: string) =>
        new Set(providerId === "openrouter" ? ["apiKey"] : []),
    };
    return { dir, registry: createBundleRegistry(stores), stores };
  }

  it("exports and reimports everything", async () => {
    const { registry, stores } = await deps();
    await stores.customProviders.save(def());
    await stores.profiles.save({
      name: "work",
      agentId: "claude-code",
      providerId: "my-gateway",
      providerAccountId: "k1",
    });
    await stores.providerAccounts.save({
      id: "k1",
      providerId: "my-gateway",
      label: "K",
      config: { apiKey: "[REDACTED]" },
      createdAt: "",
      updatedAt: "",
    });
    await stores.vault.save(
      { id: "sub", label: "Sub", createdAt: "", updatedAt: "" },
      { accessToken: "a", refreshToken: "r" },
    );

    const bundle = await registry.exportBundle(true);
    assert.equal(bundle.version, 1);
    assert.equal(bundle.includeSecrets, true);

    // Wipe and restore into fresh stores.
    const fresh = await deps();
    const results = await fresh.registry.importBundle(bundle, { overwrite: true });
    const byStore = Object.fromEntries(results.map((r) => [r.store, r]));
    assert.equal(byStore["customProviders"].imported, 1);
    assert.equal(byStore["profiles"].imported, 1);
    assert.equal(byStore["providerAccounts"].imported, 1);
    assert.equal(byStore["subscriptionAccounts"].imported, 1);
    assert.deepEqual(
      results.flatMap((r) => r.errors),
      [],
    );
    assert.equal((await fresh.stores.vault.loadCredential("sub"))?.refreshToken, "r");
  });

  it("rejects version conflicts and honors overwrite=false", async () => {
    const { registry, stores } = await deps();
    await stores.profiles.save({ name: "work", agentId: "claude-code", providerId: "openrouter" });
    const bundle = await registry.exportBundle(false);

    const bad = await registry.importBundle({ ...bundle, version: 999 }, { overwrite: true });
    assert.ok(bad.every((r) => r.imported === 0));
    assert.ok(bad[0].errors.join().includes("Unsupported bundle version"));

    const skip = await registry.importBundle(bundle, { overwrite: false });
    assert.equal(skip.find((r) => r.store === "profiles")?.skipped, 1);
  });

  it("strips secrets on request and warns on restore", async () => {
    const { registry, stores } = await deps();
    await stores.providerAccounts.save({
      id: "o1",
      providerId: "openrouter",
      label: "O",
      config: { apiKey: "[REDACTED]", model: "x" },
      createdAt: "",
      updatedAt: "",
    });
    const bundle = await registry.exportBundle(false);
    assert.equal(bundle.providerAccounts[0].config["apiKey"], "");
    assert.equal(bundle.providerAccounts[0].config["model"], "x");
    assert.equal(bundle.subscriptionAccounts.length, 0);

    const fresh = await deps();
    const results = await fresh.registry.importBundle(bundle, { overwrite: true });
    const res = results.find((r) => r.store === "providerAccounts");
    assert.equal(res?.imported, 1);
    assert.ok(res?.errors.join().includes("blank secrets"));
  });
});
