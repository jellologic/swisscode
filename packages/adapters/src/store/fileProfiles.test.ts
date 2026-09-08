import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Profile } from "@swisscode/core";
import { FileProfileRepository } from "./fileProfiles.js";
import { StoreFileError } from "./atomicJson.js";

async function repo(): Promise<{ dir: string; file: string; repo: FileProfileRepository }> {
  const dir = await mkdtemp(join(tmpdir(), "swp-"));
  const file = join(dir, "store", "profiles.json");
  return { dir, file, repo: new FileProfileRepository(file) };
}

function profile(name: string, over: Partial<Profile> = {}): Profile {
  return { name, agentId: "claude-code", providerId: "openrouter", ...over };
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("FileProfileRepository", () => {
  it("reads an absent store as empty and round-trips", async () => {
    const { repo: r } = await repo();
    assert.deepEqual(await r.list(), []);
    await r.save(profile("work"));
    assert.equal((await r.get("work"))?.providerId, "openrouter");
    assert.equal(await r.remove("work"), true);
    assert.equal(await r.remove("work"), false);
  });

  it("names the file when profiles.json is corrupt instead of throwing SyntaxError", async () => {
    const { file, repo: r } = await repo();
    await r.save(profile("work"));
    await writeFile(file, '[{"name": "work",', "utf8");
    await assert.rejects(() => r.list(), (err: unknown) => {
      assert.ok(err instanceof StoreFileError);
      assert.equal(err.path, file);
      assert.match(err.message, /profiles\.json is corrupt: /);
      return true;
    });
  });

  it("keeps both profiles when two saves race", async () => {
    const { repo: r } = await repo();
    await Promise.all([r.save(profile("a")), r.save(profile("b")), r.save(profile("c"))]);
    assert.deepEqual((await r.list()).map((p) => p.name).sort(), ["a", "b", "c"]);
  });

  it("writes 0600 in a 0700 dir and re-modes a legacy 0644 store", async () => {
    const { file, repo: r } = await repo();
    await r.save(profile("work"));
    assert.equal(await mode(file), 0o600);
    assert.equal(await mode(join(file, "..")), 0o700);

    // A store written by an older swisscode is group/world readable while it
    // holds an inline API key; the next write must fix that.
    await chmod(file, 0o644);
    assert.equal(await mode(file), 0o644);
    await r.save(profile("work", { providerConfig: { apiKey: "sk-secret-value" } }));
    assert.equal(await mode(file), 0o600);
  });

  it("keeps the previous content in a .bak on every write", async () => {
    const { file, repo: r } = await repo();
    await r.save(profile("first"));
    await r.save(profile("second"));
    const backup = JSON.parse(await readFile(`${file}.bak`, "utf8")) as Profile[];
    assert.deepEqual(backup.map((p) => p.name), ["first"]);
    assert.equal(await mode(`${file}.bak`), 0o600);
  });
});
