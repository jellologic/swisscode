import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskSecretValue, type FieldDef } from "@swisscode/core";

import { blankSecrets, collectSecretValues, mergeAccountConfig } from "./accountConfig.js";

const KEY = "sk-or-v1-9f3c2b7a1d";
const fields: FieldDef[] = [
  { key: "apiKey", label: "API key", secret: true, required: true },
  { key: "model", label: "Model", secret: false, required: false },
];
const secretKeys = new Set(["apiKey"]);

describe("mergeAccountConfig", () => {
  it("never stores the mask back over the real key", () => {
    const prev = { apiKey: KEY, model: "anthropic/claude" };
    const merged = mergeAccountConfig(prev, { apiKey: maskSecretValue(KEY) }, secretKeys);
    assert.equal(merged.apiKey, KEY);
  });

  it("keeps the stored secret when the field is left blank", () => {
    const merged = mergeAccountConfig({ apiKey: KEY }, { apiKey: "" }, secretKeys);
    assert.equal(merged.apiKey, KEY);
  });

  it("stores a retyped secret", () => {
    const merged = mergeAccountConfig({ apiKey: KEY }, { apiKey: "sk-or-v1-new" }, secretKeys);
    assert.equal(merged.apiKey, "sk-or-v1-new");
  });

  it("clears a blanked non-secret but keeps untouched keys", () => {
    const merged = mergeAccountConfig(
      { apiKey: KEY, model: "anthropic/claude" },
      { model: "" },
      secretKeys,
    );
    assert.deepEqual(merged, { apiKey: KEY });
  });

  it("protects a value the summary masked by name even without a secret field", () => {
    // listProviderAccountSummaries masks /key|token|secret/i too, so the mask
    // can come back for a field the provider never declared secret.
    const prev = { token: KEY };
    const merged = mergeAccountConfig(prev, { token: maskSecretValue(KEY) }, new Set<string>());
    assert.equal(merged.token, KEY);
  });
});

describe("collectSecretValues", () => {
  it("collects declared secrets and secret-looking keys, skipping blanks", () => {
    const values = collectSecretValues(
      { apiKey: KEY, model: "anthropic/claude", MY_TOKEN: "t-1", empty: "" },
      secretKeys,
    );
    assert.deepEqual(values.sort(), [KEY, "t-1"].sort());
  });

  it("is empty for no config", () => {
    assert.deepEqual(collectSecretValues(undefined, secretKeys), []);
  });
});

describe("blankSecrets", () => {
  it("empties declared secret fields and leaves the rest", () => {
    assert.deepEqual(blankSecrets({ apiKey: maskSecretValue(KEY), model: "gpt" }, fields), {
      apiKey: "",
      model: "gpt",
    });
  });
});
