// End-to-end CLI tests: spawn `node dist/index.js` the way a user runs it.
// The whole world is a temp dir — SWISSCODE_HOME and HOME both point there and
// PATH starts with a fixture bin, so nothing here can read the real vault, the
// real ~/.claude, the Keychain, or a real `claude` binary.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { openTrafficStore, toStoredExchange } from "@swisscode/adapters";
import type { ProxyTrafficEntry } from "@swisscode/adapters";

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
  // Appends one line per invocation (the session probe runs pgrep twice), then
  // reports the same foreign pid both times.
  await writeExecutable(
    join(binDir, "pgrep"),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SWISSCODE_HOME/pgrep-args"\necho 99999\n',
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
    // Plain ambient-login profile: now proxy-mode like everything else.
    { name: "sub", agentId: "claude-code", providerId: "claude-subscription" },
    // Same, but direct: the only profiles that can launch with no proxy up.
    { name: "dsub", agentId: "claude-code", providerId: "claude-subscription", direct: true },
    // Direct profile with session options: exercises ephemeral file staging.
    {
      name: "sess",
      agentId: "claude-code",
      providerId: "claude-subscription",
      direct: true,
      session: { permissionMode: "acceptEdits", allowedTools: ["Read"], fallbackModel: ["claude-sonnet-5"] },
    },
    // Curated session field vs freeform agentArgs: the freeform tail wins.
    {
      name: "sessover",
      agentId: "claude-code",
      providerId: "claude-subscription",
      direct: true,
      session: { permissionMode: "acceptEdits" },
      agentArgs: ["--permission-mode", "plan"],
    },
    // Proxy tag must stay readable (it is a routing label, not a credential).
    {
      name: "prox",
      agentId: "claude-code",
      providerId: "claude-subscription",
      subscriptionAccountId: "personal",
      useProxy: true,
      modelRoutes: [{ match: "claude-opus-5", kind: "subscription", subscriptionAccountId: "personal" }],
    },
    // Hostile: provider config tries to own PATH (item 7). Direct, so the
    // test exercises binary resolution instead of the proxy-down abort.
    {
      name: "evil",
      agentId: "claude-code",
      providerId: "path-gw",
      direct: true,
      providerConfig: { binDir: evilBinDir },
    },
    // Working-directory template: the harness home always exists.
    {
      name: "cwdp",
      agentId: "claude-code",
      providerId: "claude-subscription",
      direct: true,
      cwd: home,
    },    // Same, but pointing nowhere: launching must fail before spawning.
    {
      name: "cwdmissing",
      agentId: "claude-code",
      providerId: "claude-subscription",
      direct: true,
      cwd: join(home, "gone"),
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

function launchJson(stdout: string): { command: string; args: string[]; env: Record<string, string>; cwd?: string } {
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
    // Key profiles launch through the proxy by default, so the upstream URL is
    // proxy-side now — but the account-merged model override still applies.
    assert.equal(shown.launch.env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:8123/p/ork");
    assert.equal(shown.launch.env["ANTHROPIC_AUTH_TOKEN"], "swisscode-profile/ork");
    assert.equal(shown.launch.env["ANTHROPIC_MODEL"], "anthropic/claude-sonnet-4");
    assert.ok(
      !result.stdout.includes(OPENROUTER_KEY),
      "the account key must never be printed",
    );
  });

  test("renders model routes as sentences", async () => {
    const result = await runCli(["show", "prox"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual((JSON.parse(result.stdout) as { routes: string[] }).routes, [
      "Requests for `claude-opus-5` → Personal vault account, model sent unchanged.",
    ]);
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

describe("swisscode list", () => {
  test("marks routed and direct profiles", async () => {
    const result = await runCli(["list"]);
    assert.equal(result.code, 0, result.stderr);
    const prox = result.stdout.split("\n").find((l) => l.startsWith("prox\t"));
    assert.ok(prox?.includes("routes=1"), "routed profiles carry a route marker");
    const dsub = result.stdout.split("\n").find((l) => l.startsWith("dsub\t"));
    assert.ok(dsub?.includes("\tdirect"), "direct opt-outs are visible");
    const ork = result.stdout.split("\n").find((l) => l.startsWith("ork\t"));
    assert.ok(ork && !ork.includes("routes="), "unrouted profiles stay unmarked");
  });
});

describe("swisscode init", () => {
  test("bare init lists the starter presets", async () => {
    const result = await runCli(["init"]);
    assert.equal(result.code, 0, result.stderr);
    for (const id of ["solo", "heavy-opus", "frugal", "reviewer"]) {
      assert.match(result.stdout, new RegExp(`\\b${id}\\b`), `preset ${id} is listed`);
    }
  });

  test("unknown preset names the available ones", async () => {
    const result = await runCli(["init", "nope"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Unknown preset "nope"/);
  });

  test("slot-less preset dry-runs without touching the stores", async () => {
    const before = await readFile(join(home, "profiles.json"), "utf8");
    const result = await runCli(["init", "reviewer", "--name", "init-probe", "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    const filled = JSON.parse(result.stdout) as { name: string; session?: { permissionMode?: string } };
    assert.equal(filled.name, "init-probe");
    assert.equal(filled.session?.permissionMode, "plan");
    assert.equal(await readFile(join(home, "profiles.json"), "utf8"), before);
  });

  test("single stored login auto-fills the subscription slot", async () => {
    const result = await runCli(["init", "solo", "--name", "init-probe", "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    const filled = JSON.parse(result.stdout) as { subscriptionAccountId?: string };
    assert.equal(filled.subscriptionAccountId, "personal");
  });
});

describe("profile cwd template", () => {
  test("dry-run and show render the spawn directory", async () => {
    const [planned, shown] = await Promise.all([
      runCli(["cwdp", "--dry-run"]),
      runCli(["show", "cwdp"]),
    ]);
    assert.equal(planned.code, 0, planned.stderr);
    assert.equal(launchJson(planned.stdout).cwd, home);
    assert.equal(
      (JSON.parse(shown.stdout) as { launch: { cwd?: string } }).launch.cwd,
      home,
    );
  });

  test("launching into a missing directory fails before spawning", async () => {
    const result = await runCli(["cwdmissing"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Working directory .* is missing or not a directory/);
    assert.ok(!result.stdout.includes("GOOD-CLAUDE"), "the agent must never spawn");
  });

  test("profiles without cwd carry no cwd key (back-compat shape)", async () => {
    const result = await runCli(["dsub", "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!("cwd" in launchJson(result.stdout)));
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
    // Custom providers launch through the proxy by default too.
    assert.equal(plan.env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:8123/p/gw");
  });

  test("keeps the proxy profile tag readable", async () => {
    const result = await runCli(["prox", "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    const env = launchJson(result.stdout).env;
    assert.equal(env["ANTHROPIC_AUTH_TOKEN"], "swisscode-profile/prox");
    assert.equal(env["ANTHROPIC_BASE_URL"], "http://127.0.0.1:8123/p/prox");
  });

  test("dry-run shows ephemeral placeholders plus file contents, writing nothing", async () => {
    const result = await runCli(["sess", "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    const plan = JSON.parse(result.stdout) as { args: string[]; ephemeralFiles: { rel: string; content: string }[] };
    assert.ok(
      plan.args.some((a) => a.includes("__SWISSCODE_EPHEMERAL_DIR__")),
      "dry-run renders the placeholder, never a real path",
    );
    assert.ok(
      !plan.args.some((a) => a.startsWith("/tmp/") && a.endsWith(".json")),
      "dry-run must not leak a materialized path",
    );
    const settings = plan.ephemeralFiles.find((f) => f.rel === "settings.json");
    assert.ok(settings?.content.includes("fallbackModel"), "file contents are inspectable");
    // Flags still render in emission order alongside the placeholder.
    const settingsIdx = plan.args.indexOf("--settings");
    assert.ok(settingsIdx >= 0 && plan.args[settingsIdx + 1]?.includes("__SWISSCODE_EPHEMERAL_DIR__"));
    assert.deepEqual(
      plan.args.slice(0, settingsIdx),
      ["--permission-mode", "acceptEdits", "--allowedTools", "Read"],
    );
  });

  test("agentArgs appends after curated fields, so it wins conflicts", async () => {
    const result = await runCli(["sessover", "--dry-run"]);
    assert.equal(result.code, 0, result.stderr);
    const plan = JSON.parse(result.stdout) as { args: string[] };
    // Curated first, freeform tail: the last --permission-mode is the agent's.
    assert.deepEqual(plan.args.filter((a) => a === "--permission-mode"), [
      "--permission-mode",
      "--permission-mode",
    ]);
    assert.equal(plan.args[plan.args.length - 1], "plan");
    assert.equal(plan.args[plan.args.indexOf("--permission-mode") + 1], "acceptEdits");
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
    const result = await runCli(["dsub", "--", "--dry-run"]);
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
    const result = await runCli(["dsub"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /GOOD-CLAUDE/);
  });

  test("aborts with an actionable error when the proxy is down", async () => {
    const result = await runCli(["prox"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /swisscode proxy run/);
    assert.ok(!result.stdout.includes("GOOD-CLAUDE"), "never a silent direct fallback");
  });

  test("stages session files to real paths on a real launch", async () => {
    const result = await runCli(["sess"]);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.stdout.includes("__SWISSCODE_EPHEMERAL_DIR__"), "placeholder is resolved");
    const settingsArg = result.stdout.split(/\s+/).find((tok, i, toks) => toks[i - 1] === "--settings");
    assert.ok(settingsArg, "the agent receives a --settings path");
    const staged = JSON.parse(await readFile(settingsArg, "utf8")) as { fallbackModel?: string[] };
    assert.deepEqual(
      staged.fallbackModel,
      ["claude-sonnet-5"],
      "the staged settings carry the profile's session options",
    );
  });

  test("a real launch never creates or touches ~/.claude", async () => {
    // HOME is the temp harness home, so the real ~/.claude is never at risk;
    // this probe asserts the launch writes nothing to the user's own store.
    const result = await runCli(["sess"]);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(stat(join(home, ".claude")), "launch must not create ~/.claude");
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
    const result = await runCli(["dsub"], { FAKE_CLAUDE_SLEEP: "1" }, (child, stdoutSoFar) => {
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

describe("swisscode proxy run", () => {
  test("refuses a home with no accounts at all", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "swisscode-cli-empty-"));
    try {
      const result = await runCli(["proxy", "run"], { HOME: emptyHome, SWISSCODE_HOME: emptyHome });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /No accounts stored/);
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  test("starts for key-only users with a subscription notice", async () => {
    const keyHome = await mkdtemp(join(tmpdir(), "swisscode-cli-keys-"));
    try {
      await writeJson(join(keyHome, "accounts", "openrouter", "main.json"), {
        id: "main",
        providerId: "openrouter",
        label: "Main",
        config: { apiKey: OPENROUTER_KEY },
        createdAt: NOW,
        updatedAt: NOW,
      });
      const result = await runCli(
        ["proxy", "run", "--port", "18347", "--no-traffic-log"],
        { HOME: keyHome, SWISSCODE_HOME: keyHome },
        (child, stdoutSoFar) => {
          const poll = setInterval(() => {
            if (!stdoutSoFar().includes("key account(s)")) return;
            clearInterval(poll);
            child.kill("SIGTERM");
          }, 20);
          child.on("close", () => clearInterval(poll));
        },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /1 key account\(s\)/);
      assert.match(result.stdout, /No subscription accounts/);
    } finally {
      await rm(keyHome, { recursive: true, force: true });
    }
  });

  test("opens the queryable store by default", async () => {
    const keyHome = await mkdtemp(join(tmpdir(), "swisscode-cli-store-"));
    try {
      await writeJson(join(keyHome, "accounts", "openrouter", "main.json"), {
        id: "main",
        providerId: "openrouter",
        label: "Main",
        config: { apiKey: OPENROUTER_KEY },
        createdAt: NOW,
        updatedAt: NOW,
      });
      const result = await runCli(
        ["proxy", "run", "--port", "18348"],
        { HOME: keyHome, SWISSCODE_HOME: keyHome },
        (child, stdoutSoFar) => {
          const poll = setInterval(() => {
            if (!stdoutSoFar().includes("key account(s)")) return;
            clearInterval(poll);
            child.kill("SIGTERM");
          }, 20);
          child.on("close", () => clearInterval(poll));
        },
      );
      assert.equal(result.code, 0, result.stderr);
      // The store file exists before any traffic flows — report is ready.
      await readFile(join(keyHome, "proxy-traffic.sqlite"));
    } finally {
      await rm(keyHome, { recursive: true, force: true });
    }
  });
});

describe("swisscode web", () => {
  // A fake web root: the CLI spawns `node server.mjs` with cwd here, so the
  // stub only needs to record its env and sleep. The real UI is never
  // spawned in tests — no vite build, no node_modules, no real UI port. The
  // stub reports via a file because its stdout is inherited, not piped back
  // to the CLI parent the harness captures.
  async function stubWebRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "swisscode-cli-webroot-"));
    await writeFile(
      join(dir, "server.mjs"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("stub-env.json", JSON.stringify({ port: process.env["PORT"], proxy: process.env["SWISSCODE_PROXY_PORT"] }));\nsetInterval(() => {}, 1000);\n',
      "utf8",
    );
    await mkdir(join(dir, "dist", "server"), { recursive: true });
    await writeFile(join(dir, "dist", "server", "server.js"), "export {};\n", "utf8");
    return dir;
  }

  /** The stub's readiness signal: its env file exists, so it booted with our env. */
  function stubEnvPath(root: string): string {
    return join(root, "stub-env.json");
  }

  /** SIGTERM the CLI once the stub UI has booted (env file present). */
  function killOnStubBoot(child: ChildProcess, root: string): void {
    const poll = setInterval(() => {
      void stat(stubEnvPath(root)).then(
        () => {
          clearInterval(poll);
          child.kill("SIGTERM");
        },
        () => {},
      );
    }, 20);
    child.on("close", () => clearInterval(poll));
  }

  async function readStubEnv(root: string): Promise<{ port: string; proxy: string }> {
    return JSON.parse(await readFile(stubEnvPath(root), "utf8")) as { port: string; proxy: string };
  }

  async function keyHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "swisscode-cli-web-"));
    await writeJson(join(dir, "accounts", "openrouter", "main.json"), {
      id: "main",
      providerId: "openrouter",
      label: "Main",
      config: { apiKey: OPENROUTER_KEY },
      createdAt: NOW,
      updatedAt: NOW,
    });
    return dir;
  }

  test("names the fix when the built UI is missing", async () => {
    const empty = await mkdtemp(join(tmpdir(), "swisscode-cli-noroot-"));
    try {
      const result = await runCli(["web"], { SWISSCODE_WEB_ROOT: empty });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /SWISSCODE_WEB_ROOT/);
      assert.match(result.stderr, /npm run build -w @swisscode\/web/);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  test("rejects a non-numeric UI port", async () => {
    const root = await stubWebRoot();
    try {
      const result = await runCli(["web", "--port", "abc"], { SWISSCODE_WEB_ROOT: root });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /Invalid --port/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("starts the proxy and UI, stops both on SIGTERM", async () => {
    const dir = await keyHome();
    const root = await stubWebRoot();
    try {
      const result = await runCli(
        ["web", "--port", "3131", "--proxy-port", "18349", "--no-traffic-log"],
        { HOME: dir, SWISSCODE_HOME: dir, SWISSCODE_WEB_ROOT: root },
        (child) => killOnStubBoot(child, root),
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Subscription proxy on http:\/\/127\.0\.0\.1:18349/);
      assert.match(result.stdout, /Web UI on http:\/\/127\.0\.0\.1:3131/);
      assert.deepEqual(await readStubEnv(root), { port: "3131", proxy: "18349" });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test("defaults the UI port to 8124, off Docker's 3000", async () => {
    const root = await stubWebRoot();
    try {
      // Nothing listens here: the stub records env without binding, and the
      // CLI never binds the UI port itself — so this is collision-free.
      const result = await runCli(["web", "--no-proxy"], { SWISSCODE_WEB_ROOT: root }, (child) =>
        killOnStubBoot(child, root),
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Web UI on http:\/\/127\.0\.0\.1:8124/);
      assert.equal((await readStubEnv(root)).port, "8124");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--no-proxy runs the UI without touching the proxy", async () => {
    const root = await stubWebRoot();
    try {
      const result = await runCli(
        ["web", "--port", "3132", "--no-proxy"],
        { SWISSCODE_WEB_ROOT: root },
        (child) => killOnStubBoot(child, root),
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Proxy disabled/);
      assert.equal((await readStubEnv(root)).port, "3132");
      assert.ok(!result.stdout.includes("Subscription proxy"), "no proxy is started");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reuses a live proxy instead of starting a second one", async () => {
    const dir = await keyHome();
    const root = await stubWebRoot();
    // A real proxy in the background, on its own port and home.
    const proxyChild = spawn(process.execPath, [CLI, "proxy", "run", "--port", "18350", "--no-traffic-log"], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", HOME: dir, SWISSCODE_HOME: dir },
    });
    let proxyOut = "";
    proxyChild.stdout?.setEncoding("utf8");
    proxyChild.stdout?.on("data", (chunk: string) => {
      proxyOut += chunk;
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const poll = setInterval(() => {
          if (!proxyOut.includes("key account(s)")) return;
          clearInterval(poll);
          resolve();
        }, 20);
        setTimeout(() => {
          clearInterval(poll);
          reject(new Error("proxy did not start"));
        }, 15_000);
      });
      const result = await runCli(
        ["web", "--port", "3133", "--proxy-port", "18350"],
        { HOME: dir, SWISSCODE_HOME: dir, SWISSCODE_WEB_ROOT: root },
        (child) => killOnStubBoot(child, root),
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Reusing running proxy on http:\/\/127\.0\.0\.1:18350/);
      assert.ok(!result.stdout.includes("Subscription proxy on"), "the owned proxy never starts");
      assert.deepEqual(await readStubEnv(root), { port: "3133", proxy: "18350" });
    } finally {
      if (proxyChild.pid) process.kill(-proxyChild.pid, "SIGKILL");
      await rm(dir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("swisscode proxy log/report", () => {
  let trafficSeq = 0;
  function trafficEntry(overrides: Partial<ProxyTrafficEntry> = {}): ProxyTrafficEntry {
    trafficSeq += 1;
    return {
      id: `cli-t-${trafficSeq}`,
      ts: `2026-01-${String(10 + trafficSeq).padStart(2, "0")}T10:00:00.000Z`,
      method: "POST",
      path: "/v1/messages",
      status: 200,
      ms: 100,
      accountId: "vault-a",
      reqBytes: 12,
      resBytes: 34,
      attempts: [{ accountId: "vault-a", status: 200 }],
      ...overrides,
    };
  }

  async function logHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "swisscode-cli-log-"));
    trafficSeq = 0; // fixed dates, so --since assertions hold every run
    const lines = [
      trafficEntry({ profile: "work", route: "opus", request: { model: "opus" } }),
      trafficEntry({ profile: "home", route: "codex", status: 429 }),
      trafficEntry({ profile: "work", route: "opus", error: "client hung up" }),
      trafficEntry({ profile: undefined, route: undefined, accountId: null }),
    ];
    await writeFile(join(dir, "proxy-traffic.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return dir;
  }

  test("log tails the firehose unfiltered", async () => {
    const dir = await logHome();
    try {
      const result = await runCli(["proxy", "log"], { HOME: dir, SWISSCODE_HOME: dir });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout.trim().split("\n").length, 4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("log filters share the core predicate", async () => {
    const dir = await logHome();
    try {
      const lines = async (args: string[]) =>
        (await runCli(["proxy", "log", ...args], { HOME: dir, SWISSCODE_HOME: dir })).stdout.trim().split("\n");
      assert.equal((await lines(["--profile", "work"])).length, 2);
      assert.equal((await lines(["--route", "opus"])).length, 2);
      assert.equal((await lines(["--errors"])).length, 2);
      assert.equal((await lines(["--since", "2026-01-13T00:00:00.000Z"])).length, 2);
      assert.match((await lines(["--profile", "nobody"])).join("\n"), /no matching requests/);
      const tail = await lines(["--profile", "work", "--tail", "1"]);
      assert.equal(tail.length, 1);
      assert.match(tail[0] ?? "", /err=client hung up/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function reportHome(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "swisscode-cli-report-"));
    trafficSeq = 0;
    // Hours ago, not fixed dates: --days windows must hold whatever today is.
    const hour = 3_600_000;
    const now = Date.now();
    // The day grain buckets UTC dates, so the four hourly seeds must share
    // one: in the first hours after UTC midnight the trailing seeds fall on
    // yesterday and the "one row" assertion flakes. Backing the whole set off
    // intact keeps every --days window below holding.
    const newest = now - hour;
    const anchor =
      new Date(newest).toISOString().slice(0, 10) ===
      new Date(newest - 3 * hour).toISOString().slice(0, 10)
        ? now
        : now - 4 * hour;
    const store = await openTrafficStore(join(dir, "proxy-traffic.sqlite"));
    try {
      const seeds: Array<Partial<ProxyTrafficEntry>> = [
        { ts: new Date(anchor - 4 * hour).toISOString(), profile: "work", route: "opus", ms: 100, request: { approxInputTokens: 10 } },
        { ts: new Date(anchor - 3 * hour).toISOString(), profile: "work", route: "opus", ms: 200, status: 429, request: { approxInputTokens: 20 } },
        { ts: new Date(anchor - 2 * hour).toISOString(), profile: "home", route: "codex", ms: 300, request: { approxInputTokens: 30 } },
        { ts: new Date(anchor - 1 * hour).toISOString(), profile: "work", route: "opus", ms: 400, error: "client hung up", request: { approxInputTokens: 40 } },
      ];
      for (const seed of seeds) await store.append(toStoredExchange(trafficEntry(seed)));
    } finally {
      store.close();
    }
    return dir;
  }

  test("report rolls up the store by grain", async () => {
    const dir = await reportHome();
    try {
      const env = { HOME: dir, SWISSCODE_HOME: dir };
      const byProfile = await runCli(["proxy", "report", "--by", "profile"], env);
      assert.equal(byProfile.code, 0, byProfile.stderr);
      assert.match(byProfile.stdout, /key\trequests\terrors\terr%\tp50ms\tp95ms\tin-tok\tout-tok/);
      assert.match(byProfile.stdout, /work\t3\t2\t66\.7\t200\t400\t70\t0/);
      assert.match(byProfile.stdout, /home\t1\t0\t0\.0\t300\t300\t30\t0/);

      const workRoutes = await runCli(["proxy", "report", "--profile", "work", "--by", "route"], env);
      assert.equal(workRoutes.code, 0, workRoutes.stderr);
      assert.match(workRoutes.stdout, /opus\t3\t2\t66\.7\t200\t400\t70\t0/);

      const recent = await runCli(["proxy", "report", "--days", "1"], env);
      assert.equal(recent.code, 0, recent.stderr);
      // Default grain is day: one row covering all four seeds.
      assert.match(recent.stdout, /\t4\t2\t50\.0\t200\t400\t100\t0/);
      const none = await runCli(["proxy", "report", "--days", "0"], env);
      assert.match(none.stdout, /no traffic recorded for this selection yet/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("report prices spend, suggests, and caveats estimates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swisscode-cli-spend-"));
    try {
      const store = await openTrafficStore(join(dir, "proxy-traffic.sqlite"));
      try {
        const now = Date.now();
        for (const [i, ms] of [100, 200].entries()) {
          await store.append(
            toStoredExchange(
              trafficEntry({
                ts: new Date(now - (2 - i) * 3_600_000).toISOString(),
                profile: "work",
                route: "opus",
                ms,
                request: { model: "claude-haiku-4-5", approxInputTokens: 1_000_000 },
              }),
            ),
          );
        }
      } finally {
        store.close();
      }
      const env = { HOME: dir, SWISSCODE_HOME: dir };
      const result = await runCli(["proxy", "report", "--by", "route", "--days", "1"], env);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /est-spend/);
      // 2M Haiku input tokens ≈ $2.00.
      assert.match(result.stdout, /opus\t2\t0\t0\.0\t100\t200\t2000000\t0\t\$2\.00/);
      assert.match(result.stdout, /`opus` burned ≈\$2\.00 last 1 day/);
      assert.match(result.stdout, /Estimated spend, not a bill/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("show carries a spend summary with suggestions for the profile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swisscode-cli-showspend-"));
    try {
      await writeJson(join(dir, "profiles.json"), [
        {
          name: "work",
          agentId: "claude-code",
          providerId: "claude-subscription",
          modelRoutes: [
            { match: "opus", kind: "subscription", subscriptionAccountId: "personal" },
            { match: "sonnet", kind: "subscription", subscriptionAccountId: "personal" },
          ],
        },
      ]);
      const store = await openTrafficStore(join(dir, "proxy-traffic.sqlite"));
      try {
        await store.append(
          toStoredExchange(
            trafficEntry({
              profile: "work",
              route: "opus",
              request: { model: "claude-haiku-4-5", approxInputTokens: 1_000_000 },
            }),
          ),
        );
      } finally {
        store.close();
      }
      const env = { HOME: dir, SWISSCODE_HOME: dir };
      const result = await runCli(["show", "work"], env);
      assert.equal(result.code, 0, result.stderr);
      const shown = JSON.parse(result.stdout) as {
        spend: { requests: number; estSpendUsd: number; estSpend: string; note: string } | null;
        suggestions: string[];
      };
      assert.equal(shown.spend?.requests, 1);
      assert.equal(shown.spend?.estSpendUsd, 1);
      assert.equal(shown.spend?.estSpend, "$1.00");
      assert.match(shown.spend?.note ?? "", /not a bill/);
      // The opus route burned spend; the sonnet route never fired.
      assert.ok(shown.suggestions.some((s) => s.includes("`opus` burned")));
      assert.ok(shown.suggestions.some((s) => s.includes("`sonnet` saw no traffic")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("show degrades to null spend when the proxy never ran", async () => {
    const result = await runCli(["show", "sub"]);
    assert.equal(result.code, 0, result.stderr);
    const shown = JSON.parse(result.stdout) as { spend: unknown; suggestions: unknown };
    assert.equal(shown.spend, null);
    assert.deepEqual(shown.suggestions, []);
  });

  test("report without a store explains itself", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swisscode-cli-nostore-"));
    try {
      const result = await runCli(["proxy", "report"], { HOME: dir, SWISSCODE_HOME: dir });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /No queryable traffic store/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

  test("probes for both the native binary and the node-launched CLI", async () => {
    const recorded = (await readFile(join(home, "pgrep-args"), "utf8"))
      .split("\n")
      .filter((line) => line.trim() !== "");
    // Exactly the adapters-side probe set, so the CLI warning and the web UI's
    // count can never look at different process lists.
    assert.deepEqual(recorded, ["-x claude", "-f claude-code/cli\\.js"]);
    // `pgrep -x claude` alone misses the common npm install, which runs as
    // `node …/@anthropic-ai/claude-code/cli.js`.
    const nodeCli = new RegExp("claude-code/cli\\.js");
    assert.ok(
      nodeCli.test("node /opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js"),
      "npm install running as node",
    );
    assert.ok(!nodeCli.test("/home/me/.claude/statusline.sh"), "unrelated ~/.claude tooling");
  });
});
