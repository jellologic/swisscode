// Subscription orchestration: pure logic over the subscription ports.
// Refresh-then-persist lives here so CLI and UI share one code path.

import { ProfileError } from "./service.js";
import { OAuthError } from "./subscriptionPorts.js";
import type { AccountRepository, OAuthClient } from "./subscriptionPorts.js";
import type { OAuthCredential } from "./subscriptions.js";

/** 5-minute expiry buffer, mirroring claude-swap. */
export const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export function isCredentialExpired(
  credential: OAuthCredential,
  nowMs: number = Date.now(),
): boolean {
  if (!credential.expiresAt) return true;
  return nowMs + OAUTH_EXPIRY_BUFFER_MS >= credential.expiresAt;
}

export function validateAccountId(id: string): void {
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/.test(id)) {
    throw new ProfileError(
      `Invalid account id "${id}". Use letters, numbers, "-" or "_" and start with an alphanumeric.`,
    );
  }
}

export interface FreshCredential {
  credential: OAuthCredential;
  /** True when a refresh happened (caller already persisted it). */
  refreshed: boolean;
}

/**
 * Return a usable credential for the account, refreshing + persisting when
 * expired. Throws OAuthError("invalid_grant") when the account needs re-login.
 */
export async function ensureFreshCredential(
  accounts: AccountRepository,
  oauth: OAuthClient,
  accountId: string,
): Promise<FreshCredential> {
  const stored = await accounts.loadCredential(accountId);
  if (!stored) throw new ProfileError(`Unknown subscription account "${accountId}"`);
  if (!isCredentialExpired(stored)) return { credential: stored, refreshed: false };
  if (!stored.refreshToken) {
    throw new OAuthError(
      "no_refresh_token",
      `Account "${accountId}" has no refresh token — re-import it.`,
    );
  }
  const next = await oauth.refresh(stored);
  await accounts.saveCredential(accountId, next);
  return { credential: next, refreshed: true };
}
