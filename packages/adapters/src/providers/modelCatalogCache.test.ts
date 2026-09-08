import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FileModelCatalogCache } from "./modelCatalogCache.js";
import { StoreFileError } from "../store/atomicJson.js";

async function cache(): Promise<{ file: string; cache: FileModelCatalogCache }> {
  const file = join(await mkdtemp(join(tmpdir(), "swm-")), "model-catalog-cache.json");
  return { file, cache: new FileModelCatalogCache(file) };
}

describe("FileModelCatalogCache", () => {
  it("treats an absent cache as empty and round-trips both key kinds", async () => {
    const { cache: c } = await cache();
    assert.equal(await c.get("openrouter"), undefined);
    await c.set("openrouter", { models: [{ id: "m1", name: "M1" }], fetchedAt: "2026-01-01T00:00:00.000Z" });
    await c.setEndpoints("openrouter", "m1", { endpoints: [], fetchedAt: "2026-01-01T00:00:00.000Z" });
    assert.deepEqual((await c.get("openrouter"))?.models, [{ id: "m1", name: "M1" }]);
    assert.deepEqual((await c.getEndpoints("openrouter", "m1"))?.endpoints, []);
  });

  it("names the file when the cache is torn", async () => {
    const { file, cache: c } = await cache();
    await writeFile(file, '{"openrouter": {"models": [', "utf8");
    await assert.rejects(() => c.get("openrouter"), (err: unknown) => {
      assert.ok(err instanceof StoreFileError);
      assert.equal(err.path, file);
      return true;
    });
  });

  it("keeps every entry when concurrent fetches cache at once", async () => {
    const { cache: c } = await cache();
    const at = "2026-01-01T00:00:00.000Z";
    await Promise.all([
      c.set("openrouter", { models: [{ id: "m1", name: "M1" }], fetchedAt: at }),
      c.setEndpoints("openrouter", "m1", { endpoints: [], fetchedAt: at }),
      c.setEndpoints("openrouter", "m2", { endpoints: [], fetchedAt: at }),
    ]);
    assert.ok(await c.get("openrouter"));
    assert.ok(await c.getEndpoints("openrouter", "m1"));
    assert.ok(await c.getEndpoints("openrouter", "m2"));
  });
});
