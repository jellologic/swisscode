// Adapters: pre-save credential checks (ProviderAccountValidator port).
// OpenRouter probes its key-info endpoint; customs declare a test endpoint
// in the def and get the same verdict shape with no code.

import type {
  AccountValidation,
  CustomProviderDef,
  ProviderAccountValidator,
} from "@swisscode/core";

export interface AccountValidatorOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

function money(value: unknown): string {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "n/a";
}

/** OpenRouter: GET /api/v1/auth/key answers key label + spend/limit (USD). */
export class OpenRouterAccountValidator implements ProviderAccountValidator {
  readonly providerId = "openrouter";

  constructor(private readonly options: AccountValidatorOptions = {}) {}

  async validateAccount(config: Record<string, string>): Promise<AccountValidation> {
    const apiKey = (config["apiKey"] ?? "").trim();
    if (!apiKey) return { ok: false, error: "API key is required." };
    const base = (this.options.baseUrl ?? "https://openrouter.ai").replace(/\/$/, "");
    const fetchFn = this.options.fetchFn ?? fetch;
    let res: Response;
    try {
      res = await fetchFn(`${base}/api/v1/auth/key`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (err) {
      return { ok: false, error: `Key check failed: ${(err as Error).message}` };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Key rejected (invalid or revoked)." };
    }
    if (!res.ok) return { ok: false, error: `Key check failed: HTTP ${res.status}` };
    const data = ((await res.json().catch(() => ({}))) as { data?: Record<string, unknown> }).data ?? {};
    const usage = typeof data["usage"] === "number" ? (data["usage"] as number) : null;
    const limit = typeof data["limit"] === "number" ? (data["limit"] as number) : null;
    const detail =
      usage !== null
        ? `spend ${money(usage)}${limit !== null ? ` of ${money(limit)}` : " (no cap)"}`
        : "key is valid";
    const label = typeof data["label"] === "string" && data["label"] ? (data["label"] as string) : undefined;
    return { ok: true, ...(label ? { label } : {}), detail };
  }
}

export interface CustomValidatorOptions {
  fetchFn?: typeof fetch;
}

/** Customs: probe the declared test endpoint, map status to a verdict. */
export class CustomAccountValidator implements ProviderAccountValidator {
  readonly providerId: string;

  constructor(
    private readonly def: CustomProviderDef,
    private readonly options: CustomValidatorOptions = {},
  ) {
    this.providerId = def.id;
  }

  async validateAccount(config: Record<string, string>): Promise<AccountValidation> {
    const test = this.def.test;
    if (!test) return { ok: false, error: "This provider declares no test endpoint." };
    const headers: Record<string, string> = {};
    if (test.authField) {
      const value = (config[test.authField] ?? "").trim();
      if (!value) return { ok: false, error: `Field "${test.authField}" is required to test.` };
      headers[test.headerName ?? "Authorization"] = `${test.authScheme ?? "Bearer "}${value}`;
    }
    const fetchFn = this.options.fetchFn ?? fetch;
    let res: Response;
    try {
      res = await fetchFn(test.url, {
        method: test.method ?? "GET",
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      });
    } catch (err) {
      return { ok: false, error: `Test request failed: ${(err as Error).message}` };
    }
    const expected = test.expectStatus;
    const pass = expected !== undefined ? res.status === expected : res.status >= 200 && res.status < 300;
    if (!pass) {
      return {
        ok: false,
        error:
          res.status === 401 || res.status === 403
            ? "Credentials rejected (invalid or revoked)."
            : `Test endpoint returned HTTP ${res.status}${expected !== undefined ? ` (expected ${expected})` : ""}.`,
      };
    }
    return { ok: true, detail: `test endpoint returned HTTP ${res.status}` };
  }
}
