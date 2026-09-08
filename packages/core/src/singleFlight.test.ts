import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SingleFlight } from "./singleFlight.js";

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SingleFlight", () => {
  it("runs the work once for concurrent callers on the same key", async () => {
    const flight = new SingleFlight<string>();
    const gate = deferred<string>();
    let calls = 0;
    const start = () =>
      flight.run("a", () => {
        calls += 1;
        return gate.promise;
      });
    const all = Promise.all([start(), start(), start()]);
    assert.equal(calls, 1);
    assert.equal(flight.size, 1);
    gate.resolve("token-1");
    assert.deepEqual(await all, ["token-1", "token-1", "token-1"]);
  });

  it("keeps different keys independent", async () => {
    const flight = new SingleFlight<string>();
    const calls: string[] = [];
    const [a, b] = await Promise.all([
      flight.run("a", async () => {
        calls.push("a");
        return "A";
      }),
      flight.run("b", async () => {
        calls.push("b");
        return "B";
      }),
    ]);
    assert.equal(a, "A");
    assert.equal(b, "B");
    assert.deepEqual(calls.sort(), ["a", "b"]);
  });

  it("clears the key once settled so the next call runs again", async () => {
    const flight = new SingleFlight<number>();
    let calls = 0;
    const run = () =>
      flight.run("a", async () => {
        calls += 1;
        return calls;
      });
    assert.equal(await run(), 1);
    assert.equal(flight.size, 0);
    assert.equal(await run(), 2);
    assert.equal(flight.size, 0);
  });

  it("shares a rejection and does not cache the failure", async () => {
    const flight = new SingleFlight<string>();
    const gate = deferred<string>();
    let calls = 0;
    const start = () =>
      flight.run("a", () => {
        calls += 1;
        return gate.promise;
      });
    const first = start();
    const second = start();
    gate.reject(new Error("invalid_grant"));
    await assert.rejects(() => first, /invalid_grant/);
    await assert.rejects(() => second, /invalid_grant/);
    assert.equal(calls, 1);
    assert.equal(flight.size, 0);
    assert.equal(await flight.run("a", async () => "recovered"), "recovered");
  });

  it("turns a synchronous throw into a rejection and still clears the key", async () => {
    const flight = new SingleFlight<string>();
    await assert.rejects(
      () =>
        flight.run("a", () => {
          throw new Error("sync boom");
        }),
      /sync boom/,
    );
    assert.equal(flight.size, 0);
  });
});
