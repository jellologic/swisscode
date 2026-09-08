import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EPHEMERAL_DIR_TOKEN,
  ProfileError,
  buildClaudeFlags,
  buildClaudeSettings,
  profileShapeProblem,
  resolveEphemeralPaths,
  sessionEphemeralFiles,
  validateProfile,
  validateSessionOptions,
  type ClaudeSessionOptions,
  type Profile,
} from "./index.js";

function baseProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    name: "work",
    agentId: "claude-code",
    providerId: "claude-subscription",
    subscriptionAccountId: "vault-a",
    ...overrides,
  };
}

const fullSession: ClaudeSessionOptions = {
  effort: "high",
  permissionMode: "plan",
  allowedTools: ["Bash(npm test:*)", "Read"],
  disallowedTools: ["Bash(rm:*)"],
  tools: "Bash,Edit,Read",
  addDirs: ["/repo/a", "/repo/b"],
  systemPrompt: "Be terse.",
  appendSystemPrompt: "Prefer rg.",
  agent: "reviewer",
  mcpConfig: "/etc/mcp.json",
  strictMcp: true,
  settingSources: ["project", "local"],
  fallbackModel: ["claude-sonnet-5"],
  claudeSettings: { outputStyle: "concise" },
};

describe("buildClaudeFlags", () => {
  it("returns no flags for an empty session", () => {
    assert.deepEqual(buildClaudeFlags({}), []);
  });

  it("emits flags in stable curated order", () => {
    assert.deepEqual(buildClaudeFlags(fullSession), [
      "--effort",
      "high",
      "--permission-mode",
      "plan",
      "--allowedTools",
      "Bash(npm test:*)",
      "--allowedTools",
      "Read",
      "--disallowedTools",
      "Bash(rm:*)",
      "--tools",
      "Bash,Edit,Read",
      "--add-dir",
      "/repo/a",
      "--add-dir",
      "/repo/b",
      "--system-prompt",
      "Be terse.",
      "--append-system-prompt",
      "Prefer rg.",
      "--agent",
      "reviewer",
      "--mcp-config",
      "/etc/mcp.json",
      "--strict-mcp-config",
      "--setting-sources",
      "project,local",
      "--settings",
      `${EPHEMERAL_DIR_TOKEN}/settings.json`,
    ]);
  });

  it('emits --tools even when "" (disabling every tool is meaningful)', () => {
    assert.deepEqual(buildClaudeFlags({ tools: "" }), ["--tools", ""]);
  });

  it("points --mcp-config at the ephemeral file for inline JSON", () => {
    const flags = buildClaudeFlags({ mcpConfig: '{"mcpServers":{}}' });
    assert.deepEqual(flags, ["--mcp-config", `${EPHEMERAL_DIR_TOKEN}/mcp.json`]);
  });

  it("never emits print-only upstream flags", () => {
    // fallbackModel travels as a settings key, not --fallback-model.
    const flags = buildClaudeFlags({ fallbackModel: ["m"] });
    assert.ok(!flags.includes("--fallback-model"));
    assert.ok(!flags.some((f) => f.includes("budget")));
  });

  it("omits --settings when the session contributes no settings", () => {
    assert.deepEqual(buildClaudeFlags({ effort: "low" }), ["--effort", "low"]);
  });
});

describe("buildClaudeSettings", () => {
  it("returns {} for an empty session", () => {
    assert.deepEqual(buildClaudeSettings({}), {});
  });

  it("merges curated fields OVER claudeSettings on conflict", () => {
    const settings = buildClaudeSettings({
      fallbackModel: ["curated"],
      claudeSettings: { fallbackModel: ["typo"], outputStyle: "concise" },
    });
    assert.deepEqual(settings, { fallbackModel: ["curated"], outputStyle: "concise" });
  });

  it("strips code-loading names from settings.env", () => {
    const settings = buildClaudeSettings({
      claudeSettings: {
        env: { FOO: "1", PATH: "/evil", NODE_OPTIONS: "--inspect", LD_PRELOAD: "x" },
      },
    });
    assert.deepEqual(settings, { env: { FOO: "1" } });
  });

  it("leaves a non-record settings.env alone (Claude's problem, not ours)", () => {
    const settings = buildClaudeSettings({ claudeSettings: { env: ["FOO=1"] } });
    assert.deepEqual(settings, { env: ["FOO=1"] });
  });
});

