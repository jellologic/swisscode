import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readJsonFile, writeFileAtomic, writeJsonAtomic } from "./atomicJson.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "swisscode-atomic-"));
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("writeJsonAtomic", () => {
  it("writes 0600 JSON and leaves no temp file behind", async () => {
    const dir = await tmp();
    const path = join(dir, "profiles.json");
    await writeJsonAtomic(path, [{ name: "work" }]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), [{ name: "work" }]);
    assert.equal(await mode(path), 0o600);
    assert.deepEqual(await readdir(dir), ["profiles.json"]);
  });

  it("creates the parent directory 0700", async () => {
    const dir = await tmp();
    const path = join(dir, "accounts", "openrouter", "main.json");
    await writeJsonAtomic(path, { id: "main" });
    assert.equal(await mode(join(dir, "accounts", "openrouter")), 0o700);
  });

  it("replaces an existing file and tightens its mode", async () => {
    const dir = await tmp();
    const path = join(dir, "profiles.json");
    await writeFile(path, "[]\n", { mode: 0o644 });
    assert.equal(await mode(path), 0o644);
    await writeJsonAtomic(path, [{ name: "work" }]);
    assert.equal(await mode(path), 0o600);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), [{ name: "work" }]);
  });

  it("honours an explicit mode", async () => {
    const dir = await tmp();
    const path = join(dir, "public.json");
    await writeJsonAtomic(path, {}, { mode: 0o644 });
    assert.equal(await mode(path), 0o644);
  });

  it("keeps the previous content in .bak only when asked", async () => {
    const dir = await tmp();
    const path = join(dir, "custom-providers.json");
    // First write: nothing to back up, and no stray .bak is created.
    await writeJsonAtomic(path, [{ id: "one" }], { keepBackup: true });
    assert.deepEqual((await readdir(dir)).sort(), ["custom-providers.json"]);
    await writeJsonAtomic(path, [{ id: "two" }], { keepBackup: true });
    assert.deepEqual(JSON.parse(await readFile(`${path}.bak`, "utf8")), [{ id: "one" }]);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), [{ id: "two" }]);
    assert.equal(await mode(`${path}.bak`), 0o600);
    await writeJsonAtomic(path, [{ id: "three" }]);
    // No keepBackup: the old .bak stays untouched rather than silently rotating.
    assert.deepEqual(JSON.parse(await readFile(`${path}.bak`, "utf8")), [{ id: "one" }]);
  });

  it("never leaves a torn file when writes race", async () => {
    const dir = await tmp();
    const path = join(dir, "profiles.json");
    const writes = Array.from({ length: 24 }, (_, i) =>
      writeJsonAtomic(path, { round: i, padding: "x".repeat(4096) }),
    );
    await Promise.all(writes);
    const parsed = JSON.parse(await readFile(path, "utf8")) as { round: number; padding: string };
    assert.ok(parsed.round >= 0 && parsed.round < 24);
    assert.equal(parsed.padding.length, 4096);
    assert.deepEqual(await readdir(dir), ["profiles.json"]);
  });
});

describe("writeFileAtomic", () => {
  it("writes plain text verbatim", async () => {
    const dir = await tmp();
    const path = join(dir, "proxy-token");
    await writeFileAtomic(path, "abc123\n");
    assert.equal(await readFile(path, "utf8"), "abc123\n");
    assert.equal(await mode(path), 0o600);
  });
});

describe("readJsonFile", () => {
  it("returns the parsed value", async () => {
    const dir = await tmp();
    const path = join(dir, "a.json");
    await writeJsonAtomic(path, { hello: "world" });
    assert.deepEqual(await readJsonFile<{ hello: string }>(path), {
      ok: true,
      value: { hello: "world" },
    });
  });

  it("reports a missing file as data, not an exception", async () => {
    const dir = await tmp();
    const res = await readJsonFile(join(dir, "nope.json"));
    assert.deepEqual(res, { ok: false, reason: "missing" });
    // A path whose parent is a file cannot exist either.
    await writeFileAtomic(join(dir, "file"), "x");
    const nested = await readJsonFile(join(dir, "file", "child.json"));
    assert.deepEqual(nested, { ok: false, reason: "missing" });
  });

  it("reports corrupt JSON with the parser message", async () => {
    const dir = await tmp();
    const path = join(dir, "torn.json");
    await writeFile(path, '{"name": "wo');
    const res = await readJsonFile(path);
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.reason, "corrupt");
    assert.ok(res.ok === false && (res.error?.length ?? 0) > 0);
  });

  it("treats an empty file as corrupt rather than empty config", async () => {
    const dir = await tmp();
    const path = join(dir, "empty.json");
    await writeFile(path, "");
    const res = await readJsonFile(path);
    assert.equal(res.ok === false && res.reason, "corrupt");
  });

  it("does not throw when the path is a directory", async () => {
    const dir = await tmp();
    const res = await readJsonFile(dir);
    assert.equal(res.ok, false);
  });
});
