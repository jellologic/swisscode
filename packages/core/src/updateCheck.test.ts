import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isNewerVersion } from "./updateCheck.js";

describe("isNewerVersion", () => {
  it("compares leading numeric tuples release-style", () => {
    const cases: Array<[latest: string, current: string, newer: boolean]> = [
      ["2.1.8", "2.1.7", true],
      ["2.1.7", "2.1.7", false],
      ["2.1.6", "2.1.7", false],
      // Short tuples pad with zeros: "2.1" names the same release as "2.1.0".
      ["2.1", "2.1.0", false],
      ["2.1.0", "2.1", false],
      ["2.2", "2.1.9", true],
      // Numeric, not lexical: 10 beats 9 in every position.
      ["1.10.0", "1.9.9", true],
      ["10.0.0", "9.9.9", true],
      // A leading "v" is cosmetic.
      ["v2.1.8", "2.1.7", true],
      ["2.1.8", "v2.1.7", true],
      // A trailing build tag still counts when the numbers differ.
      ["2.1.8-rc.1", "2.1.7", true],
    ];
    for (const [latest, current, newer] of cases) {
      assert.equal(isNewerVersion(latest, current), newer, `${latest} vs ${current}`);
    }
  });

  it("breaks a numeric tie in favor of the bare release", () => {
    assert.equal(isNewerVersion("2.1.7", "2.1.7-rc.1"), true);
    assert.equal(isNewerVersion("2.1.7-rc.1", "2.1.7"), false);
    // Two prereleases of the same tuple never claim newer — tags are opaque.
    assert.equal(isNewerVersion("2.1.7-rc.2", "2.1.7-rc.1"), false);
  });

  it("never calls an unparseable version newer", () => {
    // A build that cannot name its version (the "dev" fallback) must not
    // claim an update exists — or refuse one — on either side.
    for (const version of ["dev", "", "latest", "  "]) {
      assert.equal(isNewerVersion(version, "2.1.7"), false, `latest=${JSON.stringify(version)}`);
      assert.equal(isNewerVersion("9.9.9", version), false, `current=${JSON.stringify(version)}`);
    }
  });
});
