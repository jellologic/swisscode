import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AnthropicUsageClient, MAX_RETRY_AFTER_MS, UsageError } from "./anthropic.js";

/** 429 with the given Retry-After header; no network involved. */
function rateLimited(retryAfter?: string): typeof fetch {
  const headers = new Headers();
  if (retryAfter !== undefined) headers.set("retry-after", retryAfter);
  return (async () =>
    new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers,
    })) as unknown as typeof fetch;
}

async function retryAfterOf(header?: string): Promise<number | undefined> {
  const client = new AnthropicUsageClient({ apiHost: "http://usage.invalid", fetchFn: rateLimited(header) });
  try {
    await client.fetchUsage("a", "tok");
  } catch (err) {
    assert.ok(err instanceof UsageError);
    return err.retryAfterMs;
  }
  throw new Error("expected a UsageError");
}

describe("Retry-After handling", () => {
  it("clamps a hostile or absurd delay to 15 minutes", async () => {
    // A day-long cooldown would look like "usage is permanently broken" with
    // no recovery short of deleting the cache file.
    assert.equal(await retryAfterOf("86400"), MAX_RETRY_AFTER_MS);
    assert.equal(await retryAfterOf("999999999"), MAX_RETRY_AFTER_MS);
    const farFuture = new Date(Date.now() + 7 * 24 * 3600_000).toUTCString();
    assert.equal(await retryAfterOf(farFuture), MAX_RETRY_AFTER_MS);
  });

  it("passes a reasonable delay through and never goes negative", async () => {
    assert.equal(await retryAfterOf("30"), 30_000);
    // A date already in the past means "retry now", not "retry in the past".
    assert.equal(await retryAfterOf(new Date(Date.now() - 60_000).toUTCString()), 0);
  });

  it("reports no delay when the header is missing or unparseable", async () => {
    assert.equal(await retryAfterOf(undefined), undefined);
    assert.equal(await retryAfterOf("   "), undefined);
    assert.equal(await retryAfterOf("soon"), undefined);
  });
});
