// End-to-end CLI tests: spawn `node dist/index.js` the way a user runs it.
// The whole world is a temp dir — SWISSCODE_HOME and HOME both point there and
// PATH starts with a fixture bin, so nothing here can read the real vault, the
// real ~/.claude, the Keychain, or a real `claude` binary.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("./index.js", import.meta.url));
const NOW = "2026-01-01T00:00:00.000Z";
const OPENROUTER_KEY = "sk-or-v1-test-openrouter-key-9f2c";
const GATEWAY_SECRET = "gw-live-do-not-print-4242";

let home = "";
let binDir = "";
let evilBinDir = "";

/** Fixture executables: never the machine's real `claude`/`pgrep`. */
async function writeExecutable(path: string, body: string): Promise<void> {
  await writeFile(path, body, "utf8");
  await chmod(path, 0o755);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), "swisscode-cli-"));
  binDir = join(home, "bin");
  evilBinDir = join(home, "evil-bin");
  await mkdir(binDir, { recursive: true });
  await mkdir(evilBinDir, { recursive: true });

  // Stands in for Claude Code. Sleeps only when asked, so the signal test can
  // kill a live child while every other test finishes immediately.
  await writeExecutable(
    join(binDir, "claude"),
    '#!/bin/sh\necho "GOOD-CLAUDE $*"\nif [ -n "$FAKE_CLAUDE_SLEEP" ]; then while :; do sleep 1; done\nfi\n',
  );
  await writeExecutable(join(evilBinDir, "claude"), '#!/bin/sh\necho "EVIL-CLAUDE"\n');
  // Records how it was called, then reports one foreign pid.
  await writeExecutable(
    join(binDir, "pgrep"),
    '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$SWISSCODE_HOME/pgrep-args"\necho 99999\n',
  );

  await writeJson(join(home, "profiles.json"), [
    // Stored key-account reference (item 17).
    { name: "ork", agentId: "claude-code", providerId: "openrouter", providerAccountId: "main" },
    // Custom provider mapping a secret onto a name no TOKEN|KEY|SECRET rule catches (item 15).
    {
      name: "gw",
      agentId: "claude-code",
      providerId: "secret-gw",
      providerConfig: { apiKey: GATEWAY_SECRET },
    },
    // Plain ambient-login profile: launches the fixture binary.
    { name: "sub", agentId: "claude-code", providerId: "claude-subscription" },
    // Proxy tag must stay readable (it is a routing label, not a credential).
    {
      name: "prox",
      agentId: "claude-code",
      providerId: "claude-subscription",
      subscriptionAccountId: "personal",
      useProxy: true,
    },
    // Hostile: provider config tries to own PATH (item 7).
    {
      name: "evil",
      agentId: "claude-code",
      providerId: "path-gw",
      providerConfig: { binDir: evilBinDir },
    },
  ]);

  await writeJson(join(home, "custom-providers.json"), {
    providers: [
      {
        id: "path-gw",
        displayName: "Path Gateway",
        fields: [{ key: "binDir", label: "Bin dir", secret: false, required: false }],
        envFromConfig: { PATH: "binDir" },
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: "secret-gw",
        displayName: "Secret Gateway",
        fields: [{ key: "apiKey", label: "API key", secret: true, required: true }],
        envStatic: { GATEWAY_URL: "https://gateway.invalid" },
        envFromConfig: { MY_PASSWORD: "apiKey" },
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
  });

  await writeJson(join(home, "accounts", "openrouter", "main.json"), {
    id: "main",
    providerId: "openrouter",
    label: "Main",
    config: { apiKey: OPENROUTER_KEY, model: "anthropic/claude-sonnet-4" },
    createdAt: NOW,
    updatedAt: NOW,
  });

  // Expired on purpose: refreshing it would need the network, so any test that
  // finishes offline proves the refresh was never reached.
  await writeJson(join(home, "subscriptions", "personal.json"), {
    account: { id: "personal", label: "Personal", createdAt: NOW, updatedAt: NOW },
    credential: { accessToken: "stale-access", refreshToken: "stale-refresh", expiresAt: 1 },
  });
});

after(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI in its own process group with a hermetic env. The group lets the
 * guard reap a hung launcher *and* its agent instead of leaking a sleeper.
 */
function runCli(
  args: string[],
  extraEnv: Record<string, string> = {},
  onSpawn?: (child: ChildProcess, stdoutSoFar: () => string) => void,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: home,
        SWISSCODE_HOME: home,
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const guard = setTimeout(() => {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    }, 20_000);
    child.on("error", (err) => {
      clearTimeout(guard);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, stdout, stderr });
    });
    onSpawn?.(child, () => stdout);
  });
}

function launchJson(stdout: string): { command: string; args: string[]; env: Record<string, string> } {
  return JSON.parse(stdout) as { command: string; args: string[]; env: Record<string, string> };
}

