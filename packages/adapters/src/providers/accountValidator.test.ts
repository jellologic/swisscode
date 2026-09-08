import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProfileError } from "@swisscode/core";
import { CustomAccountValidator, OpenRouterAccountValidator } from "./accountValidator.js";
import { FileCustomProviderStore } from "../store/customProviders.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("OpenRouterAccountValidator", () => {
  it("confirms a good key with label + spend", async () => {
    const v = new OpenRouterAccountValidator({
      fetchFn: stubFetch({ data: { label: "main", usage: 1.5, limit: 10 } }),
    });
    assert.deepEqual(await v.validateAccount({ apiKey: "[REDACTED]" }), {
      ok: true,
      label: "main",
      detail: "spend $1.50 of $10.00",
    });
  });

  it("rejects blank keys without a network call", async () => {
    let calls = 0;
    const v = new OpenRouterAccountValidator({
      fetchFn: (async () => {
        calls++;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    assert.deepEqual(await v.validateAccount({ apiKey: "  " }), {
      ok: false,
      error: "API key is required.",
    });
    assert.equal(calls, 0);
  });

  it("maps 401 to rejected and 500 to HTTP error", async () => {
    const bad = new OpenRouterAccountValidator({ fetchFn: stubFetch({}, 401) });
    assert.deepEqual(await bad.validateAccount({ apiKey: "x" }), {
      ok: false,
      error: "Key rejected (invalid or revoked).",
    });
    const broken = new OpenRouterAccountValidator({ fetchFn: stubFetch({}, 500) });
    assert.deepEqual(await broken.validateAccount({ apiKey: "x" }), {
      ok: false,
      error: "Key check failed: HTTP 500",
    });
  });

  it("bounds the probe and never follows a redirect carrying the key", async () => {
    let init: RequestInit | undefined;
    const v = new OpenRouterAccountValidator({
      fetchFn: (async (_url: string | URL | Request, got?: RequestInit) => {
        init = got;
        return new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } });
      }) as typeof fetch,
    });
    const result = await v.validateAccount({ apiKey: "sk-secret" });
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? (result.error ?? "") : "", /redirected \(HTTP 302\)/);
  });

  it("turns a timeout into a verdict, not an exception", async () => {
    const v = new OpenRouterAccountValidator({
      timeoutMs: 5,
      fetchFn: ((_url: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
        })) as typeof fetch,
    });
    assert.deepEqual(await v.validateAccount({ apiKey: "x" }), {
      ok: false,
      error: "Key check timed out after 5ms.",
    });
  });
});

const TEST_DEF = {
  id: "gw",
  displayName: "GW",
  fields: [{ key: "apiKey", label: "API Key", secret: true, required: true }],
  test: { url: "https://gw.example.com/key", authField: "apiKey" },
  createdAt: "",
  updatedAt: "",
};

describe("CustomAccountValidator", () => {
  it("sends the declared auth header and maps status", async () => {
    let seen: { url: string; method?: string; auth?: string } = { url: "" };
    const v = new CustomAccountValidator(TEST_DEF, {
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        seen = {
          url: String(url),
          method: init?.method,
          auth: (init?.headers as Record<string, string>)?.["Authorization"],
        };
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    assert.deepEqual(await v.validateAccount({ apiKey: "[REDACTED]" }), {
      ok: true,
      detail: "test endpoint returned HTTP 200",
    });
    assert.deepEqual(seen, {
      url: "https://gw.example.com/key",
      method: "GET",
      auth: "Bearer [REDACTED]",
    });
  });

  it("requires the auth field and reports rejection", async () => {
    const v = new CustomAccountValidator(TEST_DEF, { fetchFn: stubFetch({}, 200) });
    assert.deepEqual(await v.validateAccount({}), {
      ok: false,
      error: 'Field "apiKey" is required to test.',
    });
    const denied = new CustomAccountValidator(TEST_DEF, { fetchFn: stubFetch({}, 403) });
    assert.deepEqual(await denied.validateAccount({ apiKey: "x" }), {
      ok: false,
      error: "Credentials rejected (invalid or revoked).",
    });
  });

  it("reports a redirect instead of replaying the credential to the new host", async () => {
    let init: RequestInit | undefined;
    const v = new CustomAccountValidator(TEST_DEF, {
      fetchFn: (async (_url: string | URL | Request, got?: RequestInit) => {
        init = got;
        return new Response(null, { status: 307, headers: { location: "https://evil.example.com/" } });
      }) as typeof fetch,
    });
    const result = await v.validateAccount({ apiKey: "sk-secret" });
    assert.equal(init?.redirect, "manual");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? (result.error ?? "") : "", /redirected \(HTTP 307\)/);
  });

  it("times out instead of hanging the form", async () => {
    const v = new CustomAccountValidator(TEST_DEF, {
      timeoutMs: 5,
      fetchFn: ((_url: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject((init.signal as AbortSignal).reason));
        })) as typeof fetch,
    });
    assert.deepEqual(await v.validateAccount({ apiKey: "x" }), {
      ok: false,
      error: "Test request timed out after 5ms.",
    });
  });

  it("validates the test block on save", async () => {
    const store = new FileCustomProviderStore(join(await mkdtemp(join(tmpdir(), "swt-")), "p.json"));
    await assert.rejects(() => store.save({ ...TEST_DEF, test: { url: "http://x" } }), ProfileError);
    await assert.rejects(
      () => store.save({ ...TEST_DEF, test: { url: "https://x", authField: "nope" } }),
      /not a defined field/,
    );
  });
});
