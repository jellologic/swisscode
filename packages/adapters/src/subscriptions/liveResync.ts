// Adapter: heal a vault account whose refresh token was rotated away.
// Claude Code owns rotation: it refreshes in its own store (Keychain first,
// then the credentials file) and every rotation invalidates the lineage we
// imported earlier. When our refresh is rejected with invalid_grant, the fix
// is to adopt Claude's CURRENT lineage — never to retry the dead one.
//
// Interference rules (rotation is single-writer-unsafe):
// - Adopting a live credential with valid access consumes nothing: the proxy
//   simply shares the same Bearer Claude uses. Zero writes to Claude's store.
// - The live access token is refreshed only when already expired, and the
//   result is saved to OUR vault alone. Claude's store is never written here,
//   so a concurrent Claude refresh can at worst cost one retry, never a
//   half-written login.

import { isCredentialExpired, OAuthError } from "@swisscode/core";
import type {
  AccountRepository,
  ActiveCredentialStore,
  OAuthClient,
  OAuthCredential,
} from "@swisscode/core";

export interface LiveResyncDeps {
  accounts: AccountRepository;
  oauth: OAuthClient;
  live: ActiveCredentialStore;
}

/**
 * Adopt Claude Code's live credential lineage into the vault account.
 * Returns the credential to use, or undefined when there is nothing newer
 * to adopt (same dead lineage, no live login, or the live lineage is dead
 * too — that case genuinely needs `claude login`).
 */
export async function resyncSubscriptionCredential(
  deps: LiveResyncDeps,
  accountId: string,
): Promise<OAuthCredential | undefined> {
  const stored = await deps.accounts.loadCredential(accountId).catch(() => undefined);
  const active = await deps.live.readActive().catch(() => undefined);
  const live = active?.credential;
  if (!live?.refreshToken) return undefined;
  if (stored?.refreshToken && stored.refreshToken === live.refreshToken) {
    return undefined; // same lineage we just failed with — retrying is futile
  }
  if (!isCredentialExpired(live)) return live;
  try {
    return await deps.oauth.refresh(live);
  } catch (err) {
    if (err instanceof OAuthError && err.kind === "invalid_grant") return undefined;
    throw err;
  }
}

/**
 * ensureFreshCredential hook: adopt-then-persist lives in core; this builds
 * the adapter side from the three ports. Pass undefined live store to skip.
 */
export function liveResyncHook(
  deps: Omit<LiveResyncDeps, "live"> & { live?: ActiveCredentialStore },
): ((accountId: string) => Promise<OAuthCredential | undefined>) | undefined {
  if (!deps.live) return undefined;
  const full: LiveResyncDeps = { accounts: deps.accounts, oauth: deps.oauth, live: deps.live };
  return (accountId: string) => resyncSubscriptionCredential(full, accountId);
}
