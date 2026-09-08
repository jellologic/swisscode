// The guard is plain JS (server.mjs runs it with no build step), so it is
// loaded through its URL: the compiled test sits two directories deep in
// dist-test, exactly like this source sits in src/lib.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface HostGuard {
  isAllowedHost: (host: unknown, configuredHost?: string) => boolean;
  webHost: (env?: Record<string, string | undefined>) => string;
}

const { isAllowedHost, webHost } = (await import(
  new URL("../../hostGuard.mjs", import.meta.url).href
)) as HostGuard;

describe("webHost", () => {
  it("binds loopback unless the operator opted out", () => {
    assert.equal(webHost({}), "127.0.0.1");
    assert.equal(webHost({ SWISSCODE_WEB_HOST: "  " }), "127.0.0.1");
    assert.equal(webHost({ SWISSCODE_WEB_HOST: "192.168.1.5" }), "192.168.1.5");
  });
});

describe("isAllowedHost", () => {
  it("answers for the local names, with or without a port", () => {
    for (const host of ["localhost", "localhost:3000", "127.0.0.1", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST:80"]) {
      assert.equal(isAllowedHost(host), true, host);
    }
  });

  it("refuses the spoofed Host that reached the export route", () => {
    for (const host of [
      "192.168.1.20:3000",
      "evil.example.com",
      "localhost.evil.example.com",
      "127.0.0.1.evil.example.com",
      "127.0.0.1:3000.evil.com",
      "",
      "   ",
      undefined,
      null,
      12345,
    ]) {
      assert.equal(isAllowedHost(host), false, String(host));
    }
  });

  it("also answers for an explicitly configured bind address", () => {
    assert.equal(isAllowedHost("192.168.1.5:3000", "192.168.1.5"), true);
    assert.equal(isAllowedHost("192.168.1.5", "192.168.1.5"), true);
    assert.equal(isAllowedHost("192.168.1.6", "192.168.1.5"), false);
  });

  it("never treats a wildcard bind as a name a client may claim", () => {
    assert.equal(isAllowedHost("0.0.0.0:3000", "0.0.0.0"), false);
    assert.equal(isAllowedHost("evil.example.com", "0.0.0.0"), false);
    assert.equal(isAllowedHost("127.0.0.1:3000", "0.0.0.0"), true);
  });
});
