import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProfileError } from "@swisscode/core";
import { customProviderPort } from "../providers/customProvider.js";
import { FileCustomProviderStore, loadCustomProviderPorts } from "./customProviders.js";
import { createBundleRegistry } from "./configBundle.js";
import { FileProfileRepository } from "./fileProfiles.js";
import { FileAccountRepository } from "../subscriptions/accountVault.js";
import { FileProviderAccountRepository } from "./providerAccounts.js";
import { StoreFileError } from "./atomicJson.js";
import { createProviderRegistry, defaultProviders } from "../registry.js";
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

  it("names the file when custom-providers.json is corrupt", async () => {
    const store = new FileCustomProviderStore(join(await mkdtemp(join(tmpdir(), "swc-")), "p.json"));
    await store.save(def());
    await writeFile(store.path, '{"providers": [', "utf8");
    await assert.rejects(() => store.list(), (err: unknown) => {
      assert.ok(err instanceof StoreFileError);
      assert.equal(err.path, store.path);
      return true;
    });
  });

  it("keeps both definitions when two saves race, and writes 0600", async () => {
    const store = new FileCustomProviderStore(join(await mkdtemp(join(tmpdir(), "swc-")), "p.json"));
    await Promise.all([store.save(def({ id: "a-def" })), store.save(def({ id: "b-def" }))]);
    assert.deepEqual((await store.list()).map((d) => d.id), ["a-def", "b-def"]);
    assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  });
});

describe("loadCustomProviderPorts", () => {
  it("ignores a hand-edited def that shadows a built-in", async () => {
    const store = new FileCustomProviderStore(join(await mkdtemp(join(tmpdir(), "swc-")), "p.json"));
    const builtin = defaultProviders()[0].id;
    // Bypass save(): reservedIds are enforced there, which is exactly why a
    // hand-edited file is the only way this record exists.
    await writeFile(
      store.path,
      JSON.stringify({ providers: [def({ id: builtin }), def({ id: "mine" })] }),
      "utf8",
    );
    const warnings: string[] = [];
    const ports = await loadCustomProviderPorts(store, { onWarn: (m) => warnings.push(m) });
    assert.deepEqual(ports.map((p) => p.id), ["mine"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`"${builtin}" shadows a built-in`));
    // And the registry that consumes them keeps the real built-in.
    assert.equal(createProviderRegistry(ports).get(builtin)?.id, builtin);
  });

  it("refuses to build a registry with duplicate ids", async () => {
    assert.throws(
      () => createProviderRegistry([customProviderPort(def({ id: "dup" })), customProviderPort(def({ id: "dup" }))]),
      ProfileError,
    );
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
    const customProviders = new FileCustomProviderStore(join(dir, "custom-providers.json"));
    const stores = {
      profiles: new FileProfileRepository(join(dir, "profiles.json")),
      vault: new FileAccountRepository(join(dir, "subscriptions")),
      providerAccounts: new FileProviderAccountRepository(join(dir, "accounts"), { onWarn: () => undefined }),
      customProviders,
      // Mirrors the live registry lookup: built-in fields, else the custom def.
      secretKeysFor: async (providerId: string) => {
        if (providerId === "openrouter") return new Set(["apiKey"]);
        const stored = await customProviders.get(providerId);
        return new Set((stored?.fields ?? []).filter((f) => f.secret).map((f) => f.key));
      },
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

  it("strips inline profile keys and custom envStatic, and says so in the file", async () => {
    const { registry, stores } = await deps();
    await stores.customProviders.save(def());
    await stores.profiles.save({
      name: "inline",
      agentId: "claude-code",
      providerId: "my-gateway",
      providerConfig: { apiKey: "sk-live-inline-key", model: "m1" },
    });
    // A provider this machine no longer knows: fall back to the name pattern.
    await stores.profiles.save({
      name: "ghost",
      agentId: "claude-code",
      providerId: "deleted-gateway",
      providerConfig: { password: "hunter2", region: "eu" },
    });

    const stripped = await registry.exportBundle(false);
    assert.equal(stripped.secretsStripped, true);
    const byName = Object.fromEntries(stripped.profiles.map((p) => [p.name, p]));
    assert.equal(byName["inline"].providerConfig?.["apiKey"], "");
    assert.equal(byName["inline"].providerConfig?.["model"], "m1");
    assert.equal(byName["ghost"].providerConfig?.["password"], "");
    assert.equal(byName["ghost"].providerConfig?.["region"], "eu");
    assert.equal(stripped.customProviders[0].envStatic?.["ANTHROPIC_BASE_URL"], "");
    assert.ok(!JSON.stringify(stripped).includes("sk-live-inline-key"));
    assert.ok(!JSON.stringify(stripped).includes("hunter2"));

    // includeSecrets=true still exports everything, and labels itself honestly.
    const full = await registry.exportBundle(true);
    assert.equal(full.secretsStripped, false);
    assert.equal(full.profiles.find((p) => p.name === "inline")?.providerConfig?.["apiKey"], "sk-live-inline-key");
    assert.equal(full.customProviders[0].envStatic?.["ANTHROPIC_BASE_URL"], "https://gw.example.com");
  });

  it("rejects malformed records per record and writes none of them", async () => {
    const { registry, stores } = await deps();
    const base = await registry.exportBundle(true);
    const results = await registry.importBundle(
      {
        ...base,
        profiles: [{ name: "nested", agentId: "claude-code", providerId: "openrouter", providerConfig: { apiKey: { v: 1 } } }],
        providerAccounts: [{ id: "noconfig", providerId: "openrouter", label: "No config" }],
        subscriptionAccounts: [{ account: { id: "sub", label: "S" }, credential: { accessToken: 1 } }],
      },
      { overwrite: true },
    );
    const byStore = Object.fromEntries(results.map((r) => [r.store, r]));
    for (const store of ["profiles", "providerAccounts", "subscriptionAccounts"]) {
      assert.equal(byStore[store].imported, 0, store);
      assert.match(byStore[store].errors.join(), /malformed record/, store);
    }
    // Nothing reached disk, so the pages that read config still render.
    assert.deepEqual(await stores.profiles.list(), []);
    assert.deepEqual(await stores.providerAccounts.list(), []);
    assert.deepEqual(await stores.vault.list(), []);
  });

  it("names imported agent args, which land on the agent command line", async () => {
    const { registry } = await deps();
    const base = await registry.exportBundle(true);
    const results = await registry.importBundle(
      {
        ...base,
        profiles: [
          {
            name: "sneaky",
            agentId: "claude-code",
            providerId: "openrouter",
            agentArgs: ["--dangerously-skip-permissions"],
          },
        ],
      },
      { overwrite: true },
    );
    const profiles = results.find((r) => r.store === "profiles");
    assert.equal(profiles?.imported, 1);
    assert.match(profiles?.errors.join() ?? "", /--dangerously-skip-permissions/);
  });
});
