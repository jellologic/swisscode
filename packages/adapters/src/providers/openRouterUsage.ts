// Adapter: OpenRouter key usage reader (ProviderUsageReader).
// GET /api/v1/auth/key answers { data: { label, usage, limit, ... } }
// with credit amounts in USD. Null limit = no cap set.

import type {
  ProviderAccount,
  ProviderUsageReader,
  ProviderUsageSnapshot,
} from "@swisscode/core";

export interface OpenRouterUsageOptions {
  baseUrl?: string; // default https://openrouter.ai
  fetchFn?: typeof fetch;
}

function money(value: unknown): string {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "n/a";
}

export class OpenRouterUsageReader implements ProviderUsageReader {
  readonly providerId = "openrouter";

  constructor(private readonly options: OpenRouterUsageOptions = {}) {}

  async readUsage(account: ProviderAccount): Promise<ProviderUsageSnapshot> {
    const base = (this.options.baseUrl ?? "https://openrouter.ai").replace(/\/$/, "");
    const fetchFn = this.options.fetchFn ?? fetch;
    const apiKey = account.config["apiKey"] ?? "";
    let res: Response;
    try {
      res = await fetchFn(`${base}/api/v1/auth/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      throw new Error(`OpenRouter key check failed: ${(err as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error("OpenRouter key rejected (invalid or revoked).");
    }
    if (!res.ok) throw new Error(`OpenRouter key check failed: HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as {
      data?: { label?: string; usage?: number; limit?: number | null };
    };
    const data = body.data ?? {};
    const usage = typeof data.usage === "number" ? data.usage : null;
    const limit = typeof data.limit === "number" ? data.limit : null;
    const metrics = [
      { label: "Spend", value: usage === null ? "n/a" : money(usage) },
      { label: "Limit", value: limit === null ? "unlimited" : money(limit) },
    ];
    if (usage !== null && limit !== null && limit > 0) {
      metrics.push({ label: "Used", value: `${((usage / limit) * 100).toFixed(1)}%` });
    }
    if (typeof data.label === "string" && data.label) {
      metrics.unshift({ label: "Key label", value: data.label });
    }
    return {
      accountId: account.id,
      providerId: account.providerId,
      fetchedAt: new Date().toISOString(),
      metrics,
    };
  }
}
