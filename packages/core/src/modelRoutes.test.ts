import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ProfileError,
  describeModelRoute,
  extractRequestModel,
  profileShapeProblem,
  selectModelRoute,
  validateModelRoutes,
  validateProfile,
  type ModelRoute,
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

const subRoute: ModelRoute = { match: "claude-opus-5", kind: "subscription" };
const keyRoute: ModelRoute = {
  match: "anthropic/claude-opus-4",
  kind: "providerAccount",
  providerId: "openrouter",
  providerAccountId: "or-main",
  upstreamModel: "anthropic/claude-opus-4",
};

describe("selectModelRoute", () => {
  it("returns undefined without routes", () => {
    assert.equal(selectModelRoute(baseProfile(), "claude-opus-5"), undefined);
    assert.equal(selectModelRoute(baseProfile({ modelRoutes: [] }), "claude-opus-5"), undefined);
  });

  it("matches exactly and wins by list order", () => {
    const profile = baseProfile({ modelRoutes: [subRoute, keyRoute] });
    assert.equal(selectModelRoute(profile, "claude-opus-5"), subRoute);
    assert.equal(selectModelRoute(profile, "anthropic/claude-opus-4"), keyRoute);
    // Aliases never reach the proxy (they resolve client-side), so no alias magic here.
    assert.equal(selectModelRoute(profile, "opus"), undefined);
    assert.equal(selectModelRoute(profile, "CLAUDE-OPUS-5"), undefined);
  });

  it("first match wins on duplicates", () => {
    const a: ModelRoute = { match: "m", kind: "subscription", subscriptionAccountId: "a" };
    const b: ModelRoute = { match: "m", kind: "subscription", subscriptionAccountId: "b" };
    assert.equal(selectModelRoute(baseProfile({ modelRoutes: [a, b] }), "m"), a);
  });
});

describe("extractRequestModel", () => {
  it("reads the model off messages and count-tokens paths", () => {
    assert.equal(extractRequestModel("POST", "/v1/messages", { model: "claude-opus-5" }), "claude-opus-5");
    assert.equal(
      extractRequestModel("POST", "/p/work/v1/messages?beta=true", { model: "claude-sonnet-5" }),
      "claude-sonnet-5",
    );
    assert.equal(
      extractRequestModel("POST", "/v1/messages/count_tokens", { model: "m" }),
      "m",
    );
  });

  it("returns undefined for anything else", () => {
    assert.equal(extractRequestModel("GET", "/v1/messages", { model: "m" }), undefined);
    assert.equal(extractRequestModel("POST", "/api/hello", {}), undefined);
    assert.equal(extractRequestModel("POST", "/__swisscode/use/a", {}), undefined);
    assert.equal(extractRequestModel("POST", "/v1/messages", null), undefined);
    assert.equal(extractRequestModel("POST", "/v1/messages", []), undefined);
    assert.equal(extractRequestModel("POST", "/v1/messages", {}), undefined);
    assert.equal(extractRequestModel("POST", "/v1/messages", { model: "  " }), undefined);
    assert.equal(extractRequestModel("POST", "/v1/messages", { model: 42 }), undefined);
  });
});

