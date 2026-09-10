import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  InputError,
  parseAccountUsage,
  parseCustomProvider,
  parseExportBundle,
  parseGlobalSettings,
  parseImportAccount,
  parseImportBundle,
  parseModelRef,
  parseProfile,
  parseProfileRef,
  parseSaveProviderAccount,
  parseTrafficEntryRefs,
  parseTrafficSize,
  parseUpdateProviderAccount,
} from "./validate.js";

function rejects(fn: () => unknown, field: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof InputError, `expected InputError, got ${String(err)}`);
    assert.equal(err.field, field);
    return true;
  });
}

describe("parseTrafficSize", () => {
  it("takes a whole number", () => {
    assert.deepEqual(parseTrafficSize({ size: 0 }), { size: 0 });
    assert.deepEqual(parseTrafficSize({ size: 200 }), { size: 200 });
  });

  it("rejects the values that used to be coerced into /size/NaN", () => {
    rejects(() => parseTrafficSize({ size: "abc" }), "size");
    rejects(() => parseTrafficSize({ size: Number.NaN }), "size");
    rejects(() => parseTrafficSize({ size: 1.5 }), "size");
    rejects(() => parseTrafficSize({ size: -1 }), "size");
    rejects(() => parseTrafficSize({}), "size");
    rejects(() => parseTrafficSize(null), "data");
  });
});

describe("id validation", () => {
  it("accepts store-shaped ids", () => {
    assert.deepEqual(parseProfileRef({ name: "work_2-x" }), { name: "work_2-x" });
  });

  it("rejects ids the stores would never write", () => {
    rejects(() => parseProfileRef({ name: "../../etc/passwd" }), "name");
    rejects(() => parseProfileRef({ name: "-leading" }), "name");
    rejects(() => parseProfileRef({ name: "" }), "name");
    rejects(() => parseProfileRef({ name: 123 }), "name");
    rejects(() => parseProfileRef({ name: "a".repeat(200) }), "name");
  });

  it("keeps importAccount's blank id (the email supplies one)", () => {
    assert.deepEqual(parseImportAccount({ id: "" }), { id: "" });
    assert.deepEqual(parseImportAccount({ id: "ada", overwrite: true }), {
      id: "ada",
      overwrite: true,
    });
    // A non-string id reached the Keychain and Anthropic before failing.
    rejects(() => parseImportAccount({ id: 123 }), "id");
    rejects(() => parseImportAccount({ id: "ada", overwrite: "yes" }), "overwrite");
  });

  it("checks every id in a list", () => {
    assert.deepEqual(parseAccountUsage({ ids: ["a", "b"] }), { ids: ["a", "b"] });
    assert.deepEqual(parseAccountUsage({}), {});
    rejects(() => parseAccountUsage({ ids: ["ok", "bad/id"] }), "ids[1]");
    rejects(() => parseAccountUsage({ ids: "a" }), "ids");
    rejects(() => parseTrafficEntryRefs({ ids: new Array(501).fill("t1-1") }), "ids");
  });
});

describe("config maps", () => {
  it("requires Record<string,string>", () => {
    assert.deepEqual(
      parseSaveProviderAccount({
        providerId: "openrouter",
        id: " main ",
        label: "Main",
        config: { apiKey: "sk-live" },
      }),
      { providerId: "openrouter", id: "main", label: "Main", config: { apiKey: "sk-live" } },
    );
    rejects(
      () =>
        parseSaveProviderAccount({
          providerId: "openrouter",
          id: "main",
          label: "Main",
          config: { apiKey: { nested: true } },
        }),
      "config.apiKey",
    );
    rejects(
      () =>
        parseSaveProviderAccount({
          providerId: "openrouter",
          id: "main",
          label: "Main",
          config: "sk-live",
        }),
      "config",
    );
  });

  it("keeps config optional on update", () => {
    assert.deepEqual(parseUpdateProviderAccount({ providerId: "openrouter", id: "main" }), {
      providerId: "openrouter",
      id: "main",
    });
  });
});

