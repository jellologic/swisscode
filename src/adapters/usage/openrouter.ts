// OpenRouter's key endpoint, as a usage source.
//
// VERIFIED against the live service before this was written: OpenRouter serves
// `GET {baseUrl}/v1/key` returning a `data` object with `limit`,
// `limit_remaining`, `usage`, and `usage_daily|weekly|monthly`. It composes
// from the descriptor's own base URL (`https://openrouter.ai/api`), so no
// second endpoint constant has to be kept in step with the first.
//
// It is the ONLY usage adapter shipped, and that is deliberate rather than
// unfinished: the other presets were not confirmed to publish anything
// equivalent, and a provider that reports nothing must report nothing rather
// than a plausible zero. That is the same standard REJECTED_PROVIDERS and the
// Ollama work were held to.

import type { ProviderUsage, ProviderUsagePort } from '../../ports/provider-usage.ts'

/** Composed from the provider's base URL, not hard-coded, so the two agree. */
export function keyUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/key`
}

function isObjectLike(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * A finite number, or null.
 *
 * `null` is a REAL value in this payload — OpenRouter uses it for "no limit" —
 * so it must survive as null rather than becoming 0. An uncapped key with
 * `remaining: 0` would be ranked last by the `usage` strategy, which is exactly
 * backwards.
 */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** Extract usage from whatever the endpoint returned. Exported for testing. */
export function parseKeyResponse(body: unknown, checkedAt: number): ProviderUsage | null {
  const data = isObjectLike(body) && isObjectLike(body.data) ? body.data : null
  if (!data) return null

  const usage: ProviderUsage = {
    remaining: num(data.limit_remaining),
    limit: num(data.limit),
    used: num(data.usage),
    // Credits, which OpenRouter prices in dollars — but the field is for
    // display and nothing branches on it, so it is not asserted as 'usd'.
    unit: 'credits',
    checkedAt,
  }
  // Nothing usable at all is null, not a row of nulls: a caller should be able
  // to tell "this provider does not publish usage" from "this account has no
  // limit", and only one of those is worth showing.
  if (usage.remaining === null && usage.limit === null && usage.used === null) return null
  return usage
}

export function createOpenRouterUsage(now: () => number = () => Date.now()): ProviderUsagePort {
  return {
    id: 'openrouter',
    async fetch({ baseUrl, credential, timeoutMs = 4000 }) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await globalThis.fetch(keyUrl(baseUrl), {
          headers: { authorization: `Bearer ${credential}` },
          signal: controller.signal,
        })
        if (!res.ok) return null
        return parseKeyResponse(await res.json(), now())
      } catch {
        // Down, rate-limited, offline, or the shape changed. All are findings
        // for the caller to render, none is an exception worth unwinding a
        // configuration screen with.
        return null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