describe("validateModelRoutes", () => {
  it("accepts a clean routed profile", () => {
    validateModelRoutes(baseProfile({ modelRoutes: [subRoute, keyRoute] }));
    validateModelRoutes(baseProfile());
  });

  it("rejects direct:true combined with routes", () => {
    assert.throws(
      () => validateModelRoutes(baseProfile({ direct: true, modelRoutes: [subRoute] })),
      ProfileError,
    );
  });

  it("rejects empty/duplicate matches and unknown kinds", () => {
    assert.throws(() => validateModelRoutes(baseProfile({ modelRoutes: [{ match: "  ", kind: "subscription" }] })), ProfileError);
    assert.throws(
      () =>
        validateModelRoutes(
          baseProfile({ modelRoutes: [subRoute, { ...subRoute, subscriptionAccountId: "b" }] }),
        ),
      /duplicates match/,
    );
    assert.throws(
      () =>
        validateModelRoutes(
          baseProfile({ modelRoutes: [{ match: "m", kind: "carrier-pigeon" } as unknown as ModelRoute] }),
        ),
      /unknown kind/,
    );
  });

  it("rejects model ids outside the vendor-id charset", () => {
    // match feeds an exact equality check; upstreamModel is written into the
    // upstream body verbatim — whitespace and shell metacharacters never ride.
    for (const match of ["has space", "a;b", "$(x)", "UPPER ok? no: semi;colon"]) {
      assert.throws(
        () => validateModelRoutes(baseProfile({ modelRoutes: [{ match, kind: "subscription" }] })),
        /not a model id/,
      );
    }
    // Vendor punctuation is fine.
    validateModelRoutes(
      baseProfile({
        modelRoutes: [{ match: "anthropic/claude-opus-4.5:@preview", kind: "subscription" }],
      }),
    );
    // Blank upstreamModel is not passthrough: the proxy rewrites whenever the
    // field is present, so "" would send an empty model id upstream. Omit it.
    assert.throws(
      () =>
        validateModelRoutes(
          baseProfile({ modelRoutes: [{ ...keyRoute, upstreamModel: "  " }] }),
        ),
      /omit it/,
    );
    assert.throws(
      () =>
        validateModelRoutes(
          baseProfile({ modelRoutes: [{ ...keyRoute, upstreamModel: "not a model!" }] }),
        ),
      /not a model id/,
    );
  });

  it("rejects cross-kind fields", () => {
    assert.throws(
      () =>
        validateModelRoutes(
          baseProfile({ modelRoutes: [{ ...subRoute, providerAccountId: "x" }] }),
        ),
      /must not set providerId\/providerAccountId/,
    );
    assert.throws(
      () =>
        validateModelRoutes(
          baseProfile({ modelRoutes: [{ ...keyRoute, subscriptionAccountId: "x" }] }),
        ),
      /must not set subscriptionAccountId/,
    );
    assert.throws(
      () =>
        validateModelRoutes(
          baseProfile({ modelRoutes: [{ match: "m", kind: "providerAccount", providerId: "o" } as ModelRoute] }),
        ),
      /needs providerId and providerAccountId/,
    );
  });

  it("checks referenced accounts only when lookups are supplied", () => {
    const profile = baseProfile({ modelRoutes: [subRoute, keyRoute] });
    // No lookups: existence unknown, everything else still enforced.
    validateModelRoutes(profile);
    const lookups = {
      hasSubscriptionAccount: (id: string) => id === "vault-a",
      hasProviderAccount: (providerId: string, id: string) =>
        providerId === "openrouter" && id === "or-main",
    };
    validateModelRoutes(profile, lookups);
    assert.throws(
      () => validateModelRoutes(profile, { ...lookups, hasSubscriptionAccount: () => false }),
      /unknown subscription account/,
    );
    assert.throws(
      () => validateModelRoutes(profile, { ...lookups, hasProviderAccount: () => false }),
      /unknown openrouter account/,
    );
  });

  it("runs inside validateProfile without store access", () => {
    assert.throws(
      () => validateProfile(baseProfile({ direct: true, modelRoutes: [subRoute] })),
      ProfileError,
    );
    // Dangling references pass launch-time validation (save paths re-check with lookups).
    validateProfile(baseProfile({ modelRoutes: [{ ...keyRoute, providerAccountId: "ghost" }] }));
  });
});

describe("profile shape with new fields", () => {
  it("accepts modelRoutes and direct", () => {
    assert.equal(
      profileShapeProblem(baseProfile({ modelRoutes: [subRoute], direct: false })),
      undefined,
    );
  });

  it("rejects mistyped new fields", () => {
    assert.match(
      String(profileShapeProblem(baseProfile({ modelRoutes: "opus" as unknown as ModelRoute[] }))),
      /modelRoutes must be an array/,
    );
    assert.match(
      String(profileShapeProblem(baseProfile({ direct: "yes" as unknown as boolean }))),
      /profile.direct must be true or false/,
    );
  });
});

describe("describeModelRoute", () => {
  const labels = {
    subscriptionAccountLabel: (id: string) => (id === "vault-a" ? "Work" : undefined),
    providerAccountLabel: (providerId: string, id: string) =>
      providerId === "openrouter" && id === "main" ? "Main" : undefined,
    providerDisplayName: (providerId: string) => (providerId === "openrouter" ? "OpenRouter" : undefined),
  };
  it("describes a subscription route with its vault label", () => {
    assert.equal(
      describeModelRoute({ match: "opus", kind: "subscription", subscriptionAccountId: "vault-a" }, labels),
      "Requests for `opus` → Work vault account, model sent unchanged.",
    );
  });
  it("describes a provider route with a model rewrite", () => {
    assert.equal(
      describeModelRoute(
        {
          match: "codex",
          kind: "providerAccount",
          providerId: "openrouter",
          providerAccountId: "main",
          upstreamModel: "openai/gpt-5",
        },
        labels,
      ),
      "Requests for `codex` → Main OpenRouter key, sent as `openai/gpt-5`.",
    );
  });
  it("falls back to raw ids and the base account when labels are missing", () => {
    assert.equal(
      describeModelRoute({ match: "opus", kind: "subscription" }),
      "Requests for `opus` → the profile's base vault account, model sent unchanged.",
    );
    assert.equal(
      describeModelRoute({ match: "x", kind: "subscription", subscriptionAccountId: "gone" }, labels),
      "Requests for `x` → gone vault account, model sent unchanged.",
    );
  });
});
