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
  /** Abort budget for the probe. Default {@link VALIDATION_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** A pre-save check blocks a form; a hung socket must not block it forever. */
export const VALIDATION_TIMEOUT_MS = 10_000;

/**
 * Request init shared by every credential probe.
 *
 * `redirect: "manual"` because fetch replays the Authorization header on a
 * cross-origin redirect: a 302 from the declared endpoint would hand the key to
 * whatever host the response names. A redirect is reported, never followed.
 */
function probeInit(
  timeoutMs: number,
  headers?: Record<string, string>,
): { init: RequestInit; done: () => void } {
  // A plain (ref'd) timer rather than AbortSignal.timeout: that signal's timer
  // is unref'd, so on Node 22 a probe stalled before any socket exists lets the
  // event loop drain and the promise never settles. The timer is cleared as
  // soon as the probe answers, so a fast probe never waits on it.
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`Probe timed out after ${timeoutMs}ms`, "TimeoutError")),
    timeoutMs,
  );
  return {
    init: {
      redirect: "manual",
      signal: controller.signal,
      ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    },
    done: () => clearTimeout(timer),
  };
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Validation is data, never an exception — including "the probe timed out". */
function failure(prefix: string, err: unknown, timeoutMs: number): string {
  const name = (err as Error)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    const budget = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
    return `${prefix} timed out after ${budget}.`;
  }
  return `${prefix} failed: ${(err as Error).message}`;
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
    const timeoutMs = this.options.timeoutMs ?? VALIDATION_TIMEOUT_MS;
    const probe = probeInit(timeoutMs, { Authorization: `Bearer ${apiKey}` });
    let res: Response;
    try {
      res = await fetchFn(`${base}/api/v1/auth/key`, probe.init);
    } catch (err) {
      return { ok: false, error: failure("Key check", err, timeoutMs) };
    } finally {
      probe.done();
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Key rejected (invalid or revoked)." };
    }
    if (isRedirect(res.status)) {
      return {
        ok: false,
        error: `Key check failed: endpoint redirected (HTTP ${res.status}); redirects are not followed with a key attached.`,
      };
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
  /** Abort budget for the probe. Default {@link VALIDATION_TIMEOUT_MS}. */
  timeoutMs?: number;
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
    const timeoutMs = this.options.timeoutMs ?? VALIDATION_TIMEOUT_MS;
    const probe = probeInit(timeoutMs, headers);
    let res: Response;
    try {
      res = await fetchFn(test.url, { method: test.method ?? "GET", ...probe.init });
    } catch (err) {
      return { ok: false, error: failure("Test request", err, timeoutMs) };
    } finally {
      probe.done();
    }
    const expected = test.expectStatus;
    // A def may legitimately expect a 3xx; anything else is an unfollowed hop.
    if (isRedirect(res.status) && expected !== res.status) {
      return {
        ok: false,
        error: `Test endpoint redirected (HTTP ${res.status}); redirects are not followed with a credential attached. Use the final URL.`,
      };
    }
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
