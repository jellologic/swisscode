// Adapter: heal a vault account whose refresh token was rotated away.
// Claude Code owns rotation: it refreshes in its own store (Keychain first,
// then the credentials file) and every rotation invalidates the lineage we
// imported earlier. When our refresh is rejected with invalid_grant, the fix
// is to adopt Claude's CURRENT lineage — never to retry the dead one.
//
// Adoption is only safe when the live login is plausibly the SAME identity as
// the vault account. "Whatever is logged in right now" is not: a user who ran
// `claude login` with their work account would have had their personal
// swisscode account silently repointed at work, and every later request would
// bill the wrong subscription. Two guards, cheapest first:
// 1. Lineage ownership — if another vault account already holds this refresh
//    token, the live login IS that other account. Local, exact, free.
// 2. Email — when we know the account's email, ask the profile endpoint who
//    the live token belongs to and decline on a mismatch. An unknown answer
//    (endpoint down, expired token) does NOT decline: it cannot distinguish a
//    wrong account from an offline laptop, and guard 1 already blocks the
//    common case. The lookup DEFAULTS to the real profile endpoint: every
//    shipped call site builds `liveResyncHook({accounts, oauth, live})`, so an
//    opt-in guard would be an unguarded guard.
//
// Interference rules (rotation is single-writer-unsafe):
// - Adopting a live credential with valid access consumes nothing: the proxy
//   simply shares the same Bearer Claude uses. Zero writes to Claude's store.
// - The live access token is refreshed only when already expired. That spends
//   CLAUDE's single-use refresh token, so the rotation is mirrored back into
//   its store (mirrorRotatedCredential, inside the OAuth adapter) — including
//   when the email guard then declines to adopt. Keeping the result to
//   ourselves would leave the editor holding a dead token.

import { isCredentialExpired, OAuthError } from "@swisscode/core";
import type {
  AccountRepository,
  ActiveCredentialStore,
  OAuthClient,
  OAuthCredential,
} from "@swisscode/core";
import { AnthropicUsageClient } from "./anthropic.js";
import { credentialIdentity } from "./identity.js";

/** Just enough of the profile client to answer "whose token is this?". */
export interface EmailLookup {
  fetchEmail(accessToken: string): Promise<string | undefined>;
}

let defaultProfile: EmailLookup | undefined;

/**
 * The profile endpoint, built lazily and shared. Only ever reached for an
 * account whose email we already know, so an account imported before emails
 * were recorded costs no request.
 */
function defaultEmailLookup(): EmailLookup {
  return (defaultProfile ??= new AnthropicUsageClient());
}

export interface LiveResyncDeps {
  accounts: AccountRepository;
  oauth: OAuthClient;
  live: ActiveCredentialStore;
  /**
   * Identity check for the live token. Defaults to the Anthropic profile
   * endpoint; override to point at another host or to keep a test offline.
   */
  profile?: EmailLookup;
}

/** True when some OTHER vault account already owns this credential lineage. */
async function ownedByAnotherAccount(
  accounts: AccountRepository,
  credential: OAuthCredential,
  accountId: string,
): Promise<boolean> {
  const identity = credentialIdentity(credential);
  for (const account of await accounts.list()) {
    if (account.id === accountId) continue;
    const stored = await accounts.loadCredential(account.id).catch(() => undefined);
    if (stored && credentialIdentity(stored) === identity) return true;
  }
  return false;
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Adopt Claude Code's live credential lineage into the vault account.
 * Returns the credential to use, or undefined when there is nothing safe to
 * adopt (same dead lineage, no live login, a live login that belongs to a
 * different account, or a live lineage that is dead too — that last case
 * genuinely needs `claude login`).
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
  if (await ownedByAnotherAccount(deps.accounts, live, accountId)) return undefined;

  let candidate = live;
  if (isCredentialExpired(live)) {
    try {
      candidate = await deps.oauth.refresh(live);
    } catch (err) {
      if (err instanceof OAuthError && err.kind === "invalid_grant") return undefined;
      throw err;
    }
  }
  // Email check last: it needs a usable access token, which the refresh above
  // may just have produced.
  const account = await deps.accounts.get(accountId).catch(() => undefined);
  if (account?.email) {
    const profile = deps.profile ?? defaultEmailLookup();
    const liveEmail = await profile.fetchEmail(candidate.accessToken).catch(() => undefined);
    if (liveEmail && !sameEmail(liveEmail, account.email)) return undefined;
  }
  return candidate;
}

/**
 * ensureFreshCredential hook: adopt-then-persist lives in core; this builds
 * the adapter side from the ports. Pass undefined live store to skip.
 */
export function liveResyncHook(
  deps: Omit<LiveResyncDeps, "live"> & { live?: ActiveCredentialStore },
): ((accountId: string) => Promise<OAuthCredential | undefined>) | undefined {
  if (!deps.live) return undefined;
  const full: LiveResyncDeps = {
    accounts: deps.accounts,
    oauth: deps.oauth,
    live: deps.live,
    ...(deps.profile ? { profile: deps.profile } : {}),
  };
  return (accountId: string) => resyncSubscriptionCredential(full, accountId);
}
