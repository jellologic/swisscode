// Credential identity: match "currently logged in" against the vault
// without ever comparing secret values in the clear. sha256 over the
// refresh token survives access-token rotation within one OAuth lineage.

import { createHash } from "node:crypto";
import type { OAuthCredential } from "@swisscode/core";

export function credentialIdentity(credential: OAuthCredential): string {
  return `sha256:${createHash("sha256").update(credential.refreshToken, "utf8").digest("hex")}`;
}
