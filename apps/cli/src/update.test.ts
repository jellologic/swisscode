// Hermetic unit tests for the self-update engine. Every collaborator is
// injected — registry, npm, install layout, settings — so nothing here touches
// the network, runs `npm i -g`, or reads the real home dir. (The live
// registry path is exercised only through stubs; the `off`-mode e2e lives in
// cli.test.ts, where the spawned binary provably returns before any fetch.)

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UpdateMode } from "@swisscode/core";
import {
  applyGlobalUpdate,
  checkForUpdate,
  cmdUpdate,
  decideUpdate,
  detectInstallKind,
  ensureAutoUpdate,
  type InstallKind,
  type UpdateCheck,
} from "./update.js";
import { currentVersion } from "./version.js";

const CURRENT = "2.1.7";
const LATEST = "9.9.9";
const NOW = 1_786_000_000_000;

function availableCheck(current = CURRENT, latest = LATEST): UpdateCheck {
  return { current, latest, updateAvailable: true };
}

/** A registry stub answering with one release version (or failing closed). */
function registryStub(version: unknown, ok = true) {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return { ok, json: async () => ({ version }) } as unknown as Response;
  }) as typeof fetch;
  return { fetchFn, calls: () => calls };
}

function explodingFetch(): typeof fetch {
  return (async () => {
    throw new Error("network must stay silent in this test");
  }) as typeof fetch;
}

describe("decideUpdate", () => {
  it("maps mode × kind × availability to apply, notify, or skip", () => {
    const kinds: InstallKind[] = ["npm-global", "git-checkout", "linked-checkout", "unknown"];
    for (const kind of kinds) {
      assert.equal(decideUpdate("off", kind, true), "skip", `off/${kind}/available`);
      assert.equal(decideUpdate("off", kind, false), "skip", `off/${kind}/same`);
      assert.equal(decideUpdate("notify-only", kind, false), "skip", `notify/${kind}/same`);
      assert.equal(decideUpdate("auto", kind, false), "skip", `auto/${kind}/same`);
      assert.equal(decideUpdate("notify-only", kind, true), "notify", `notify/${kind}/available`);
    }
    assert.equal(decideUpdate("auto", "npm-global", true), "apply");
    // Only a real global install ever self-modifies: every checkout-shaped
    // layout (including unknown) degrades to a hint, never `npm i -g`.
    for (const kind of ["git-checkout", "linked-checkout", "unknown"] as const) {
      assert.equal(decideUpdate("auto", kind, true), "notify", `auto/${kind}/available`);
    }
  });
});

