import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { proxyLaunchEnv, usesProxy } from "./launch.js";
import { proxyBaseUrl } from "../paths.js";

describe("usesProxy", () => {
  it("is on unless the profile opts out with direct:true", () => {
    assert.equal(usesProxy({}), true);
    assert.equal(usesProxy({ direct: false }), true);
    assert.equal(usesProxy({ direct: true }), false);
  });

  it("never reads the legacy useProxy flag", () => {
    // Pre-feature profiles may carry useProxy:false on disk — the opt-out is
    // direct:true now, so the legacy flag must not resurrect direct mode.
    assert.equal(usesProxy({ useProxy: false } as { direct?: boolean }), true);
    assert.equal(usesProxy({ useProxy: true } as { direct?: boolean }), true);
  });
});

describe("proxyLaunchEnv", () => {
  it("points proxy-mode launches at /p/<name> with the profile tag", () => {
    const env = proxyLaunchEnv({ name: "work" }, { ANTHROPIC_MODEL: "x" });
    assert.equal(env["ANTHROPIC_MODEL"], "x");
    assert.match(env["ANTHROPIC_BASE_URL"] ?? "", /\/p\/work$/);
    assert.equal(env["ANTHROPIC_AUTH_TOKEN"], "swisscode-profile/work");
  });
  it("leaves direct launches untouched", () => {
    const base = { ANTHROPIC_MODEL: "x" };
    assert.deepEqual(proxyLaunchEnv({ name: "work", direct: true }, base), base);
  });

  it("rewrites a pre-feature profile exactly like a new one", () => {
    // A stored profile from before direct/modelRoutes/session existed carries
    // none of the new fields (and maybe a legacy useProxy). The rewrite must
    // not depend on any of them — same input env, same output env.
    const coreEnv = {
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api/v1",
      ANTHROPIC_AUTH_TOKEN: "sk-or-legacy",
    };
    const golden = {
      ...coreEnv,
      ANTHROPIC_BASE_URL: `${new URL(proxyBaseUrl()).origin}/p/legacy`,
      ANTHROPIC_AUTH_TOKEN: "swisscode-profile/legacy",
    };
    assert.deepEqual(proxyLaunchEnv({ name: "legacy" }, coreEnv), golden);
    assert.deepEqual(
      proxyLaunchEnv({ name: "legacy", useProxy: false } as { name: string }, coreEnv),
      golden,
    );
  });
});
