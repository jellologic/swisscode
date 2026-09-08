import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelCatalogError, OpenRouterModelCatalog } from "./openRouterModels.js";
import { CachingModelCatalog, FileModelCatalogCache } from "./modelCatalogCache.js";

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

const LIST = {
  data: [
    {
      id: "anthropic/claude-sonnet-4",
      name: "Anthropic: Claude Sonnet 4",
      created: 1747930371,
      context_length: 1000000,
      architecture: { input_modalities: ["text", "image"] },
      pricing: { prompt: "0.000003", completion: "0.000015" },
      top_provider: { max_completion_tokens: 64000 },
    },
    { id: "openai/gpt-5", name: "OpenAI: GPT-5" },
    { id: "broken" },
    { id: 42, name: "junk" },
  ],
};

const ENDPOINTS = {
  data: {
    endpoints: [
      {
        provider_name: "Amazon Bedrock",
        tag: "amazon-bedrock/eu-west-1",
        context_length: 200000,
        max_completion_tokens: 64000,
        quantization: "unknown",
        pricing: { prompt: "0.000003", completion: "0.000015" },
        uptime_last_1d: 97.2,
      },
      {
        provider_name: "Nebius",
        quantization: "fp8",
        pricing: { prompt: "0.000002", completion: "0.000012" },
      },
      { provider_name: "", tag: "junk" },
    ],
  },
};

async function tempCache(): Promise<FileModelCatalogCache> {
  return new FileModelCatalogCache(join(await mkdtemp(join(tmpdir(), "swm-")), "c.json"));
}

describe("OpenRouterModelCatalog", () => {
  it("parses rich model fields and skips malformed entries", async () => {
    const catalog = new OpenRouterModelCatalog({ fetchFn: stubFetch(LIST) });
    assert.deepEqual(await catalog.listModels(), [
      {
        id: "anthropic/claude-sonnet-4",
        name: "Anthropic: Claude Sonnet 4",
        creator: "anthropic",
        created: "2025-05-22T16:12:51.000Z",
        contextLength: 1000000,
        maxCompletionTokens: 64000,
        inputModalities: ["text", "image"],
        promptPerMillion: 3,
        completionPerMillion: 15,
      },
      { id: "openai/gpt-5", name: "OpenAI: GPT-5", creator: "openai" },
      { id: "broken" },
    ]);
  });

  it("parses serving endpoints and drops unnamed ones", async () => {
    const catalog = new OpenRouterModelCatalog({ fetchFn: stubFetch(ENDPOINTS) });
    assert.deepEqual(await catalog.listEndpoints("anthropic/claude-sonnet-4"), [
      {
        provider: "Amazon Bedrock",
        tag: "amazon-bedrock/eu-west-1",
        contextLength: 200000,
        maxCompletionTokens: 64000,
        promptPerMillion: 3,
        completionPerMillion: 15,
        uptime1d: 97.2,
      },
      {
        provider: "Nebius",
        quantization: "fp8",
        promptPerMillion: 2,
        completionPerMillion: 12,
      },
    ]);
  });

  it("throws ModelCatalogError on HTTP failure", async () => {
    const catalog = new OpenRouterModelCatalog({ fetchFn: stubFetch({}, 500) });
    await assert.rejects(() => catalog.listModels(), (err: unknown) => {
      assert.ok(err instanceof ModelCatalogError);
      assert.equal((err as ModelCatalogError).status, 500);
      return true;
    });
  });
});

describe("CachingModelCatalog", () => {
  it("serves within TTL without refetching", async () => {
    let calls = 0;
    const inner = new OpenRouterModelCatalog({
      fetchFn: (async () => {
        calls++;
        return new Response(JSON.stringify(LIST), { status: 200 });
      }) as typeof fetch,
    });
    const cached = new CachingModelCatalog(inner, await tempCache(), { ttlMs: 60_000 });
    const first = await cached.snapshot();
    assert.equal(first.stale, false);
    assert.equal(first.models.length, 3);
    const second = await cached.snapshot();
    assert.equal(second.stale, false);
    assert.equal(calls, 1);
  });

  it("refetches past the TTL and serves stale on failure", async () => {
    let now = 0;
    let fail = false;
    const inner = new OpenRouterModelCatalog({
      fetchFn: (async () => {
        if (fail) return new Response("nope", { status: 500 });
        return new Response(JSON.stringify(LIST), { status: 200 });
      }) as typeof fetch,
    });
    const cached = new CachingModelCatalog(inner, await tempCache(), {
      ttlMs: 1000,
      now: () => now,
    });
    const fresh = await cached.snapshot();
    assert.equal(fresh.stale, false);
    now += 2000;
    fail = true;
    const stale = await cached.snapshot();
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.models, fresh.models);
  });

  it("throws when nothing is cached and the fetch fails", async () => {
    const inner = new OpenRouterModelCatalog({ fetchFn: stubFetch({}, 500) });
    const cached = new CachingModelCatalog(inner, await tempCache());
    await assert.rejects(() => cached.snapshot(), ModelCatalogError);
  });

  it("caches endpoints per model and serves stale on failure", async () => {
    let now = 0;
    let fail = false;
    const inner = new OpenRouterModelCatalog({
      fetchFn: (async (url: string | URL | Request) => {
        if (fail) return new Response("nope", { status: 500 });
        return new Response(JSON.stringify(String(url).includes("/endpoints") ? ENDPOINTS : LIST), {
          status: 200,
        });
      }) as typeof fetch,
    });
    const cached = new CachingModelCatalog(inner, await tempCache(), {
      ttlMs: 1000,
      now: () => now,
    });
    const fresh = await cached.endpoints("anthropic/claude-sonnet-4");
    assert.equal(fresh.stale, false);
    assert.equal(fresh.endpoints.length, 2);
    // Models list and endpoints are cached independently.
    assert.equal((await cached.snapshot()).models.length, 3);
    now += 2000;
    fail = true;
    const stale = await cached.endpoints("anthropic/claude-sonnet-4");
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.endpoints, fresh.endpoints);
    await assert.rejects(() => cached.endpoints("other/model"), ModelCatalogError);
  });
});
