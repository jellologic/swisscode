// Adapter: Anthropic OAuth token refresh + usage/limits clients.
// Endpoints and client id mirror claude-swap's oauth.py (observed behavior
// of Claude Code itself). Hosts are injectable for hermetic tests.

import type {
  AccountUsage,
  OAuthClient,
  OAuthCredential,
  UsageClient,
  UsageWindow,
} from "@swisscode/core";
import { OAuthError } from "@swisscode/core";

/** Same public client id Claude Code uses (see claude-swap oauth.py). */
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const OAUTH_BETA_HEADER = "oauth-2025-04-20";

export interface AnthropicOptions {
  tokenHost?: string; // default https://platform.claude.com
  apiHost?: string; // default https://api.anthropic.com
  fetchFn?: typeof fetch;
}

const TOKEN_PATH = "/v1/oauth/token";
const USAGE_PATH = "/api/oauth/usage";
const PROFILE_PATH = "/api/oauth/profile";

function hosts(options: AnthropicOptions): { tokenHost: string; apiHost: string; fetchFn: typeof fetch } {
  return {
    tokenHost: options.tokenHost ?? "https://platform.claude.com",
    apiHost: options.apiHost ?? "https://api.anthropic.com",
    fetchFn: options.fetchFn ?? fetch,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

export class AnthropicOAuthClient implements OAuthClient {
  constructor(private readonly options: AnthropicOptions = {}) {}

  async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
    if (!credential.refreshToken) {
      throw new OAuthError("no_refresh_token", "No refresh token stored.");
    }
    const { tokenHost, fetchFn } = hosts(this.options);
    let res: Response;
    try {
      res = await fetchFn(`${tokenHost}${TOKEN_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: credential.refreshToken,
          client_id: OAUTH_CLIENT_ID,
        }),
      });
    } catch (err) {
      throw new OAuthError("transient", `Token refresh failed: ${(err as Error).message}`);
    }
    const body = asRecord(await res.json().catch(() => undefined)) ?? {};
    if (!res.ok) {
      const errText =
        typeof body["error"] === "string" ? body["error"] : `HTTP ${res.status}`;
      if (res.status === 400 && errText === "invalid_grant") {
        throw new OAuthError(
          "invalid_grant",
          "Refresh token rejected — re-login with Claude Code, then re-import.",
        );
      }
      throw new OAuthError("transient", `Token refresh failed: ${errText}`);
    }
    const access = body["access_token"];
    const refresh = body["refresh_token"];
    if (typeof access !== "string" || typeof refresh !== "string") {
      throw new OAuthError("transient", "Token endpoint returned an unexpected shape.");
    }
    const cred: OAuthCredential = {
      ...(credential.extra !== undefined ? { extra: credential.extra } : {}),
      accessToken: access,
      refreshToken: refresh,
    };
    if (typeof body["expires_in"] === "number") {
      cred.expiresAt = Date.now() + (body["expires_in"] as number) * 1000;
    }
    return cred;
  }
}

function toWindow(value: unknown): UsageWindow | undefined {
  const rec = asRecord(value);
  if (!rec || !("utilization" in rec)) return undefined;
  const utilization = rec["utilization"];
  const window: UsageWindow = {
    utilization: typeof utilization === "number" ? utilization : null,
  };
  if (typeof rec["resets_at"] === "string") window.resetsAt = rec["resets_at"];
  return window;
}

/** Usage fetch failure with machine-readable status for retry policy. */
export class UsageError extends Error {
  readonly status?: number;
  /** ms to wait before retrying (from Retry-After), if the server sent one. */
  readonly retryAfterMs?: number;
  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export class AnthropicUsageClient implements UsageClient {
  constructor(private readonly options: AnthropicOptions = {}) {}

  async fetchUsage(accountId: string, accessToken: string): Promise<AccountUsage> {
    const { apiHost, fetchFn } = hosts(this.options);
    let res: Response;
    try {
      res = await fetchFn(`${apiHost}${USAGE_PATH}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": OAUTH_BETA_HEADER,
        },
      });
    } catch (err) {
      throw new UsageError(`Usage fetch failed: ${(err as Error).message}`);
    }
    if (!res.ok) {
      throw new UsageError(
        `Usage fetch failed: HTTP ${res.status}`,
        res.status,
        retryAfterMs(res),
      );
    }
    const data = asRecord(await res.json().catch(() => undefined)) ?? {};
    const usage: AccountUsage = {
      accountId,
      fetchedAt: new Date().toISOString(),
    };
    const fiveHour = toWindow(data["five_hour"]);
    if (fiveHour) usage.fiveHour = fiveHour;
    const sevenDay = toWindow(data["seven_day"]);
    if (sevenDay) usage.sevenDay = sevenDay;
    const models: Record<string, UsageWindow> = {};
    for (const [key, value] of Object.entries(data)) {
      const match = /^seven_day_(.+)$/.exec(key);
      if (!match) continue;
      const window = toWindow(value);
      if (window) models[match[1] as string] = window;
    }
    if (Object.keys(models).length > 0) usage.models = models;

    // Per-model weekly limits: limits[] entries with scope.model.display_name
    // (e.g. "Fable"). The legacy keys above never expose these.
    const limits = data["limits"];
    if (Array.isArray(limits)) {
      const scoped = [];
      for (const lim of limits) {
        const rec = asRecord(lim);
        const scope = asRecord(rec?.["scope"]);
        const model = asRecord(scope?.["model"]);
        const name = model?.["display_name"];
        const pct = rec?.["percent"];
        if (typeof name !== "string" || !name || typeof pct !== "number") continue;
        const entry: { name: string; utilization: number; resetsAt?: string } = {
          name,
          utilization: pct,
        };
        if (typeof rec?.["resets_at"] === "string") entry.resetsAt = rec["resets_at"] as string;
        scoped.push(entry);
      }
      if (scoped.length > 0) usage.scoped = scoped;
    }

    // Pay-as-you-go extra-usage spend (credits are cents).
    const extraUsage = asRecord(data["extra_usage"]);
    if (extraUsage) {
      const used = extraUsage["used_credits"];
      const limit = extraUsage["monthly_limit"];
      if (typeof used === "number") {
        const spend: { used: number; limit: number | null; resetsAt?: string } = {
          used: used / 100,
          limit: typeof limit === "number" ? limit / 100 : null,
        };
        if (typeof extraUsage["resets_at"] === "string") {
          spend.resetsAt = extraUsage["resets_at"] as string;
        }
        usage.spend = spend;
      }
    }

    // Generic capture: any other top-level {utilization} window — rotating
    // codename keys, future scoped windows. Strict shape filter, no allowlist
    // to go stale.
    const consumed = new Set([
      "five_hour",
      "seven_day",
      "extra_usage",
      "spend",
      "limits",
      "member_dashboard_available",
      ...Object.keys(models).map((m) => `seven_day_${m}`),
    ]);
    const windows = [];
    for (const [key, value] of Object.entries(data)) {
      if (consumed.has(key)) continue;
      const window = toWindow(value);
      if (window && typeof window.utilization === "number") {
        windows.push({
          key,
          utilization: window.utilization,
          ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
        });
      }
    }
    if (windows.length > 0) usage.windows = windows;
    return usage;
  }

  /** Best-effort account email for import labeling; undefined when unavailable. */
  async fetchEmail(accessToken: string): Promise<string | undefined> {
    const { apiHost, fetchFn } = hosts(this.options);
    try {
      const res = await fetchFn(`${apiHost}${PROFILE_PATH}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-beta": OAUTH_BETA_HEADER,
        },
      });
      if (!res.ok) return undefined;
      const data = asRecord(await res.json().catch(() => undefined));
      const account = asRecord(data?.["account"]);
      const email = account?.["email"] ?? data?.["email"];
      return typeof email === "string" ? email : undefined;
    } catch {
      return undefined;
    }
  }
}
