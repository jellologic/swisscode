// Adapter: the one way to get a usable vault credential.
//
// Three hazards this closes, all invisible to individual callers:
// - Refresh tokens are single-use. Claude Code opens several requests at
//   startup, so the proxy can ask for the same expired account three times at
//   once; three refreshes spend the token three times and two come back
//   invalid_grant. The SingleFlight makes concurrent asks share one refresh
//   inside this process, and the `<id>.lock` file does the same across
//   processes (proxy + CLI + web UI all read one vault).
// - A lineage SHARED with Claude Code. If the vault copy and Claude's own
//   store hold the same refresh token, refreshing it and saving only to the
//   vault logs Claude Code out. So: adopt Claude's still-valid access token
//   instead of refreshing, and when a refresh is unavoidable, mirror the
//   result back into Claude's store. A lineage that differs is somebody
//   else's — never written to.
// - When the stored lineage really is dead, Claude Code may already hold the
//   rotated one; liveResyncHook adopts it (with its own identity guards)
//   instead of demanding a re-login.
//
// Keyed by accountId only: the vault is a per-user singleton, so one process
// never talks to two vaults with the same account id.

import { SingleFlight, ensureFreshCredential, isCredentialExpired } from "@swisscode/core";
import type {
  AccountRepository,
  ActiveCredentialStore,
  FreshCredential,
  FreshCredentialOptions,
  OAuthClient,
  OAuthCredential,
} from "@swisscode/core";
import { defaultSubscriptionsDir } from "./accountVault.js";
import { withAccountLock } from "./accountLock.js";
import { mirrorRotatedCredential } from "./liveMirror.js";
import { liveResyncHook } from "./liveResync.js";
import type { EmailLookup } from "./liveResync.js";

const inflight = new SingleFlight<FreshCredential>();

export interface FreshVaultCredentialOptions {
  /** Claude Code's own store: shared-lineage detection and rotated adoption. */
  liveStore?: ActiveCredentialStore;
  /**
   * Adopt Claude Code's live lineage when the vault credential is rejected
   * (invalid_grant). Defaults to true — the proxy and usage paths heal a
   * rotated lineage this way. The file-swap switch passes false: there the
   * adopted stranger would be written back over the live store and verified
   * as a "switch" that never happened, so a dead vault credential must
   * surface as re-login-needed instead.
   */
  adoptLive?: boolean;
  /** Where `<id>.lock` lives. Defaults to the vault directory. */
  lockDir?: string;
  /** Profile client used to verify identity before adopting a live login. */
  profile?: EmailLookup;
  /** Non-fatal problems, e.g. the mirror back into Claude's store failed. */
  onWarning?: (message: string) => void;
  /**
   * Rotate even when the stored credential still looks fresh. Set only by a
   * caller upstream ALREADY rejected (a mid-flight 401): without it such a
   * caller would have to refresh on its own and would then skip the
   * cross-process lock and the shared-lineage mirror below.
   */
  force?: boolean;
}

/**
 * The live credential when it is the SAME lineage as `stored`, else undefined.
 * Same refresh token = one rotation chain with two owners.
 */
async function sharedLiveCredential(
  liveStore: ActiveCredentialStore | undefined,
  stored: OAuthCredential,
): Promise<OAuthCredential | undefined> {
  if (!liveStore || !stored.refreshToken) return undefined;
  const active = await liveStore.readActive().catch(() => undefined);
  const live = active?.credential;
  if (!live?.refreshToken) return undefined;
  return live.refreshToken === stored.refreshToken ? live : undefined;
}

async function resolveExpired(
  accounts: AccountRepository,
  oauth: OAuthClient,
  accountId: string,
  opts: FreshVaultCredentialOptions,
): Promise<FreshCredential> {
  // Re-read under the lock: another process may have refreshed while we waited.
  const stored = await accounts.loadCredential(accountId);
  if (!opts.force && stored && !isCredentialExpired(stored)) {
    return { credential: stored, refreshed: false };
  }

  const shared = stored ? await sharedLiveCredential(opts.liveStore, stored) : undefined;
  // Under `force` the stored access token is the one upstream just refused, so
  // adopting an identical copy from Claude's store would only 401 again.
  if (
    shared &&
    !isCredentialExpired(shared) &&
    (!opts.force || shared.accessToken !== stored?.accessToken)
  ) {
    // Claude Code already refreshed this lineage (or never let it expire).
    // Adopting its access token costs no rotation at all.
    await accounts.saveCredential(accountId, shared);
    return { credential: shared, refreshed: false };
  }

  const options: FreshCredentialOptions = opts.force ? { force: true } : {};
  const hook = liveResyncHook({
    accounts,
    oauth,
    ...(opts.liveStore ? { live: opts.liveStore } : {}),
    ...(opts.profile ? { profile: opts.profile } : {}),
  });
  // adoptLive:false (the file-swap switch) still wants the shared-lineage
  // mirror below, but never the stranger-adoption above.
  if (hook && opts.adoptLive !== false) options.onInvalidGrant = hook;
  const live = opts.liveStore;
  if (live && stored) {
    // Registered whenever a live store exists, not only when the read above
    // said "shared": the decision that matters is made against Claude's store
    // at write time, inside the helper. That also makes this a no-op when the
    // OAuth client already mirrored the same rotation — it re-reads and finds
    // the new lineage there, not the one we rotated away from.
    options.onRefreshed = (credential) =>
      mirrorRotatedCredential(live, stored, credential, opts.onWarning).then(() => undefined);
  }
  return ensureFreshCredential(accounts, oauth, accountId, options);
}

/**
 * Return a usable credential for `accountId`, refreshing and persisting when
 * expired. Concurrent callers — in this process or another — share one refresh.
 */
export async function freshVaultCredential(
  accounts: AccountRepository,
  oauth: OAuthClient,
  accountId: string,
  opts: FreshVaultCredentialOptions = {},
): Promise<FreshCredential> {
  // Forced callers get their own coalescing key: joining an in-flight ordinary
  // ask would hand them back the very token upstream just rejected.
  return inflight.run(opts.force ? `${accountId}\u0000force` : accountId, async () => {
    // Fast path: a valid credential needs neither the lock file nor a Keychain
    // read, and this runs on every proxied request.
    const stored = await accounts.loadCredential(accountId);
    if (!opts.force && stored && !isCredentialExpired(stored)) {
      return { credential: stored, refreshed: false };
    }
    const dir = opts.lockDir ?? defaultSubscriptionsDir();
    const run = await withAccountLock(dir, accountId, () =>
      resolveExpired(accounts, oauth, accountId, opts),
    );
    return run.value;
  });
}
