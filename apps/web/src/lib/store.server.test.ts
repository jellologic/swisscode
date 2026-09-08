// End-to-end over the real file stores, rooted at a throwaway SWISSCODE_HOME.
// Nothing here reads ~/.swisscode, ~/.claude or the Keychain: only the profile,
// account and custom-provider paths are exercised, and they all hang off the
// env var set before the module binds them.

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskSecretValue } from "@swisscode/core";

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
