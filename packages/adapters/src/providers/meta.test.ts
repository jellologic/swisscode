import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { META_BASE_URL, META_DEFAULT_MODEL, metaProvider } from "./meta.js";

describe("metaProvider", () => {
  it("points Claude Code at Meta with the stored key", () => {
    const env = metaProvider.buildEnv({ apiKey: "  LLM_test-key  " }, {});
    assert.equal(env["ANTHROPIC_BASE_URL"], META_BASE_URL);
    assert.equal(env["ANTHROPIC_BASE_URL"], "https://api.meta.ai");
    assert.equal(env["ANTHROPIC_AUTH_TOKEN"], "LLM_test-key");
  });

  it("defaults the model to the flagship Spark model", () => {
    const env = metaProvider.buildEnv({ apiKey: "k" }, {});
    assert.equal(env["ANTHROPIC_MODEL"], META_DEFAULT_MODEL);
    assert.equal(env["ANTHROPIC_DEFAULT_OPUS_MODEL"], META_DEFAULT_MODEL);
    assert.equal(env["ANTHROPIC_DEFAULT_SONNET_MODEL"], META_DEFAULT_MODEL);
    assert.equal(env["ANTHROPIC_DEFAULT_HAIKU_MODEL"], META_DEFAULT_MODEL);
    assert.equal(env["CLAUDE_CODE_SUBAGENT_MODEL"], META_DEFAULT_MODEL);
  });

  it("prefers the profile model, then the account default, for every tier var", () => {
    const profile = metaProvider.buildEnv({ apiKey: "k", model: "muse-spark-1.2" }, {});
    assert.equal(profile["ANTHROPIC_MODEL"], "muse-spark-1.2");
    assert.equal(profile["ANTHROPIC_DEFAULT_SONNET_MODEL"], "muse-spark-1.2");
    assert.equal(profile["CLAUDE_CODE_SUBAGENT_MODEL"], "muse-spark-1.2");

    const override = metaProvider.buildEnv({ apiKey: "k", model: "muse-spark-1.2" }, { model: "muse-spark-1.3" });
    assert.equal(override["ANTHROPIC_MODEL"], "muse-spark-1.3");
    assert.equal(override["ANTHROPIC_DEFAULT_OPUS_MODEL"], "muse-spark-1.3");
    assert.equal(override["CLAUDE_CODE_SUBAGENT_MODEL"], "muse-spark-1.3");
  });

  it("advertises a catalog and connection test but no usage or endpoints", () => {
    assert.equal(metaProvider.accountCapabilities.modelCatalog, true);
    assert.equal(metaProvider.accountCapabilities.connectionTest, true);
    assert.equal(metaProvider.accountCapabilities.usageMetrics, false);
    assert.equal(metaProvider.accountCapabilities.modelEndpoints, false);
  });
});
