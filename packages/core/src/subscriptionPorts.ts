// Subscription ports. Implemented by adapters; orchestrated by CLI/UI.

import type {
  AccountUsage,
  ActiveCredentialState,
  OAuthCredential,
  SubscriptionAccount,
} from "./subscriptions.js";

export class OAuthError extends Error {
  readonly kind: "invalid_grant" | "no_refresh_token" | "transient";
  constructor(kind: OAuthError["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Port: swisscode-side vault for subscription accounts (0600 file store). */
export interface AccountRepository {
  list(): Promise<SubscriptionAccount[]>;
  get(id: string): Promise<SubscriptionAccount | undefined>;
  /** Insert or replace metadata + secret together. */
  save(account: SubscriptionAccount, credential: OAuthCredential): Promise<void>;
  loadCredential(id: string): Promise<OAuthCredential | undefined>;
  saveCredential(id: string, credential: OAuthCredential): Promise<void>;
  remove(id: string): Promise<boolean>;
}

/**
 * Port: Claude Code's OWN credential store (file or macOS Keychain).
 * Import reads from here; file-swap switch writes here.
 */
export interface ActiveCredentialStore {
  readActive(): Promise<ActiveCredentialState>;
  writeActive(credential: OAuthCredential): Promise<void>;
}

/** Port: OAuth token refresh against the Anthropic token endpoint. */
export interface OAuthClient {
  /** Rotates the credential; carries `extra` fields forward onto the result. */
  refresh(credential: OAuthCredential): Promise<OAuthCredential>;
}

/** Port: usage/limits reader against the Anthropic usage endpoint. */
export interface UsageClient {
  fetchUsage(accountId: string, accessToken: string): Promise<AccountUsage>;
}