describe("detectInstallKind", () => {
  // The walk itself runs on real temp dirs; link resolution is injected so
  // the suite is hermetic on machines whose TMPDIR sits under a symlink
  // (macOS /var → /private/var would otherwise read every path as linked).
  const identity = async (p: string): Promise<string> => p;

  async function fixture(layout: "global" | "checkout"): Promise<{ root: string; bundle: string }> {
    const root = await mkdtemp(join(tmpdir(), "swisscode-kind-"));
    const bundle =
      layout === "global"
        ? join(root, "prefix", "node_modules", "swisscode", "dist", "bundle.js")
        : join(root, "checkout", "apps", "cli", "dist", "bundle.js");
    await mkdir(join(bundle, ".."), { recursive: true });
    await writeFile(bundle, "fake bundle", "utf8");
    if (layout === "checkout") await mkdir(join(root, "checkout", ".git"), { recursive: true });
    return { root, bundle };
  }

  it("reads a node_modules layout with no checkout marker as npm-global", async () => {
    const { root, bundle } = await fixture("global");
    try {
      assert.equal(await detectInstallKind({ bundleFile: bundle, realpath: identity }), "npm-global");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a .git ancestor as git-checkout", async () => {
    const { root, bundle } = await fixture("checkout");
    try {
      assert.equal(await detectInstallKind({ bundleFile: bundle, realpath: identity }), "git-checkout");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a symlinked bundle as linked-checkout", async () => {
    const { root, bundle } = await fixture("checkout");
    const link = join(root, "bin", "swisscode");
    try {
      await mkdir(join(link, ".."), { recursive: true });
      await symlink(bundle, link);
      const kind = await detectInstallKind({
        bundleFile: link,
        realpath: async (p) => (p === link ? bundle : p),
      });
      assert.equal(kind, "linked-checkout");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads an empty path or a failing realpath as unknown", async () => {
    assert.equal(await detectInstallKind({ bundleFile: "" }), "unknown");
    assert.equal(
      await detectInstallKind({
        bundleFile: "/nowhere/bundle.js",
        realpath: async () => {
          throw new Error("ENOENT");
        },
      }),
      "unknown",
    );
  });

  it("reads a layout with no markers at all as unknown", async () => {
    assert.equal(
      await detectInstallKind({
        bundleFile: "/nowhere/bundle.js",
        realpath: identity,
        dirExists: async () => false,
      }),
      "unknown",
    );
  });
});

describe("checkForUpdate", () => {
  it("returns the release comparison and caches a live answer", async () => {
    const { fetchFn, calls } = registryStub(LATEST);
    let saved: unknown;
    const checked = await checkForUpdate({
      current: CURRENT,
      fetchFn,
      nowMs: NOW,
      loadCache: async () => undefined,
      saveCache: async (cache) => {
        saved = cache;
      },
    });
    assert.deepEqual(checked, { current: CURRENT, latest: LATEST, updateAvailable: true });
    assert.deepEqual(saved, { checkedAt: NOW, latest: LATEST });
    assert.equal(calls(), 1);
  });

  it("reports no update when the release matches", async () => {
    const { fetchFn } = registryStub(CURRENT);
    const checked = await checkForUpdate({
      current: CURRENT,
      fetchFn,
      nowMs: NOW,
      loadCache: async () => undefined,
      saveCache: async () => {},
    });
    assert.deepEqual(checked, { current: CURRENT, latest: CURRENT, updateAvailable: false });
  });

  it("answers from a fresh cache with zero network", async () => {
    const checked = await checkForUpdate({
      current: CURRENT,
      fetchFn: explodingFetch(),
      nowMs: NOW,
      loadCache: async () => ({ checkedAt: NOW - 1000, latest: LATEST }),
      saveCache: async () => {
        throw new Error("fresh cache must not rewrite");
      },
    });
    assert.deepEqual(checked, { current: CURRENT, latest: LATEST, updateAvailable: true });
  });

  it("refetches a stale cache and honors ttlMs: 0 as force-live", async () => {
    for (const ttlMs of [undefined, 0]) {
      const { fetchFn, calls } = registryStub(LATEST);
      const checked = await checkForUpdate({
        current: CURRENT,
        fetchFn,
        nowMs: NOW,
        ttlMs,
        loadCache: async () => ({ checkedAt: 0, latest: "0.0.1" }),
        saveCache: async () => {},
      });
      assert.equal(checked?.latest, LATEST, `ttlMs=${String(ttlMs)}`);
      assert.equal(calls(), 1, `ttlMs=${String(ttlMs)}`);
    }
  });

  it("treats a torn or misshapen cache as a miss", async () => {
    for (const loadCache of [
      async (): Promise<unknown> => {
        throw new Error("torn json");
      },
      async (): Promise<unknown> => ({ checkedAt: "yesterday", latest: LATEST }),
      async (): Promise<unknown> => ({ checkedAt: NOW, latest: "" }),
    ]) {
      const { fetchFn } = registryStub(LATEST);
      const checked = await checkForUpdate({
        current: CURRENT,
        fetchFn,
        nowMs: NOW,
        loadCache,
        saveCache: async () => {},
      });
      assert.equal(checked?.latest, LATEST);
    }
  });

  it("fails silent-null on registry errors, never a throw", async () => {
    const badRegistry: Array<Parameters<typeof checkForUpdate>[0]> = [
      { fetchFn: explodingFetch() },
      { fetchFn: registryStub(LATEST, false).fetchFn },
      { fetchFn: registryStub({ notVersion: true }).fetchFn },
      { fetchFn: registryStub("").fetchFn },
    ];
    for (const stub of badRegistry) {
      const checked = await checkForUpdate({
        current: CURRENT,
        nowMs: NOW,
        loadCache: async () => undefined,
        saveCache: async () => {},
        ...stub,
      });
      assert.equal(checked, null);
    }
  });
});

describe("applyGlobalUpdate", () => {
  it("installs swisscode@latest globally", async () => {
    let ran: { command: string; args: string[] } | undefined;
    const result = await applyGlobalUpdate({
      execFn: async (command, args) => {
        ran = { command, args };
        return { stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(ran, { command: "npm", args: ["i", "-g", "swisscode@latest"] });
  });

  it("reports expected failure as data, with the npm message", async () => {
    const result = await applyGlobalUpdate({
      execFn: async () => {
        throw new Error("npm E404 swisscode@latest");
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /E404/);
  });
});

describe("ensureAutoUpdate", () => {
  it("never touches the network when the mode is off", async () => {
    const result = await ensureAutoUpdate({
      loadMode: async () => "off",
      detect: async () => {
        throw new Error("off must not classify");
      },
      check: async () => {
        throw new Error("off must not check");
      },
      apply: async () => {
        throw new Error("off must not apply");
      },
    });
    assert.deepEqual(result, { decision: "skip", current: currentVersion() });
  });

  it("notifies without installing in notify-only mode", async () => {
    let applied = 0;
    const result = await ensureAutoUpdate({
      loadMode: async () => "notify-only",
      detect: async () => "npm-global",
      check: async () => availableCheck(),
      apply: async () => {
        applied += 1;
        return { ok: true };
      },
    });
    assert.equal(result.decision, "notify");
    assert.equal(result.latest, LATEST);
    assert.match(result.notice ?? "", /→ 9\.9\.9/);
    assert.equal(applied, 0);
  });

  it("applies over an npm-global install in auto mode", async () => {
    let applied = 0;
    const result = await ensureAutoUpdate({
      loadMode: async () => "auto",
      detect: async () => "npm-global",
      check: async () => availableCheck(),
      apply: async () => {
        applied += 1;
        return { ok: true };
      },
    });
    assert.equal(applied, 1);
    assert.deepEqual(
      { decision: result.decision, applied: result.applied, latest: result.latest },
      { decision: "apply", applied: true, latest: LATEST },
    );
    assert.match(result.notice ?? "", /restarting UI/);
  });

  it("degrades checkouts and unknown layouts to a notify with a hint", async () => {
    for (const kind of ["git-checkout", "linked-checkout", "unknown"] as const) {
      let applied = 0;
      const result = await ensureAutoUpdate({
        loadMode: async () => "auto",
        detect: async () => kind,
        check: async () => availableCheck(),
        apply: async () => {
          applied += 1;
          return { ok: true };
        },
      });
      assert.equal(result.decision, "notify", kind);
      assert.match(result.notice ?? "", /never self-modifies/, kind);
      assert.equal(applied, 0, kind);
    }
  });

  it("skips quietly when current or the check says no update", async () => {
    for (const check of [
      async () => ({ ...availableCheck(), updateAvailable: false }),
      async () => null,
    ]) {
      const result = await ensureAutoUpdate({
        loadMode: async () => "auto",
        detect: async () => "npm-global",
        check,
        apply: async () => {
          throw new Error("nothing to apply");
        },
      });
      assert.equal(result.decision, "skip");
      assert.equal(result.applied, undefined);
    }
  });

  it("falls back to notify when the install fails, naming the cause", async () => {
    const result = await ensureAutoUpdate({
      loadMode: async () => "auto",
      detect: async () => "npm-global",
      check: async () => availableCheck(),
      apply: async () => ({ ok: false, message: "npm EAI_AGAIN" }),
    });
    assert.equal(result.decision, "notify");
    assert.match(result.notice ?? "", /automatic install failed.*EAI_AGAIN/);
  });

  it("never throws: loader and check failures read as skip", async () => {
    const silent = await ensureAutoUpdate({
      loadMode: async () => {
        throw new Error("torn settings");
      },
    });
    assert.equal(silent.decision, "skip");
    const blind = await ensureAutoUpdate({
      loadMode: async () => "auto",
      detect: async () => "npm-global",
      check: async () => {
        throw new Error("registry exploded");
      },
    });
    assert.equal(blind.decision, "skip");
  });
});

describe("cmdUpdate", () => {
  let out: string[] = [];
  let errLines: string[] = [];
  let savedExitCode: number | undefined;
  const realLog = console.log;
  const realError = console.error;

  beforeEach(() => {
    out = [];
    errLines = [];
    savedExitCode = process.exitCode as number | undefined;
    process.exitCode = undefined;
    console.log = (...args: unknown[]) => {
      out.push(args.join(" "));
    };
    console.error = (...args: unknown[]) => {
      errLines.push(args.join(" "));
    };
  });

  afterEach(() => {
    console.log = realLog;
    console.error = realError;
    process.exitCode = savedExitCode;
  });

  function baseOpts(overrides?: {
    mode?: UpdateMode;
    check?: UpdateCheck | null;
    kind?: InstallKind;
    applied?: { ok: boolean; message?: string };
  }) {
    let checks = 0;
    let detects = 0;
    let applies = 0;
    return {
      counts: () => ({ checks, detects, applies }),
      opts: {
        loadMode: async () => overrides?.mode ?? ("auto" as UpdateMode),
        check: async () => {
          checks += 1;
          return overrides?.check === undefined ? availableCheck() : overrides.check;
        },
        detect: async () => {
          detects += 1;
          return overrides?.kind ?? ("npm-global" as InstallKind);
        },
        apply: async () => {
          applies += 1;
          return overrides?.applied ?? { ok: true };
        },
      },
    };
  }

  it("prints help without touching settings or the network", async () => {
    const { counts, opts } = baseOpts();
    await cmdUpdate(["--help"], { ...opts, loadMode: async () => {
      throw new Error("help must not load settings");
    } });
    assert.match(out.join("\n"), /swisscode update \[--check\|--apply\]/);
    assert.deepEqual(counts(), { checks: 0, detects: 0, applies: 0 });
    assert.equal(process.exitCode, undefined);
  });

  it("short-circuits with zero requests when checks are off", async () => {
    const { counts, opts } = baseOpts({ mode: "off" });
    await cmdUpdate([], opts);
    assert.match(out.join("\n"), /update checks are off/);
    assert.deepEqual(counts(), { checks: 0, detects: 0, applies: 0 });
    assert.equal(process.exitCode, undefined);
  });

  it("--apply works even when the background mode is off", async () => {
    const { counts, opts } = baseOpts({ mode: "off" });
    await cmdUpdate(["--apply"], opts);
    assert.match(out.join("\n"), new RegExp(`Updated swisscode ${CURRENT} → ${LATEST}`));
    assert.deepEqual(counts(), { checks: 1, detects: 1, applies: 1 });
    assert.equal(process.exitCode, undefined);
  });

  it("reports an unreachable registry on stderr with exit 1", async () => {
    const { opts } = baseOpts({ check: null });
    await cmdUpdate([], opts);
    assert.match(errLines.join("\n"), /Could not reach the npm registry/);
    assert.equal(process.exitCode, 1);
  });

  it("reports current when the release matches", async () => {
    const { opts } = baseOpts({ check: { ...availableCheck(), updateAvailable: false } });
    await cmdUpdate([], opts);
    assert.match(out.join("\n"), new RegExp(`swisscode ${CURRENT} is the latest release`));
    assert.equal(process.exitCode, undefined);
  });

  it("points at --apply without installing on a bare check", async () => {
    const { counts, opts } = baseOpts();
    await cmdUpdate([], opts);
    assert.match(out.join("\n"), /swisscode update --apply/);
    assert.deepEqual(counts(), { checks: 1, detects: 0, applies: 0 });
    assert.equal(process.exitCode, undefined);
  });

  it("refuses --apply on a checkout with a hint, never installing", async () => {
    const { counts, opts } = baseOpts({ kind: "linked-checkout" });
    await cmdUpdate(["--apply"], opts);
    assert.match(errLines.join("\n"), /never self-modifies/);
    assert.deepEqual(counts(), { checks: 1, detects: 1, applies: 0 });
    assert.equal(process.exitCode, 1);
  });

  it("installs on --apply over an npm-global layout", async () => {
    const { counts, opts } = baseOpts();
    await cmdUpdate(["--apply"], opts);
    assert.match(out.join("\n"), new RegExp(`Updated swisscode ${CURRENT} → ${LATEST}`));
    assert.deepEqual(counts(), { checks: 1, detects: 1, applies: 1 });
    assert.equal(process.exitCode, undefined);
  });

  it("reports a failed install on stderr with exit 1", async () => {
    const { opts } = baseOpts({ applied: { ok: false, message: "npm EACCES" } });
    await cmdUpdate(["--apply"], opts);
    assert.match(errLines.join("\n"), /Automatic install failed.*EACCES/);
    assert.equal(process.exitCode, 1);
  });

  it("reads torn settings as auto for an explicit request", async () => {
    const { counts, opts } = baseOpts();
    await cmdUpdate([], {
      ...opts,
      loadMode: async () => {
        throw new Error("torn settings.json");
      },
    });
    assert.match(out.join("\n"), /swisscode update --apply/);
    assert.equal(counts().checks, 1);
  });
});