describe("swisscode show", () => {
  test("resolves a profile that references a stored provider account", async () => {
    const result = await runCli(["show", "ork"]);
    assert.equal(result.code, 0, result.stderr);
    const shown = JSON.parse(result.stdout) as {
      launch: { env: Record<string, string> };
    };
    // Without the account merge this failed with "missing required config: apiKey".
    assert.equal(shown.launch.env["ANTHROPIC_BASE_URL"], "https://openrouter.ai/api/v1");
    assert.equal(shown.launch.env["ANTHROPIC_MODEL"], "anthropic/claude-sonnet-4");
    assert.ok(shown.launch.env["ANTHROPIC_AUTH_TOKEN"]);
    assert.ok(
      !result.stdout.includes(OPENROUTER_KEY),
      "the account key must never be printed",
    );
  });

  test("describes the same env the launch would apply", async () => {
    const [shown, planned] = await Promise.all([runCli(["show", "prox"]), runCli(["prox", "--dry-run"])]);
    assert.equal(shown.code, 0, shown.stderr);
    const env = (JSON.parse(shown.stdout) as { launch: { env: Record<string, string> } }).launch.env;
    assert.deepEqual(env, launchJson(planned.stdout).env);
    assert.equal(env["ANTHROPIC_AUTH_TOKEN"], "swisscode-profile/prox");
  });

  test("reports an unknown profile", async () => {
    const result = await runCli(["show", "nope"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown profile "nope"/);
  });
});

describe("swisscode <profile> --dry-run", () => {
  test("masks a custom provider secret mapped to an unusual env name", async () => {
    const result = await runCli(["gw", "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    const plan = launchJson(result.stdout);
    assert.ok(
      !result.stdout.includes(GATEWAY_SECRET),
      "MY_PASSWORD holds the secret and must be masked despite its name",
    );
    assert.notEqual(plan.env["MY_PASSWORD"], GATEWAY_SECRET);
    // Masking must stay targeted: non-secret env is still readable.
    assert.equal(plan.env["GATEWAY_URL"], "https://gateway.invalid");
  });

  test("keeps the proxy profile tag readable", async () => {
    const result = await runCli(["prox", "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(launchJson(result.stdout).env["ANTHROPIC_AUTH_TOKEN"], "swisscode-profile/prox");
  });
});

describe("argument parsing", () => {
  test("does not read swisscode flags after --", async () => {
    const result = await runCli(["nope", "--", "-h"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown profile "nope"/);
    assert.ok(!result.stdout.includes("launch coding agents"), "-h after -- is the agent's flag");
  });

  test("passes everything after -- to the agent verbatim", async () => {
    const result = await runCli(["gw", "--dry-run", "--", "--verbose", "-h"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(launchJson(result.stdout).args, ["--verbose", "-h"]);
  });

  test("--dry-run after -- launches instead of printing a plan", async () => {
    const result = await runCli(["sub", "--", "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /GOOD-CLAUDE --dry-run/);
  });

  test("-h before -- still prints swisscode help", async () => {
    const result = await runCli(["-h"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /launch coding agents/);
  });

  test("a bare flag is a usage error, not a profile name", async () => {
    const result = await runCli(["--dry-run"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown option "--dry-run"/);
    assert.match(result.stderr, /Usage:/);
    assert.ok(!result.stderr.includes("Unknown profile"));
  });

  test("an unknown profile points at `swisscode list`", async () => {
    const result = await runCli(["nope"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown profile "nope"\. Run `swisscode list`/);
  });
});

describe("launching the agent", () => {
  test("resolves the binary against the parent PATH", async () => {
    const result = await runCli(["sub"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /GOOD-CLAUDE/);
  });

  test("provider config cannot repoint PATH at another binary", async () => {
    const result = await runCli(["evil"]);
    assert.ok(
      !result.stdout.includes("EVIL-CLAUDE"),
      "stored provider config must never choose which binary runs",
    );
    assert.ok(
      result.stdout.includes("GOOD-CLAUDE") || /PATH/.test(result.stderr),
      "either the parent-PATH binary ran or the launcher refused the reserved env name",
    );
  });

  test("relays SIGTERM to the agent and exits 128+signal", async () => {
    const result = await runCli(["sub"], { FAKE_CLAUDE_SLEEP: "1" }, (child, stdoutSoFar) => {
      const poll = setInterval(() => {
        if (!stdoutSoFar().includes("GOOD-CLAUDE")) return;
        clearInterval(poll);
        child.kill("SIGTERM"); // the agent is not in this signal's path
      }, 20);
      child.on("close", () => clearInterval(poll));
    });
    // 143 = 128 + SIGTERM: the agent died of the relayed signal, and swisscode
    // survived long enough to report it rather than being killed outright.
    assert.equal(result.code, 143);
    assert.equal(result.signal, null);
  });
});

describe("swisscode accounts use", () => {
  test("detects other claude sessions before spending a refresh token", async () => {
    const vaultPath = join(home, "subscriptions", "personal.json");
    const before = await readFile(vaultPath, "utf8");
    const result = await runCli(["accounts", "use", "personal"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Other `claude` sessions are running/);
    // The stored credential is expired: a refresh would have rotated and
    // rewritten it (and needed the network) before the check could fire.
    assert.equal(await readFile(vaultPath, "utf8"), before);
  });

  test("matches claude by command line, not just the native binary name", async () => {
    const recorded = (await readFile(join(home, "pgrep-args"), "utf8")).split("\n");
    assert.equal(recorded[0], "-f");
    const pattern = new RegExp(recorded[1] ?? "");
    assert.ok(pattern.test("claude"), "bare binary");
    assert.ok(pattern.test("/usr/local/bin/claude --resume"), "native binary with args");
    assert.ok(
      pattern.test("node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
      "npm install running as node",
    );
    assert.ok(!pattern.test("node /home/me/.swisscode/apps/cli/dist/index.js claude"), "swisscode itself");
    assert.ok(!pattern.test("/home/me/.claude/statusline.sh"), "unrelated ~/.claude tooling");
  });
});
