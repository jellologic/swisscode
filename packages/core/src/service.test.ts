import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OAuthError,
  ensureFreshCredential,
  resolveLaunchSpec,
  resolveProviderConfig,
  type AccountRepository,
  type AgentRegistry,
  type OAuthClient,
  type OAuthCredential,
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

describe("ensureFreshCredential onInvalidGrant", () => {
  const expired = (refreshToken: string): OAuthCredential => ({
    accessToken: "old-access",
    refreshToken,
    expiresAt: Date.now() - 1000,
  });

  function stubAccounts(cred: OAuthCredential | undefined) {
    let saved: OAuthCredential | undefined;
    const accounts: AccountRepository = {
      list: async () => [],
      get: async () => undefined,
      save: async () => {},
      loadCredential: async () => cred,
      saveCredential: async (_id: string, next: OAuthCredential) => {
        saved = next;
      },
      remove: async () => false,
    };
    return { accounts, saved: () => saved };
  }

  const invalidGrant = () => new OAuthError("invalid_grant", "rejected");
  const transient = () => new OAuthError("transient", "blip");

  it("adopts and persists the hook credential on invalid_grant", async () => {
    const { accounts, saved } = stubAccounts(expired("dead-r"));
    const oauth: OAuthClient = { refresh: async () => { throw invalidGrant(); } };
    const adopted: OAuthCredential = {
      accessToken: "live-access",
      refreshToken: "live-r",
      expiresAt: Date.now() + 3600_000,
    };
    let hookCalls = 0;
    const out = await ensureFreshCredential(accounts, oauth, "main", {
      onInvalidGrant: async (id: string) => {
        hookCalls += 1;
        assert.equal(id, "main");
        return adopted;
      },
    });
    assert.equal(hookCalls, 1);
    assert.deepEqual(out, { credential: adopted, refreshed: true });
    assert.deepEqual(saved(), adopted);
  });

  it("rethrows when the hook has nothing newer", async () => {
    const { accounts } = stubAccounts(expired("dead-r"));
    const oauth: OAuthClient = { refresh: async () => { throw invalidGrant(); } };
    await assert.rejects(
      ensureFreshCredential(accounts, oauth, "main", { onInvalidGrant: async () => undefined }),
      /rejected/,
    );
  });

  it("never calls the hook for transient failures or fresh credentials", async () => {
    const { accounts } = stubAccounts(expired("dead-r"));
    const transientOauth: OAuthClient = { refresh: async () => { throw transient(); } };
    let calls = 0;
    const hook = async () => {
      calls += 1;
      return undefined;
    };
    await assert.rejects(ensureFreshCredential(accounts, transientOauth, "main", { onInvalidGrant: hook }), /blip/);
    assert.equal(calls, 0);

    const fresh: OAuthCredential = { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3600_000 };
    const { accounts: freshAccounts } = stubAccounts(fresh);
    const out = await ensureFreshCredential(freshAccounts, transientOauth, "main", { onInvalidGrant: hook });
    assert.deepEqual(out, { credential: fresh, refreshed: false });
    assert.equal(calls, 0);
  });
});

describe("validateProfile useProxy", () => {
  const base = {
    name: "x",
    agentId: "claude-code",
    providerId: "claude-subscription",
  };
  it("rejects useProxy without a subscription account", async () => {
    const { validateProfile } = await import("./index.js");
    assert.throws(
      () => validateProfile({ ...base, useProxy: true }),
      /has no subscriptionAccountId/,
    );
  });
  it("accepts useProxy with a subscription account, and proxy-off without one", async () => {
    const { validateProfile } = await import("./index.js");
    validateProfile({ ...base, useProxy: true, subscriptionAccountId: "main" });
    validateProfile({ ...base });
  });
});
