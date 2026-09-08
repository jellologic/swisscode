import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProfileError, validateCustomProviderDef, type CustomProviderDef } from "./index.js";

function def(overrides: Partial<CustomProviderDef> = {}): CustomProviderDef {
  return {
    id: "gw",
    displayName: "Gateway",
    fields: [
      { key: "apiKey", label: "API Key", secret: true, required: true },
      { key: "model", label: "Model", secret: false, required: false },
    ],
    envStatic: { ANTHROPIC_BASE_URL: "https://gw.example.com" },
    envFromConfig: { ANTHROPIC_AUTH_TOKEN: "apiKey" },
    modelEnvVar: "ANTHROPIC_MODEL",
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("validateCustomProviderDef env policy", () => {
  it("accepts an ordinary provider definition", () => {
    validateCustomProviderDef(def());
  });

  it("rejects denied names in envStatic", () => {
    for (const name of ["PATH", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "LD_PRELOAD", "HOME"]) {
      assert.throws(
        () => validateCustomProviderDef(def({ envStatic: { [name]: "/tmp/evil" } })),
        (err: unknown) =>
          err instanceof ProfileError && /not allowed/.test((err as Error).message),
        name,
      );
    }
  });

  it("rejects denied names as envFromConfig targets", () => {
    assert.throws(
      () => validateCustomProviderDef(def({ envFromConfig: { NODE_OPTIONS: "apiKey" } })),
      /not allowed/,
    );
    // The mapping target is checked before the field reference, so a denied
    // name cannot slip through by also naming a real field.
    assert.throws(
      () => validateCustomProviderDef(def({ envFromConfig: { PATH: "apiKey" } })),
      ProfileError,
    );
  });

  it("rejects a denied name as the model env var", () => {
    assert.throws(() => validateCustomProviderDef(def({ modelEnvVar: "PATH" })), /not allowed/);
  });

  it("still allows provider env names that only look dangerous", () => {
    validateCustomProviderDef(
      def({ envStatic: { PATHOLOGY_URL: "https://x.example.com", MY_LD_PRELOAD: "1" } }),
    );
  });
});

describe("validateCustomProviderDef test.url", () => {
  const withUrl = (url: string): CustomProviderDef =>
    def({ test: { url, authField: "apiKey" } });

  it("accepts public https endpoints", () => {
    for (const url of [
      "https://gw.example.com/key",
      "https://api.example.com:8443/v1/me",
      "https://8.8.8.8/probe",
      "https://11.0.0.1/probe", // 11/8 is public; only 10/8 is RFC1918
      "https://172.32.0.1/probe", // just outside 172.16/12
      "https://[2606:4700::1111]/probe",
      "https://x", // bare intranet-style name: no address to judge
    ]) {
      validateCustomProviderDef(withUrl(url));
    }
  });

  it("rejects loopback, link-local and RFC1918 hosts", () => {
    for (const url of [
      "https://localhost/key",
      "https://LOCALHOST:9000/key",
      "https://api.localhost/key",
      "https://127.0.0.1/key",
      "https://127.9.9.9/key",
      "https://0.0.0.0/key",
      "https://10.1.2.3/key",
      "https://172.16.0.1/key",
      "https://172.31.255.254/key",
      "https://192.168.1.1/key",
      "https://169.254.169.254/latest/meta-data", // cloud metadata
      "https://[::1]/key",
      "https://[0:0:0:0:0:0:0:1]/key",
      "https://[::]/key",
      "https://[fe80::1]/key",
      "https://[fd00::1]/key",
      "https://[::ffff:127.0.0.1]/key",
    ]) {
      assert.throws(
        () => validateCustomProviderDef(withUrl(url)),
        (err: unknown) =>
          err instanceof ProfileError && /loopback, link-local or private/.test((err as Error).message),
        url,
      );
    }
  });

  it("rejects userinfo in the URL", () => {
    assert.throws(
      () => validateCustomProviderDef(withUrl("https://user:pass@gw.example.com/key")),
      /must not embed a username or password/,
    );
    assert.throws(
      () => validateCustomProviderDef(withUrl("https://user@gw.example.com/key")),
      /must not embed a username or password/,
    );
  });

  it("keeps the existing scheme and field rules", () => {
    assert.throws(() => validateCustomProviderDef(withUrl("http://gw.example.com")), /https URL/);
    assert.throws(
      () => validateCustomProviderDef(def({ test: { url: "https://gw.example.com", authField: "nope" } })),
      /not a defined field/,
    );
  });
});
