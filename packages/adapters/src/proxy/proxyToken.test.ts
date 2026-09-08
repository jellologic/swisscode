import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PROXY_TOKEN_HEADER,
  createProxyToken,
  defaultProxyTokenPath,
  readProxyToken,
} from "./proxyToken.js";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "swisscode-token-"));
}

describe("proxy token", () => {
  it("names the header the CLI and web UI send", () => {
    assert.equal(PROXY_TOKEN_HEADER, "x-swisscode-token");
  });

  it("mints 32 random bytes of hex, stored 0600, and reads it back", async () => {
    const path = join(await tmp(), "proxy-token");
    const token = await createProxyToken(path);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(((await stat(path)).mode & 0o777), 0o600);
    assert.equal(await readProxyToken(path), token);
  });

  it("mints a distinct token per run and replaces the old file", async () => {
    const path = join(await tmp(), "proxy-token");
    const first = await createProxyToken(path);
    const second = await createProxyToken(path);
    assert.notEqual(first, second);
    assert.equal(await readProxyToken(path), second);
    assert.equal((await readFile(path, "utf8")).trim(), second);
  });

  it("returns undefined when no proxy has run", async () => {
    assert.equal(await readProxyToken(join(await tmp(), "proxy-token")), undefined);
  });

  it("rejects file content that could inject a header", async () => {
    const dir = await tmp();
    for (const junk of ["", "   \n", "short", "abc def ghi jkl mno pqr", "aaaaaaaaaaaaaaaa\r\nX: y"]) {
      const path = join(dir, `t-${Buffer.from(junk).toString("hex")}`);
      await writeFile(path, junk);
      assert.equal(await readProxyToken(path), undefined, JSON.stringify(junk));
    }
  });

  it("defaults under SWISSCODE_HOME so tests never touch the real vault", () => {
    const previous = process.env["SWISSCODE_HOME"];
    try {
      process.env["SWISSCODE_HOME"] = join(tmpdir(), "swisscode-home-fake");
      assert.equal(
        defaultProxyTokenPath(),
        join(tmpdir(), "swisscode-home-fake", "proxy-token"),
      );
    } finally {
      if (previous === undefined) delete process.env["SWISSCODE_HOME"];
      else process.env["SWISSCODE_HOME"] = previous;
    }
  });
});
