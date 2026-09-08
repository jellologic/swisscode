import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { maskSecretValue, redactEnv } from "./redact.js";

describe("redactEnv", () => {
  it("masks by value even when the name looks harmless", () => {
    const out = redactEnv({ MY_PASSWORD: "hunter2-and-then-some", GREETING: "hello" }, [
      "hunter2-and-then-some",
    ]);
    assert.equal(out["MY_PASSWORD"], "hunt…me");
    assert.equal(out["GREETING"], "hello");
  });

  it("masks by name when the value was never declared secret", () => {
    const out = redactEnv({ CUSTOM_CREDENTIALS: "abcdefghij", OTHER_PASS: "0123456789" }, []);
    assert.equal(out["CUSTOM_CREDENTIALS"], "abcd…ij");
    assert.equal(out["OTHER_PASS"], "0123…89");
  });

  it("never masks the proxy profile tag", () => {
    const out = redactEnv(
      {
        ANTHROPIC_AUTH_TOKEN: "swisscode-profile/work",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8123",
      },
      ["swisscode-profile/work"],
    );
    assert.equal(out["ANTHROPIC_AUTH_TOKEN"], "swisscode-profile/work");
    assert.equal(out["ANTHROPIC_BASE_URL"], "http://127.0.0.1:8123");
  });

  it("ignores empty secret values so unset vars stay readable", () => {
    const out = redactEnv({ EMPTY: "", NAME: "swisscode" }, ["", ""]);
    assert.deepEqual(out, { EMPTY: "", NAME: "swisscode" });
  });

  it("does not mutate the input", () => {
    const env = { OPENROUTER_API_KEY: "sk-or-123456789" };
    const out = redactEnv(env, []);
    assert.equal(env["OPENROUTER_API_KEY"], "sk-or-123456789");
    assert.equal(out["OPENROUTER_API_KEY"], "sk-o…89");
  });

  it("accepts a custom name regex, including a stateful /g one", () => {
    const env = { A_TOKEN: "aaaaaaaaaa", B_TOKEN: "bbbbbbbbbb", PLAIN: "cccccccccc" };
    const out = redactEnv(env, [], { nameRegex: /TOKEN/g });
    // A /g regex keeps lastIndex between test() calls; both must still mask.
    assert.equal(out["A_TOKEN"], "aaaa…aa");
    assert.equal(out["B_TOKEN"], "bbbb…bb");
    assert.equal(out["PLAIN"], "cccccccccc");
  });
});

describe("maskSecretValue", () => {
  it("matches the adapters-side maskSecret rule", () => {
    assert.equal(maskSecretValue("sk-or-123456789"), "sk-o…89");
    assert.equal(maskSecretValue("short"), "••••••••");
    assert.equal(maskSecretValue("12345678"), "••••••••");
    assert.equal(maskSecretValue("123456789"), "1234…89");
  });
});
