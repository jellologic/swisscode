// The Meta catalog is key-gated: without a stored account the picker gets a
// key error (never an anonymous probe), and with one the stored config is
// forwarded to the live fetch. Temp home only — the only network this touches
// is one rejected Meta request with a fake key.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const home = await mkdtemp(join(tmpdir(), "swisscode-web-models-"));
process.env["SWISSCODE_HOME"] = home;
const store = await import("./store.server.js");

after(async () => {
  await rm(home, { recursive: true, force: true });
});

await store.saveProviderAccount({
  id: "k1",
  providerId: "meta",
  label: "K1",
  config: { apiKey: "test-key-not-real" },
  createdAt: "",
  updatedAt: "",
});

describe("getProviderModels for key-gated catalogs", () => {
  it("refuses Meta without an account instead of probing anonymously", async () => {
    await assert.rejects(store.getProviderModels("meta"), /needs an API key/);
  });

  it("treats an unknown account like no account", async () => {
    await assert.rejects(store.getProviderModels("meta", "nope"), /needs an API key/);
  });

  it("forwards the stored key past the key gate", async () => {
    // Empty cache, so this reaches the live fetch. A regression that drops
    // the stored config fails the key gate with "needs an API key" and zero
    // requests; with the config it gets Meta's 401 (or a fetch failure when
    // offline) — either way, past the gate.
    const err = await store.getProviderModels("meta", "k1").then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof Error, "expected the fake key to be rejected");
    assert.ok(
      !/needs an API key/.test(err.message),
      `stored config never reached the fetch: ${err.message}`,
    );
  });
});
