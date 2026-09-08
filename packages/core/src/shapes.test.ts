import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isOAuthCredentialShape,
  isProfileShape,
  isProviderAccountShape,
  isSubscriptionAccountShape,
  isSubscriptionBackupShape,
} from "./shapes.js";

const profile = {
  name: "work",
  agentId: "claude-code",
  providerId: "openrouter",
  agentArgs: ["--verbose"],
  providerConfig: { apiKey: "sk-or-1" },
  model: "anthropic/claude-sonnet-4",
  useProxy: false,
  subscriptionAccountId: "personal",
  providerAccountId: "or-main",
};

describe("isProfileShape", () => {
  it("accepts a full profile and a minimal one", () => {
    assert.equal(isProfileShape(profile), true);
    assert.equal(isProfileShape({ name: "p", agentId: "a", providerId: "b" }), true);
  });

  it("rejects wrong field types instead of throwing", () => {
    const bad: unknown[] = [
      { ...profile, name: 123 },
      { ...profile, agentId: null },
      { ...profile, providerId: undefined },
      { ...profile, agentArgs: "--verbose" },
      { ...profile, agentArgs: [1, 2] },
      { ...profile, providerConfig: { apiKey: { nested: true } } },
      { ...profile, providerConfig: ["apiKey"] },
      { ...profile, model: 4 },
      { ...profile, useProxy: "yes" },
      { ...profile, subscriptionAccountId: 7 },
      { ...profile, providerAccountId: {} },
    ];
    for (const value of bad) assert.equal(isProfileShape(value), false, JSON.stringify(value));
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, 3, "profile", [], [profile], true]) {
      assert.equal(isProfileShape(value), false, String(value));
    }
  });
});

describe("isProviderAccountShape", () => {
  it("accepts an account with a flat string config", () => {
    assert.equal(
      isProviderAccountShape({
        id: "main",
        providerId: "openrouter",
        label: "Main",
        config: { apiKey: "k", model: "m" },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      true,
    );
    // Timestamps are re-stamped on save, so an import may omit them.
    assert.equal(
      isProviderAccountShape({ id: "main", providerId: "openrouter", label: "Main", config: {} }),
      true,
    );
  });

  it("rejects the missing/nested config that broke four routes", () => {
    assert.equal(isProviderAccountShape({ id: "m", providerId: "p", label: "L" }), false);
    assert.equal(
      isProviderAccountShape({ id: "m", providerId: "p", label: "L", config: null }),
      false,
    );
    assert.equal(
      isProviderAccountShape({ id: "m", providerId: "p", label: "L", config: { apiKey: { a: 1 } } }),
      false,
    );
    assert.equal(
      isProviderAccountShape({ id: 1, providerId: "p", label: "L", config: {} }),
      false,
    );
    assert.equal(
      isProviderAccountShape({
        id: "m",
        providerId: "p",
        label: "L",
        config: {},
        createdAt: 0,
      }),
      false,
    );
    assert.equal(isProviderAccountShape(undefined), false);
  });
});

describe("isOAuthCredentialShape", () => {
  it("requires both tokens and typed optionals", () => {
    assert.equal(isOAuthCredentialShape({ accessToken: "a", refreshToken: "r" }), true);
    assert.equal(
      isOAuthCredentialShape({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 1,
        scopes: ["user:inference"],
        extra: { subscriptionType: "max" },
      }),
      true,
    );
    assert.equal(isOAuthCredentialShape({ accessToken: "a" }), false);
    assert.equal(isOAuthCredentialShape({ accessToken: "a", refreshToken: 1 }), false);
    assert.equal(
      isOAuthCredentialShape({ accessToken: "a", refreshToken: "r", expiresAt: "soon" }),
      false,
    );
    assert.equal(
      isOAuthCredentialShape({ accessToken: "a", refreshToken: "r", expiresAt: NaN }),
      false,
    );
    assert.equal(
      isOAuthCredentialShape({ accessToken: "a", refreshToken: "r", scopes: [1] }),
      false,
    );
    assert.equal(
      isOAuthCredentialShape({ accessToken: "a", refreshToken: "r", extra: "nope" }),
      false,
    );
  });
});

describe("isSubscriptionBackupShape", () => {
  const account = {
    id: "personal",
    label: "Personal",
    email: "p@example.com",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts a backup with and without a credential", () => {
    assert.equal(isSubscriptionAccountShape(account), true);
    assert.equal(
      isSubscriptionBackupShape({ account, credential: { accessToken: "a", refreshToken: "r" } }),
      true,
    );
    // includeSecrets=false exports drop the credential.
    assert.equal(isSubscriptionBackupShape({ account }), true);
  });

  it("rejects a bad account or a bad credential", () => {
    assert.equal(isSubscriptionBackupShape({}), false);
    assert.equal(isSubscriptionBackupShape({ account: { id: "p" } }), false);
    assert.equal(isSubscriptionBackupShape({ account: { ...account, email: 5 } }), false);
    assert.equal(isSubscriptionBackupShape({ account, credential: {} }), false);
    assert.equal(isSubscriptionBackupShape({ account, credential: null }), false);
    assert.equal(isSubscriptionBackupShape(null), false);
  });
});
