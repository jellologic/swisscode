import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DENIED_ENV_NAMES, isDeniedEnvName } from "./envPolicy.js";

describe("isDeniedEnvName", () => {
  it("denies every listed name", () => {
    for (const name of DENIED_ENV_NAMES) assert.equal(isDeniedEnvName(name), true, name);
  });

  it("denies the linker-preload prefixes", () => {
    assert.equal(isDeniedEnvName("LD_PRELOAD"), true);
    assert.equal(isDeniedEnvName("LD_LIBRARY_PATH"), true);
    assert.equal(isDeniedEnvName("DYLD_INSERT_LIBRARIES"), true);
    assert.equal(isDeniedEnvName("DYLD_FRAMEWORK_PATH"), true);
  });

  it("fails closed on case and surrounding space", () => {
    assert.equal(isDeniedEnvName("path"), true);
    assert.equal(isDeniedEnvName("Node_Options"), true);
    assert.equal(isDeniedEnvName(" PATH "), true);
    assert.equal(isDeniedEnvName("dyld_insert_libraries"), true);
  });

  it("allows provider env names, including near-misses", () => {
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "OPENROUTER_API_KEY",
      "ANTHROPIC_MODEL",
      "PATHOLOGY", // starts with PATH but is a different name
      "MY_LD_PRELOAD", // prefix rule anchors at the start
      "ENVOY_KEY", // ENV is denied, ENVOY_KEY is not
      "",
    ]) {
      assert.equal(isDeniedEnvName(name), false, name);
    }
  });
});
