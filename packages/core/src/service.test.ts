import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveLaunchSpec,
  resolveProviderConfig,
  type AgentRegistry,
  type Profile,
  type ProviderRegistry,
} from "./index.js";
import type { LaunchSpec } from "./domain.js";

const agents: AgentRegistry = {
  get: (id: string) =>
    id === "claude-code"
      ? {
          id: "claude-code",
          displayName: "Claude Code",
          description: "",
          command: "claude",
          defaultArgs: [],
          buildLaunch: (profile: Profile, env: Record<string, string>): LaunchSpec => ({
            command: "claude",
            args: [...(profile.agentArgs ?? [])],
            env: { ...env },
          }),
        }
      : undefined,
  list: () => [],
};

const providers: ProviderRegistry = {
  get: (id: string) =>
    id === "openrouter"
      ? {
          id: "openrouter",
          displayName: "OpenRouter",
          description: "",
          fields: [{ key: "apiKey", label: "API Key", secret: true, required: true }],
          accountCapabilities: { importActive: false, usageMetrics: false, switchVia: [] },
          buildEnv: (config) => ({
            ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
            ANTHROPIC_AUTH_TOKEN: config?.["apiKey"] ?? "",
          }),
        }
      : undefined,
  list: () => [],
};

describe("resolveLaunchSpec", () => {
  it("merges provider env into the agent launch", () => {
    const spec = resolveLaunchSpec(agents, providers, {
      name: "fast",
      agentId: "claude-code",
      providerId: "openrouter",
      providerConfig: { apiKey: "sk-or-test" },
      agentArgs: ["--dangerously-skip-permissions"],
    });
    assert.equal(spec.command, "claude");
    assert.deepEqual(spec.args, ["--dangerously-skip-permissions"]);
    assert.equal(spec.env["ANTHROPIC_AUTH_TOKEN"], "sk-or-test");
  });

  it("rejects unknown provider", () => {
    assert.throws(() =>
      resolveLaunchSpec(agents, providers, {
        name: "x",
        agentId: "claude-code",
        providerId: "nope",
      }),
    );
  });

  it("rejects missing required provider config", () => {
    assert.throws(() =>
      resolveLaunchSpec(agents, providers, {
        name: "x",
        agentId: "claude-code",
        providerId: "openrouter",
        providerConfig: {},
      }),
    );
  });

  it("merges a stored provider account under inline config", () => {
    const get = (providerId: string, id: string) =>
      providerId === "openrouter" && id === "work"
        ? {
            id: "work",
            providerId: "openrouter",
            label: "Work",
            config: { apiKey: "stored-key", model: "stored-model" },
            createdAt: "",
            updatedAt: "",
          }
        : undefined;
    const merged = resolveProviderConfig(
      {
        name: "x",
        agentId: "claude-code",
        providerId: "openrouter",
        providerAccountId: "work",
        providerConfig: { model: "inline-model" },
      },
      get,
    );
    assert.deepEqual(merged.providerConfig, { apiKey: "stored-key", model: "inline-model" });
    assert.throws(() =>
      resolveProviderConfig(
        { name: "x", agentId: "claude-code", providerId: "openrouter", providerAccountId: "nope" },
        get,
      ),
    );
  });
});
