import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CredentialStoreError } from "@swisscode/core";
import type { OAuthCredential } from "@swisscode/core";
import { CLAUDE_KEYCHAIN_SERVICE, ClaudeActiveCredentialStore } from "./activeStore.js";
import type { ExecFn } from "./activeStore.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

const credential: OAuthCredential = { accessToken: "a2", refreshToken: "r2", expiresAt: 1000 };

/** An error shaped like a failed `execFile`: exit status on `code`. */
function exitError(code: number): Error {
  return Object.assign(new Error(`security exited ${code}`), { code });
}

/** Reject like a missing binary (non-macOS). */
const noSecurityBinary: ExecFn = async () => {
  throw Object.assign(new Error("spawn security ENOENT"), { code: "ENOENT" });
};

function failingExec(code: number): ExecFn {
  return async () => {
    throw exitError(code);
  };
}

/** Minimal `security` stand-in over one in-memory generic-password item. */
function fakeKeychain(initial?: Record<string, unknown>): {
  exec: ExecFn;
  item: () => Record<string, unknown> | undefined;
  calls: () => string[][];
} {
  let item = initial;
  const calls: string[][] = [];
  const exec: ExecFn = async (file, args) => {
    calls.push([file, ...args]);
    const [command] = args;
    if (command === "find-generic-password") {
      if (!item) throw exitError(44);
      if (args.includes("-w")) return { stdout: `${JSON.stringify(item)}\n`, stderr: "" };
      return { stdout: `keychain: "login"\n    "acct"<blob>="alice"\n`, stderr: "" };
    }
    if (command === "add-generic-password") {
      const payload = args[args.indexOf("-w") + 1] as string;
      item = JSON.parse(payload) as Record<string, unknown>;
      return { stdout: "", stderr: "" };
    }
    throw exitError(1);
  };
  return { exec, item: () => item, calls: () => calls };
}

describe("ClaudeActiveCredentialStore file writes", () => {
  it("writes 0600 through a temp file in the target directory", async () => {
    const home = join(await tempDir("claude-write-"), "nested", ".claude");
    const store = new ClaudeActiveCredentialStore({ configHome: home, keychain: false });
    await store.writeActive(credential);
    const path = join(home, ".credentials.json");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    // The parent is created 0700 and no temp file survives the rename.
    assert.equal((await stat(home)).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(home), [".credentials.json"]);
    const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(written["claudeAiOauth"], { accessToken: "a2", refreshToken: "r2", expiresAt: 1000 });
  });

  it("ignores a symlink pre-planted at the old predictable /tmp path", async () => {
    // Regression: the temp file used to be /tmp/.swisscode-credentials-<pid>.json,
    // a name any local process can guess and point at a file of its choosing.
    const predictable = join(tmpdir(), `.swisscode-credentials-${process.pid}.json`);
    const canary = join(await tempDir("claude-canary-"), "canary.json");
    await writeFile(canary, "untouched", "utf8");
    await rm(predictable, { force: true });
    await symlink(canary, predictable);
    try {
      const home = await tempDir("claude-symlink-");
      const store = new ClaudeActiveCredentialStore({ configHome: home, keychain: false });
      await store.writeActive(credential);
      assert.equal(await readFile(canary, "utf8"), "untouched");
      assert.ok((await stat(join(home, ".credentials.json"))).isFile());
    } finally {
      await rm(predictable, { force: true });
    }
  });

  it("keeps a copy when it has to replace content it could not parse", async () => {
    const home = await tempDir("claude-corrupt-");
    const path = join(home, ".credentials.json");
    await writeFile(path, "{ this is not json", "utf8");
    const store = new ClaudeActiveCredentialStore({ configHome: home, keychain: false });
    assert.equal((await store.readActive()).backend, "none");
    await store.writeActive(credential);
    assert.equal(await readFile(`${path}.bak`, "utf8"), "{ this is not json");
    const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    assert.deepEqual(written["claudeAiOauth"], { accessToken: "a2", refreshToken: "r2", expiresAt: 1000 });
  });
});

