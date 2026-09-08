import { mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LOCK_STALE_MS, withAccountLock } from "./accountLock.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "acct-lock-"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("withAccountLock", () => {
  it("serializes overlapping runs for the same account", async () => {
    const dir = await tempDir();
    const order: string[] = [];
    const run = (tag: string) =>
      withAccountLock(
        dir,
        "personal",
        async () => {
          order.push(`${tag}:enter`);
          await sleep(30);
          order.push(`${tag}:exit`);
          return tag;
        },
        { pollMs: 5 },
      );
    const [a, b] = await Promise.all([run("a"), run("b")]);
    assert.equal(a.locked, true);
    assert.equal(b.locked, true);
    // No interleaving: whoever wins the lock finishes before the other starts.
    // (Who wins is a race — mutual exclusion is the property, not fairness.)
    const [first, second] = order[0] === "a:enter" ? ["a", "b"] : ["b", "a"];
    assert.deepEqual(order, [`${first}:enter`, `${first}:exit`, `${second}:enter`, `${second}:exit`]);
  });

  it("keeps different accounts independent", async () => {
    const dir = await tempDir();
    let peak = 0;
    let active = 0;
    const run = (id: string) =>
      withAccountLock(dir, id, async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(20);
        active -= 1;
      });
    await Promise.all([run("personal"), run("work")]);
    assert.equal(peak, 2);
  });

  it("releases the lock file even when the work throws", async () => {
    const dir = await tempDir();
    await assert.rejects(
      () =>
        withAccountLock(dir, "personal", async () => {
          throw new Error("boom");
        }),
      /boom/,
    );
    await assert.rejects(() => stat(join(dir, "personal.lock")), /ENOENT/);
    // The account is usable again immediately.
    const again = await withAccountLock(dir, "personal", async () => "ok");
    assert.deepEqual(again, { value: "ok", locked: true });
  });

  it("reclaims a lock left behind by a dead process", async () => {
    const dir = await tempDir();
    const path = join(dir, "personal.lock");
    await writeFile(path, "999999 crashed\n", { encoding: "utf8", mode: 0o600 });
    const stale = new Date(Date.now() - LOCK_STALE_MS - 5_000);
    await utimes(path, stale, stale);
    const run = await withAccountLock(dir, "personal", async () => "recovered", { pollMs: 5 });
    assert.deepEqual(run, { value: "recovered", locked: true });
  });

  it("runs unlocked rather than failing when the holder never lets go", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "personal.lock"), "12345 busy\n", { encoding: "utf8", mode: 0o600 });
    const run = await withAccountLock(dir, "personal", async () => "served", {
      pollMs: 5,
      maxWaitMs: 20,
    });
    // Degrading beats refusing: a stuck lock must not take the account offline.
    assert.equal(run.value, "served");
    assert.equal(run.locked, false);
    // Somebody else's lock is left alone.
    assert.ok((await stat(join(dir, "personal.lock"))).isFile());
  });

  it("creates the lock directory 0700 with a 0600 lock file", async () => {
    const dir = join(await tempDir(), "subscriptions");
    let mode = 0;
    await withAccountLock(dir, "personal", async () => {
      mode = (await stat(join(dir, "personal.lock"))).mode & 0o777;
    });
    assert.equal(mode, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  });
});
