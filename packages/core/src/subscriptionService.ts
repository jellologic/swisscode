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

export interface FreshCredentialOptions {
  /**
   * Called when the stored refresh token is rejected (invalid_grant).
   * Rotation-aware owners (e.g. Claude Code) may have moved the lineage
   * elsewhere — the hook can adopt the current one. Return undefined to
   * keep the original error. An adopted credential is persisted by this
   * function before it is returned.
   */
  onInvalidGrant?: (accountId: string) => Promise<OAuthCredential | undefined>;
  /**
   * Called after OUR refresh rotated the lineage and the vault already holds
   * the result. Exists so a caller that knows the lineage is shared with
   * another owner (Claude Code) can mirror the rotation back to it — the old
   * refresh token is dead the moment the endpoint answers, so a shared owner
   * that never sees the new one is logged out. Not called on the adopt path:
   * there the credential came FROM the other owner, which already has it.
   */
  onRefreshed?: (credential: OAuthCredential) => Promise<void>;
}

/**
 * Return a usable credential for the account, refreshing + persisting when
 * expired. Throws OAuthError("invalid_grant") when the account needs re-login.
 */
export async function ensureFreshCredential(
  accounts: AccountRepository,
  oauth: OAuthClient,
  accountId: string,
  options: FreshCredentialOptions = {},
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
  let next: OAuthCredential;
  try {
    next = await oauth.refresh(stored);
  } catch (err) {
    if (err instanceof OAuthError && err.kind === "invalid_grant" && options.onInvalidGrant) {
      const adopted = await options.onInvalidGrant(accountId);
      if (adopted) {
        await accounts.saveCredential(accountId, adopted);
        return { credential: adopted, refreshed: true };
      }
    }
    throw err;
  }
  // Persist first: the rotation already happened server-side, so losing `next`
  // to a failing mirror would strand the account on a dead refresh token.
  await accounts.saveCredential(accountId, next);
  if (options.onRefreshed) await options.onRefreshed(next);
  return { credential: next, refreshed: true };
}