describe("sessionEphemeralFiles", () => {
  it("returns no descriptors for an empty session", () => {
    assert.deepEqual(sessionEphemeralFiles({}), []);
  });

  it("attaches 0600 settings + mcp descriptors", () => {
    const files = sessionEphemeralFiles({
      ...fullSession,
      mcpConfig: '{\n"mcpServers": {}\n}',
    });
    assert.equal(files.length, 2);
    assert.equal(files[0]?.rel, "settings.json");
    assert.equal(files[0]?.mode, 0o600);
    assert.deepEqual(JSON.parse(files[0]?.content ?? ""), {
      outputStyle: "concise",
      fallbackModel: ["claude-sonnet-5"],
    });
    assert.equal(files[1]?.rel, "mcp.json");
    assert.equal(files[1]?.mode, 0o600);
    assert.equal(files[1]?.content, '{\n"mcpServers": {}\n}');
  });
});

describe("resolveEphemeralPaths", () => {
  it("rewrites the token to the real dir", () => {
    assert.deepEqual(
      resolveEphemeralPaths(
        ["--settings", `${EPHEMERAL_DIR_TOKEN}/settings.json`, "--effort", "low"],
        "/tmp/swiss-abc",
      ),
      ["--settings", "/tmp/swiss-abc/settings.json", "--effort", "low"],
    );
  });
});

describe("validateSessionOptions", () => {
  it("accepts empty and full sessions", () => {
    validateSessionOptions(baseProfile());
    validateSessionOptions(baseProfile({ session: {} }));
    validateSessionOptions(baseProfile({ session: fullSession }));
    validateSessionOptions(baseProfile({ session: { tools: "" } }));
  });

  it("rejects bad enum values", () => {
    assert.throws(
      () => validateSessionOptions(baseProfile({ session: { effort: "auto" } })),
      ProfileError,
    );
    assert.throws(
      () => validateSessionOptions(baseProfile({ session: { effort: "HIGH" } })),
      ProfileError,
    );
    assert.throws(
      () => validateSessionOptions(baseProfile({ session: { permissionMode: "yes" } })),
      ProfileError,
    );
  });

  it("rejects blank list entries and blank strings (except tools)", () => {
    assert.throws(
      () => validateSessionOptions(baseProfile({ session: { allowedTools: ["Read", "  "] } })),
      ProfileError,
    );
    assert.throws(
      () => validateSessionOptions(baseProfile({ session: { systemPrompt: " " } })),
      ProfileError,
    );
    assert.throws(
      () => validateSessionOptions(baseProfile({ session: { mcpConfig: "" } })),
      ProfileError,
    );
    assert.throws(
      () => validateSessionOptions(baseProfile({ session: { fallbackModel: [] } as ClaudeSessionOptions })),
      ProfileError,
    );
  });

  it("rejects bad settingSources", () => {
    assert.throws(
      () => validateSessionOptions(baseProfile({ session: { settingSources: [] } })),
      ProfileError,
    );
    assert.throws(
      () =>
        validateSessionOptions(
          baseProfile({ session: { settingSources: ["project", "managed"] } }),
        ),
      ProfileError,
    );
  });

  it("rejects inline mcpConfig that does not parse", () => {
    assert.throws(
      () => validateSessionOptions(baseProfile({ session: { mcpConfig: '{"broken"' } })),
      /does not parse/,
    );
    // A plain path is never parsed.
    validateSessionOptions(baseProfile({ session: { mcpConfig: "./mcp.json" } }));
  });

  it("runs inside validateProfile", () => {
    assert.throws(
      () => validateProfile(baseProfile({ session: { effort: "turbo" } })),
      ProfileError,
    );
    validateProfile(baseProfile({ session: { effort: "max", permissionMode: "plan" } }));
  });
});

describe("profile shape with session", () => {
  it("accepts a session object", () => {
    assert.equal(profileShapeProblem(baseProfile({ session: fullSession })), undefined);
  });

  it("rejects mistyped session fields (never throws)", () => {
    assert.match(
      String(profileShapeProblem(baseProfile({ session: "plan" as unknown as ClaudeSessionOptions }))),
      /profile\.session must be an object/,
    );
    assert.match(
      String(
        profileShapeProblem(baseProfile({ session: { effort: 42 } as unknown as ClaudeSessionOptions })),
      ),
      /profile\.session must be an object/,
    );
    assert.match(
      String(
        profileShapeProblem(
          baseProfile({ session: { strictMcp: "yes" } as unknown as ClaudeSessionOptions }),
        ),
      ),
      /profile\.session must be an object/,
    );
    assert.match(
      String(
        profileShapeProblem(
          baseProfile({ session: { claudeSettings: [] } as unknown as ClaudeSessionOptions }),
        ),
      ),
      /profile\.session must be an object/,
    );
  });
});
