// Credential identity: match "currently logged in" against the vault
// without ever comparing secret values in the clear. sha256 over the
// refresh token survives access-token rotation within one OAuth lineage.

import { createHash } from "node:crypto";
import type {
  AccountRepository,
  OAuthCredential,
  SubscriptionAccount,
} from "@swisscode/core";

export function credentialIdentity(credential: OAuthCredential): string {
  return `sha256:${createHash("sha256").update(credential.refreshToken, "utf8").digest("hex")}`;
}

/**
 * Find the vault account holding this credential lineage, if any.
 * Same login under a different id is a duplicate — callers block re-import
 * and point at Re-import instead. Null when the login is new.
 */
export async function findAccountByCredential(
  vault: AccountRepository,
  credential: OAuthCredential,
): Promise<SubscriptionAccount | null> {
  const identity = credentialIdentity(credential);
  for (const account of await vault.list()) {
    const stored = await vault.loadCredential(account.id);
    if (stored && credentialIdentity(stored) === identity) return account;
  }
  return null;
}