describe("parseProfile", () => {
  it("accepts a profile record", () => {
    const profile = { name: "work", agentId: "claude-code", providerId: "openrouter" };
    assert.deepEqual(parseProfile(profile), profile);
  });

  it("rejects a payload the repository would have written verbatim", () => {
    rejects(() => parseProfile({ name: "work", agentId: 1, providerId: "x" }), "profile");
    rejects(() => parseProfile({ name: "work" }), "profile");
    rejects(() => parseProfile("work"), "profile");
    rejects(
      () => parseProfile({ name: "w", agentId: "a", providerId: "p", providerConfig: { k: 1 } }),
      "profile",
    );
  });
});

describe("bundles", () => {
  it("defaults exports to secret-free", () => {
    assert.deepEqual(parseExportBundle(undefined), { includeSecrets: false });
    assert.deepEqual(parseExportBundle({}), { includeSecrets: false });
    assert.deepEqual(parseExportBundle({ includeSecrets: true }), { includeSecrets: true });
    rejects(() => parseExportBundle({ includeSecrets: "true" }), "includeSecrets");
  });

  it("passes the bundle body through untouched but demands a real flag", () => {
    const bundle = { version: 1, stores: {} };
    assert.deepEqual(parseImportBundle({ bundle, overwrite: false }), { bundle, overwrite: false });
    rejects(() => parseImportBundle({ bundle }), "overwrite");
    rejects(() => parseImportBundle({ overwrite: true }), "bundle");
  });
});

describe("model and custom-provider input", () => {
  it("takes vendor model ids but not paths", () => {
    assert.deepEqual(parseModelRef({ providerId: "openrouter", modelId: "anthropic/claude-4.5" }), {
      providerId: "openrouter",
      modelId: "anthropic/claude-4.5",
    });
    rejects(() => parseModelRef({ providerId: "openrouter", modelId: "" }), "modelId");
    rejects(() => parseModelRef({ providerId: "openrouter", modelId: "a b" }), "modelId");
  });

  it("checks the custom provider structure before the store sees it", () => {
    const def = parseCustomProvider({
      id: "gateway",
      displayName: "Gateway",
      fields: [{ key: "token", label: "Token", secret: true, required: true }],
      envFromConfig: { MY_PASSWORD: "token" },
      test: { url: "https://example.com/key", method: "GET" },
    });
    assert.equal(def.fields[0]?.key, "token");
    assert.equal(def.test?.method, "GET");
    rejects(() => parseCustomProvider({ id: "gateway", displayName: "G", fields: {} }), "fields");
    rejects(
      () =>
        parseCustomProvider({
          id: "gateway",
          displayName: "G",
          fields: [{ key: "token", label: "Token", secret: "yes", required: true }],
        }),
      "fields[0].secret",
    );
    rejects(
      () =>
        parseCustomProvider({
          id: "gateway",
          displayName: "G",
          fields: [],
          test: { url: "https://x", method: "DELETE" },
        }),
      "test.method",
    );
  });
});

describe("parseGlobalSettings", () => {
  it("takes the whole pair, either strategy", () => {
    assert.deepEqual(
      parseGlobalSettings({ rotationEnabled: true, rotationStrategy: "reset-soonest" }),
      { rotationEnabled: true, rotationStrategy: "reset-soonest" },
    );
    assert.deepEqual(
      parseGlobalSettings({ rotationEnabled: false, rotationStrategy: "least-used" }),
      { rotationEnabled: false, rotationStrategy: "least-used" },
    );
  });

  it("rejects a partial save, a bad enum, and a non-boolean toggle", () => {
    // A partial save would silently keep a stale half — the form sends both.
    rejects(() => parseGlobalSettings({ rotationEnabled: true }), "rotationStrategy");
    rejects(
      () => parseGlobalSettings({ rotationEnabled: true, rotationStrategy: "soonest" }),
      "rotationStrategy",
    );
    rejects(
      () => parseGlobalSettings({ rotationEnabled: "yes", rotationStrategy: "reset-soonest" }),
      "rotationEnabled",
    );
    rejects(() => parseGlobalSettings(null), "data");
  });
});
