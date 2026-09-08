import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  NATIVE_PROBE,
  NODE_CLI_PROBE,
  countOtherClaudeSessions,
  parsePids,
  type ProcessProbe,
} from "./claudeSessions.js";

function probe(byArgs: Record<string, string | Error>): {
  run: ProcessProbe;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: ProcessProbe = async (command, args) => {
    calls.push([command, ...args]);
    const result = byArgs[args.join(" ")];
    if (result === undefined) return "";
    if (result instanceof Error) throw result;
    return result;
  };
  return { run, calls };
}

describe("parsePids", () => {
  it("reads one pid per line and ignores noise", () => {
    assert.deepEqual(parsePids("101\n\n 202 \nnot-a-pid\n"), [101, 202]);
    assert.deepEqual(parsePids(""), []);
  });
});

describe("countOtherClaudeSessions", () => {
  it("sees the node-launched CLI that `pgrep -x claude` misses", async () => {
    const { run, calls } = probe({ [NODE_CLI_PROBE.join(" ")]: "4242\n" });
    assert.equal(await countOtherClaudeSessions(run, 999), 1);
    assert.deepEqual(calls, [
      ["pgrep", ...NATIVE_PROBE],
      ["pgrep", ...NODE_CLI_PROBE],
    ]);
  });

  it("counts a pid once when both probes match it", async () => {
    const { run } = probe({
      [NATIVE_PROBE.join(" ")]: "10\n11\n",
      [NODE_CLI_PROBE.join(" ")]: "11\n12\n",
    });
    assert.equal(await countOtherClaudeSessions(run, 999), 3);
  });

  it("never counts this process", async () => {
    const { run } = probe({ [NATIVE_PROBE.join(" ")]: "999\n" });
    assert.equal(await countOtherClaudeSessions(run, 999), 0);
  });

  it("treats a failing probe as no matches (pgrep exits 1 when nothing matched)", async () => {
    const { run } = probe({
      [NATIVE_PROBE.join(" ")]: new Error("Command failed: pgrep -x claude"),
      [NODE_CLI_PROBE.join(" ")]: "7\n",
    });
    assert.equal(await countOtherClaudeSessions(run, 999), 1);
  });
});
