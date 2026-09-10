import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MetaModelCatalog } from "./metaModels.js";
import { ModelCatalogError } from "./openRouterModels.js";

const LIST = {
  object: "list",
  data: [
    { id: "muse-spark-1.3-contributor", object: "model", created: 0, owned_by: "meta" },
    { id: "muse-spark-1.3", object: "model", created: 0, owned_by: "meta" },
    { id: "muse-image-1.0", object: "model", created: 0, owned_by: "meta" },
    { object: "model", owned_by: "meta" },
  ],
};

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("MetaModelCatalog", () => {
  it("parses the OpenAI-style list, skipping entries without ids", async () => {
    const catalog = new MetaModelCatalog({ fetchFn: stubFetch(LIST) });
    assert.deepEqual(await catalog.listModels({ apiKey: "k" }), [
      { id: "muse-spark-1.3-contributor", name: "muse-spark-1.3-contributor", creator: "meta" },
      { id: "muse-spark-1.3", name: "muse-spark-1.3", creator: "meta" },
      { id: "muse-image-1.0", name: "muse-image-1.0", creator: "meta" },
    ]);
  });

  it("sends the stored key as a bearer token", async () => {
    let auth: string | null = null;
    const catalog = new MetaModelCatalog({
      fetchFn: (async (_url: string | URL | Request, init?: RequestInit) => {
        auth = new Headers(init?.headers).get("authorization");
        return new Response(JSON.stringify(LIST), { status: 200 });
      }) as typeof fetch,
    });
    await catalog.listModels({ apiKey: "LLM_secret" });
    assert.equal(auth, "Bearer LLM_secret");
  });

  it("refuses without a key instead of probing anonymously", async () => {
    let calls = 0;
    const catalog = new MetaModelCatalog({
      fetchFn: (async () => {
        calls++;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    await assert.rejects(catalog.listModels({ apiKey: "  " }), ModelCatalogError);
    await assert.rejects(catalog.listModels(undefined), ModelCatalogError);
    assert.equal(calls, 0);
  });

  it("maps 401 to rejected and other failures to HTTP errors", async () => {
    const bad = new MetaModelCatalog({ fetchFn: stubFetch({}, 401) });
    await assert.rejects(bad.listModels({ apiKey: "x" }), /rejected/);
    const broken = new MetaModelCatalog({ fetchFn: stubFetch({}, 500) });
    await assert.rejects(broken.listModels({ apiKey: "x" }), /HTTP 500/);
    const shapeless = new MetaModelCatalog({ fetchFn: stubFetch({}) });
    await assert.rejects(shapeless.listModels({ apiKey: "x" }), /not a list/);
  });
});
