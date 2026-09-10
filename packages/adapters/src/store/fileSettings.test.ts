import { chmod, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GLOBAL_SETTINGS } from "@swisscode/core";
import type { GlobalSettings } from "@swisscode/core";
import { FileSettingsStore } from "./fileSettings.js";

async function store(): Promise<{ file: string; store: FileSettingsStore }> {
  const dir = await mkdtemp(join(tmpdir(), "sws-"));
  const file = join(dir, "store", "settings.json");
  return { file, store: new FileSettingsStore(file) };
}

async function mode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

describe("FileSettingsStore", () => {
  it("reads a missing store as the defaults and reports itself absent", async () => {
    const { store: s } = await store();
    assert.equal(await s.present(), false);
    assert.deepEqual(await s.get(), DEFAULT_GLOBAL_SETTINGS);
  });

  it("falls back to defaults on corrupt JSON instead of throwing", async () => {
    const { file, store: s } = await store();
    await s.save({ rotationEnabled: true, rotationStrategy: "least-used", updateMode: "auto" });
    await writeFile(file, '{"rotationEnabled": tru', "utf8");
    assert.equal(await s.present(), true);
    assert.deepEqual(await s.get(), DEFAULT_GLOBAL_SETTINGS);
  });

  it("falls back to defaults on a shape-bad record instead of throwing", async () => {
    const { file, store: s } = await store();
    await s.save({ rotationEnabled: true, rotationStrategy: "least-used", updateMode: "auto" });
    await writeFile(file, '{"rotationEnabled": "yes", "rotationStrategy": "soonest"}', "utf8");
    assert.deepEqual(await s.get(), DEFAULT_GLOBAL_SETTINGS);
  });

  it("round-trips and writes 0600 in a 0700 dir", async () => {
    const { file, store: s } = await store();
    const next: GlobalSettings = { rotationEnabled: true, rotationStrategy: "least-used", updateMode: "auto" };
    await s.save(next);
    assert.equal(await s.present(), true);
    assert.deepEqual(await s.get(), next);
    assert.equal(await mode(file), 0o600);
    assert.equal(await mode(join(file, "..")), 0o700);

    // A store written by an older swisscode is group/world readable; the next
    // write must fix that, same as the profile store.
    await chmod(file, 0o644);
    await s.save(DEFAULT_GLOBAL_SETTINGS);
    assert.equal(await mode(file), 0o600);
    assert.deepEqual(await s.get(), DEFAULT_GLOBAL_SETTINGS);
  });

  it("keeps the file valid when two saves race", async () => {
    const { store: s } = await store();
    const on: GlobalSettings = { rotationEnabled: true, rotationStrategy: "reset-soonest", updateMode: "auto" };
    const off: GlobalSettings = { rotationEnabled: false, rotationStrategy: "least-used", updateMode: "off" };
    await Promise.all([s.save(on), s.save(off)]);
    // Last writer wins, but either way the file parses to a valid shape.
    const got = await s.get();
    assert.ok([on, off].some((w) => JSON.stringify(w) === JSON.stringify(got)));
  });
});
