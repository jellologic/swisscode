// Runtime shape guards for records that arrive from OUTSIDE this process:
// an imported config bundle, a hand-edited store file, a web form payload.
// The type system stops at the process boundary; these guards restart it.
//
// Rules: structural only (a guard says "the fields have the right types", not
// "the value is usable" — emptiness, id syntax and cross-references stay with
// validateProfile/validateAccountId), and NEVER throw. A malformed record is
// data, so callers can report it per record instead of losing the whole import.

import type { Profile } from "./domain.js";
import type { OAuthCredential, ProviderAccount, SubscriptionAccount } from "./subscriptions.js";
import type { SubscriptionBackup } from "./configBundle.js";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isOptionalString(x: unknown): boolean {
  return x === undefined || typeof x === "string";
}

function isOptionalStringArray(x: unknown): boolean {
  return x === undefined || (Array.isArray(x) && x.every((v) => typeof v === "string"));
}

/** Record<string,string> with no nested objects — what env mapping assumes. */
function isOptionalStringRecord(x: unknown): boolean {
  return x === undefined || isStringRecord(x);
}

function isStringRecord(x: unknown): boolean {
  return isRecord(x) && Object.values(x).every((v) => typeof v === "string");
}

/** Timestamps are re-stamped by every repository save, so absent is tolerated. */
function hasValidTimestamps(rec: Record<string, unknown>): boolean {
  return isOptionalString(rec["createdAt"]) && isOptionalString(rec["updatedAt"]);
}

export function isProfileShape(x: unknown): x is Profile {
  if (!isRecord(x)) return false;
  return (
    typeof x["name"] === "string" &&
    typeof x["agentId"] === "string" &&
    typeof x["providerId"] === "string" &&
    isOptionalStringArray(x["agentArgs"]) &&
    isOptionalStringRecord(x["providerConfig"]) &&
    isOptionalString(x["model"]) &&
    (x["useProxy"] === undefined || typeof x["useProxy"] === "boolean") &&
    isOptionalString(x["subscriptionAccountId"]) &&
    isOptionalString(x["providerAccountId"])
  );
}

export function isProviderAccountShape(x: unknown): x is ProviderAccount {
  if (!isRecord(x)) return false;
  return (
    typeof x["id"] === "string" &&
    typeof x["providerId"] === "string" &&
    typeof x["label"] === "string" &&
    isStringRecord(x["config"]) &&
    hasValidTimestamps(x)
  );
}

export function isSubscriptionAccountShape(x: unknown): x is SubscriptionAccount {
  if (!isRecord(x)) return false;
  return (
    typeof x["id"] === "string" &&
    typeof x["label"] === "string" &&
    isOptionalString(x["email"]) &&
    hasValidTimestamps(x)
  );
}

export function isOAuthCredentialShape(x: unknown): x is OAuthCredential {
  if (!isRecord(x)) return false;
  return (
    typeof x["accessToken"] === "string" &&
    typeof x["refreshToken"] === "string" &&
    (x["expiresAt"] === undefined ||
      (typeof x["expiresAt"] === "number" && Number.isFinite(x["expiresAt"]))) &&
    isOptionalStringArray(x["scopes"]) &&
    (x["extra"] === undefined || isRecord(x["extra"]))
  );
}

/** A bundle entry: account metadata plus the credential (absent = secrets stripped). */
export function isSubscriptionBackupShape(x: unknown): x is SubscriptionBackup {
  if (!isRecord(x)) return false;
  if (!isSubscriptionAccountShape(x["account"])) return false;
  return x["credential"] === undefined || isOAuthCredentialShape(x["credential"]);
}
