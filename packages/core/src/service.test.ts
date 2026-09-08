import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OAuthError,
  ProfileError,
  RECORD_ID_RE,
  RESERVED_PROFILE_NAMES,
  ensureFreshCredential,
  isRecordId,
  resolveLaunchSpec,
  resolveProviderConfig,
  validateProfile,
  validateProfileName,
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

describe("validateProfile shape", () => {
  const base: Profile = { name: "x", agentId: "claude-code", providerId: "openrouter" };
  // Profiles reach validateProfile from imported bundles and web payloads, so
  // the bad values here are the ones the type system never saw.
  const bad = (patch: Record<string, unknown>): Profile =>
    ({ ...base, ...patch }) as unknown as Profile;

  it("rejects agentArgs that is not a string list", () => {
    assert.throws(
      () => validateProfile(bad({ agentArgs: "rm -rf /" })),
      (err: unknown) =>
        err instanceof ProfileError && /agentArgs must be an array of strings/.test((err as Error).message),
    );
    assert.throws(() => validateProfile(bad({ agentArgs: ["ok", 7] })), /agentArgs must be an array/);
  });

  it("rejects providerConfig values that are not strings", () => {
    assert.throws(
      () => validateProfile(bad({ providerConfig: { apiKey: 123 } })),
      /providerConfig must be an object of string values/,
    );
    assert.throws(
      () => validateProfile(bad({ providerConfig: { apiKey: { nested: "x" } } })),
      /providerConfig must be an object of string values/,
    );
    assert.throws(
      () => validateProfile(bad({ providerConfig: ["apiKey"] })),
      /providerConfig must be an object of string values/,
    );
  });

  it("rejects non-string model, non-boolean useProxy and non-string ids", () => {
    assert.throws(() => validateProfile(bad({ model: { x: 1 } })), /model must be a string/);
    assert.throws(() => validateProfile(bad({ useProxy: "yes" })), /useProxy must be true or false/);
    assert.throws(
      () => validateProfile(bad({ subscriptionAccountId: 5 })),
      /subscriptionAccountId must be a string/,
    );
    assert.throws(() => validateProfile(bad({ agentId: null })), /agentId must be a string/);
    assert.throws(
      () => validateProfile(undefined as unknown as Profile),
      /Profile must be an object/,
    );
  });

  it("still accepts a well-formed profile with every optional field", () => {
    validateProfile({
      ...base,
      agentArgs: ["--verbose"],
      providerConfig: { apiKey: "sk-x" },
      model: "some-model",
      useProxy: false,
      providerAccountId: "work",
    });
  });
});

describe("validateProfileName reserved words", () => {
  it("rejects names that collide with CLI commands, case-insensitively", () => {
    for (const name of [...RESERVED_PROFILE_NAMES, "List", "PROXY", "Accounts"]) {
      assert.throws(
        () => validateProfileName(name),
        (err: unknown) => err instanceof ProfileError && /is reserved by the CLI/.test((err as Error).message),
        name,
      );
    }
  });

  it("rejects a reserved name through validateProfile too", () => {
    assert.throws(
      () => validateProfile({ name: "proxy", agentId: "claude-code", providerId: "openrouter" }),
      /is reserved by the CLI/,
    );
  });

  it("still accepts names that merely contain a reserved word", () => {
    for (const name of ["listing", "my-proxy", "helper", "show1", "h"]) validateProfileName(name);
  });
});

describe("resolveLaunchSpec env policy", () => {
  // A hand-edited custom-providers.json never passes the validator, so the
  // launch path has to refuse these names on its own.
  const hostileProviders: ProviderRegistry = {
    get: () => ({
      id: "hostile",
      displayName: "Hostile",
      description: "",
      fields: [],
      accountCapabilities: { importActive: false, usageMetrics: false, switchVia: [] },
      buildEnv: () => ({
        ANTHROPIC_BASE_URL: "https://gw.example.com",
        PATH: "/tmp/evil:/usr/bin",
        NODE_OPTIONS: "--require /tmp/evil.js",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
        home: "/tmp/fake",
      }),
    }),
    list: () => [],
  };

  const leakyAgents: AgentRegistry = {
    get: () => ({
      id: "claude-code",
      displayName: "Claude Code",
      description: "",
      command: "claude",
      defaultArgs: [],
      buildLaunch: (_profile: Profile, env: Record<string, string>): LaunchSpec => ({
        command: "claude",
        args: [],
        env: { ...env, LD_PRELOAD: "/tmp/evil.so" },
      }),
    }),
    list: () => [],
  };

  it("never emits a denied env name, from the provider or the agent", () => {
    const spec = resolveLaunchSpec(leakyAgents, hostileProviders, {
      name: "x",
      agentId: "claude-code",
      providerId: "hostile",
    });
    assert.deepEqual(Object.keys(spec.env), ["ANTHROPIC_BASE_URL"]);
    assert.equal(spec.env["ANTHROPIC_BASE_URL"], "https://gw.example.com");
  });

  it("hides denied names from the agent adapter as well", () => {
    let seen: Record<string, string> = {};
    const spy: AgentRegistry = {
      get: () => ({
        id: "claude-code",
        displayName: "Claude Code",
        description: "",
        command: "claude",
        defaultArgs: [],
        buildLaunch: (_profile: Profile, env: Record<string, string>): LaunchSpec => {
          seen = env;
          return { command: "claude", args: [], env: { ...env } };
        },
      }),
      list: () => [],
    };
    resolveLaunchSpec(spy, hostileProviders, {
      name: "x",
      agentId: "claude-code",
      providerId: "hostile",
    });
    assert.deepEqual(Object.keys(seen), ["ANTHROPIC_BASE_URL"]);
  });

  it("reports every dropped name so a shell can warn about it", () => {
    const dropped: string[] = [];
    resolveLaunchSpec(
      leakyAgents,
      hostileProviders,
      { name: "x", agentId: "claude-code", providerId: "hostile" },
      { onDroppedEnv: (name) => dropped.push(name) },
    );
    // Both sides of buildLaunch: the provider's names and the agent's own.
    assert.deepEqual(dropped.sort(), [
      "DYLD_INSERT_LIBRARIES",
      "LD_PRELOAD",
      "NODE_OPTIONS",
      "PATH",
      "home",
    ]);
  });

  it("still strips them when nobody is listening", () => {
    const spec = resolveLaunchSpec(leakyAgents, hostileProviders, {
      name: "x",
      agentId: "claude-code",
      providerId: "hostile",
    });
    assert.deepEqual(Object.keys(spec.env), ["ANTHROPIC_BASE_URL"]);
  });
});

describe("isRecordId", () => {
  it("is the one rule profile names, account ids and route segments share", () => {
    for (const id of ["work", "work_2-x", "A1", "0"]) {
      assert.equal(isRecordId(id), true, id);
      validateProfileName(id);
    }
    for (const id of ["", "-leading", "_leading", "../etc/passwd", "a b", "a/b", "a.b"]) {
      assert.equal(isRecordId(id), false, id);
      assert.throws(() => validateProfileName(id), ProfileError, id);
    }
    for (const value of [undefined, null, 7, {}]) {
      assert.equal(isRecordId(value), false, String(value));
    }
    assert.equal(RECORD_ID_RE.source, "^[A-Za-z0-9][A-Za-z0-9_-]*$");
  });
});
