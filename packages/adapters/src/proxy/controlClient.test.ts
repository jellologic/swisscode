import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PROXY_TOKEN_HEADER } from "./proxyToken.js";
import { ProxyControlClient, ProxyUnavailableError } from "./controlClient.js";

interface Recorded {
  url: string;
  method: string;
  token: string | undefined;
}

interface Fixture {
  baseUrl: string;
  seen: Recorded[];
  close: () => Promise<void>;
}

/** A stand-in proxy on 127.0.0.1 — never the user's real one. */
async function fixture(reply: (url: string) => { status: number; body: unknown }): Promise<Fixture> {
  const seen: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    seen.push({
      url,
      method: req.method ?? "GET",
      token: req.headers[PROXY_TOKEN_HEADER] as string | undefined,
    });
    const { status, body } = reply(url);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const token = async (): Promise<string | undefined> => "a".repeat(32);

describe("ProxyControlClient", () => {
  it("signs every control call with the per-run token", async () => {
    const f = await fixture(() => ({ status: 200, body: { entries: [], kept: 0, size: 0, profiles: [] } }));
    try {
      const client = new ProxyControlClient({ baseUrl: f.baseUrl, readToken: token });
      await client.traffic({ bodies: false });
      await client.clearTraffic();
      assert.equal(f.seen.length, 2);
      for (const call of f.seen) assert.equal(call.token, "a".repeat(32));
      assert.equal(f.seen[1]?.method, "DELETE");
    } finally {
      await f.close();
    }
  });

  it("asks for a body-less list, and only then by profile", async () => {
    const f = await fixture(() => ({ status: 200, body: { entries: [], kept: 1, size: 2, profiles: ["p"] } }));
    try {
      const client = new ProxyControlClient({ baseUrl: f.baseUrl, readToken: token });
      const list = await client.traffic({ bodies: false, profile: "my profile" });
      assert.deepEqual(list, { entries: [], kept: 1, size: 2, profiles: ["p"] });
      const url = new URL(f.seen[0]!.url, "http://127.0.0.1");
      assert.equal(url.pathname, "/__swisscode/traffic");
      assert.equal(url.searchParams.get("bodies"), "0");
      assert.equal(url.searchParams.get("profile"), "my profile");
    } finally {
      await f.close();
    }
  });

  it("keeps bodies when nothing asked for the light list", async () => {
    const f = await fixture(() => ({ status: 200, body: { entries: [] } }));
    try {
      await new ProxyControlClient({ baseUrl: f.baseUrl, readToken: token }).traffic();
      assert.equal(f.seen[0]?.url, "/__swisscode/traffic");
    } finally {
      await f.close();
    }
  });

  it("fetches one entry with its bodies and encodes the id", async () => {
    const entry = { id: "t1-2", ts: "", method: "POST", path: "/v1/messages", reqBody: "{}" };
    const f = await fixture(() => ({ status: 200, body: { entry } }));
    try {
      const client = new ProxyControlClient({ baseUrl: f.baseUrl, readToken: token });
      assert.deepEqual(await client.entry("t1-2"), entry);
      await client.entry("../../etc/passwd");
      await client.use("a/b");
      assert.equal(f.seen[0]?.url, "/__swisscode/traffic/entry/t1-2");
      assert.equal(f.seen[1]?.url, "/__swisscode/traffic/entry/..%2F..%2Fetc%2Fpasswd");
      assert.equal(f.seen[2]?.url, "/__swisscode/use/a%2Fb");
    } finally {
      await f.close();
    }
  });

  it("reports a missing entry as null", async () => {
    const f = await fixture(() => ({ status: 200, body: { entry: null } }));
    try {
      const client = new ProxyControlClient({ baseUrl: f.baseUrl, readToken: token });
      assert.equal(await client.entry("t9-9"), null);
    } finally {
      await f.close();
    }
  });

  it("sends no header when there is no token file, and reads a refusal as not running", async () => {
    const f = await fixture(() => ({ status: 401, body: { error: "missing token" } }));
    try {
      const client = new ProxyControlClient({
        baseUrl: f.baseUrl,
        readToken: async () => undefined,
      });
      await assert.rejects(() => client.status(), ProxyUnavailableError);
      assert.equal(f.seen[0]?.token, undefined);
    } finally {
      await f.close();
    }
  });

  it("turns an unreachable port into the not-running state", async () => {
    const f = await fixture(() => ({ status: 200, body: {} }));
    const baseUrl = f.baseUrl;
    await f.close();
    const client = new ProxyControlClient({ baseUrl, readToken: token });
    await assert.rejects(() => client.status(), ProxyUnavailableError);
  });

  it("passes a real proxy error through as itself", async () => {
    const f = await fixture(() => ({ status: 404, body: { error: 'Unknown account "nope"' } }));
    try {
      const client = new ProxyControlClient({ baseUrl: f.baseUrl, readToken: token });
      await assert.rejects(
        () => client.use("nope"),
        (err: unknown) => {
          assert.ok(err instanceof Error && !(err instanceof ProxyUnavailableError));
          assert.equal(err.message, 'Unknown account "nope"');
          return true;
        },
      );
    } finally {
      await f.close();
    }
  });
});
