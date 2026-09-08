// Adapter: the one way to get a usable vault credential.
//
// Two hazards this closes, both invisible to individual callers:
// - Refresh tokens are single-use. Claude Code opens several requests at
//   startup, so the proxy can ask for the same expired account three times at
//   once; three refreshes spend the token three times and two come back
//   invalid_grant. The SingleFlight makes concurrent asks share one refresh.
// - When the stored lineage really is dead, Claude Code may already hold the
//   rotated one; liveResyncHook adopts it instead of demanding a re-login.
//
// Keyed by accountId only: the vault is a per-user singleton, so one process
// never talks to two vaults with the same account id.

import { SingleFlight, ensureFreshCredential } from "@swisscode/core";
import type {
  AccountRepository,
  ActiveCredentialStore,
  FreshCredential,
  OAuthClient,
} from "@swisscode/core";
import { liveResyncHook } from "./liveResync.js";

const inflight = new SingleFlight<FreshCredential>();

export interface FreshVaultCredentialOptions {
  /** Claude Code's own store, used only to adopt a rotated lineage. */
  liveStore?: ActiveCredentialStore;
}

/**
 * Return a usable credential for `accountId`, refreshing and persisting when
 * expired. Concurrent calls for the same account share one refresh.
 */
export async function freshVaultCredential(
  accounts: AccountRepository,
  oauth: OAuthClient,
  accountId: string,
  opts: FreshVaultCredentialOptions = {},
): Promise<FreshCredential> {
  return inflight.run(accountId, () =>
    ensureFreshCredential(accounts, oauth, accountId, {
      onInvalidGrant: liveResyncHook({ accounts, oauth, live: opts.liveStore }),
    }),
  );
}