describe("ClaudeActiveCredentialStore keychain diagnosis", () => {
  it("reads the Keychain item and updates it in place", async () => {
    const kc = fakeKeychain({
      mcpOAuth: { x: 1 },
      claudeAiOauth: { accessToken: "a", refreshToken: "r", subscriptionType: "max" },
    });
    const home = await tempDir("claude-kc-");
    const store = new ClaudeActiveCredentialStore({ configHome: home, execFn: kc.exec });
    const before = await store.readActiveDetail();
    assert.equal(before.backend, "keychain");
    assert.equal(before.keychain, "ok");
    assert.equal(before.source, CLAUDE_KEYCHAIN_SERVICE);

    await store.writeActive(credential);
    const item = kc.item() as Record<string, unknown>;
    assert.deepEqual(item["mcpOAuth"], { x: 1 });
    assert.deepEqual(item["claudeAiOauth"], {
      subscriptionType: "max",
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 1000,
    });
    // The item's own account name is reused, else `-U` creates a duplicate.
    const add = kc.calls().find((c) => c[1] === "add-generic-password");
    assert.equal(add?.[add.indexOf("-a") + 1], "alice");
    // The mirror keeps the file in sync with the Keychain.
    const mirrored = JSON.parse(
      await readFile(join(home, ".credentials.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(mirrored["claudeAiOauth"], {
      accessToken: "a2",
      refreshToken: "r2",
      expiresAt: 1000,
    });
  });

  it("treats exit 44 as an absent item and still swaps the file", async () => {
    const home = await tempDir("claude-44-");
    const store = new ClaudeActiveCredentialStore({ configHome: home, execFn: failingExec(44) });
    const detail = await store.readActiveDetail();
    assert.equal(detail.keychain, "not-found");
    assert.equal(detail.backend, "none");
    await store.writeActive(credential);
    assert.ok((await stat(join(home, ".credentials.json"))).isFile());
  });

  it("treats a missing `security` binary as no keychain at all", async () => {
    const home = await tempDir("claude-nokc-");
    const store = new ClaudeActiveCredentialStore({ configHome: home, execFn: noSecurityBinary });
    assert.equal((await store.readActiveDetail()).keychain, "unavailable");
    await store.writeActive(credential);
    assert.ok((await stat(join(home, ".credentials.json"))).isFile());
  });

  it("refuses to switch when an item exists but cannot be read", async () => {
    // 36/51/128: denied or locked. A file-only write would report success while
    // `claude` keeps reading the account we could not touch.
    for (const code of [36, 51, 128]) {
      const home = await tempDir(`claude-denied-${code}-`);
      await writeFile(
        join(home, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } }),
        "utf8",
      );
      const store = new ClaudeActiveCredentialStore({ configHome: home, execFn: failingExec(code) });
      const detail = await store.readActiveDetail();
      assert.equal(detail.keychain, "unreadable");
      assert.match(detail.keychainError ?? "", new RegExp(String(code)));
      await assert.rejects(
        () => store.writeActive(credential),
        (err: unknown) =>
          err instanceof CredentialStoreError && err.kind === "keychain-unreadable",
      );
      // The credentials file is untouched, so nothing is half-switched.
      const after = JSON.parse(
        await readFile(join(home, ".credentials.json"), "utf8"),
      ) as { claudeAiOauth: Record<string, unknown> };
      assert.equal(after.claudeAiOauth["refreshToken"], "r");
    }
  });

  it("reports keychain-missing when the item vanished before the update", async () => {
    const kc = fakeKeychain({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } });
    const home = await tempDir("claude-gone-");
    let vanished = false;
    const store = new ClaudeActiveCredentialStore({
      configHome: home,
      execFn: async (file, args) => {
        // The account lookup (no -w) fails: the item is gone.
        if (vanished && args[0] === "find-generic-password" && !args.includes("-w")) {
          throw exitError(44);
        }
        vanished = true;
        return kc.exec(file, args);
      },
    });
    await assert.rejects(
      () => store.writeActive(credential),
      (err: unknown) => err instanceof CredentialStoreError && err.kind === "keychain-missing",
    );
  });

  it("fails loudly when the Keychain write does not take effect", async () => {
    const home = await tempDir("claude-noop-");
    const item = { claudeAiOauth: { accessToken: "a", refreshToken: "r" } };
    const store = new ClaudeActiveCredentialStore({
      configHome: home,
      // add-generic-password "succeeds" but the item never changes.
      execFn: async (_file, args) => {
        if (args[0] === "add-generic-password") return { stdout: "", stderr: "" };
        if (args.includes("-w")) return { stdout: JSON.stringify(item), stderr: "" };
        return { stdout: `"acct"<blob>="alice"`, stderr: "" };
      },
    });
    await assert.rejects(
      () => store.writeActive(credential),
      (err: unknown) => err instanceof CredentialStoreError && err.kind === "write-failed",
    );
  });
});
