// Adapter: hand a rotation back to Claude Code when it shares the lineage.
//
// Refresh tokens are single-use. The instant swisscode refreshes a token that
// Claude Code's own store also holds, Claude Code's copy is dead: its next
// refresh answers invalid_grant and the user is logged out of an editor they
// never asked us to touch. Whoever spends the token therefore owes the other
// owner the result.
//
// That is why the mirror hangs off the ROTATION (AnthropicOAuthClient.refresh)
// and not off one caller: the web UI drives core's `ensureFreshCredential`
// directly, the proxy and CLI go through freshVaultCredential, and the resync
// path refreshes Claude's own credential. All three spend the same kind of
// token, and only one of them knows this file exists.
//
// The write is the narrowest one possible: only when Claude's store STILL
// holds the exact refresh token we just spent. A different lineage is somebody
// else's login and is never written; an unreadable store is left alone; a
// refused write is a warning, because the rotation already happened and the
// vault holds the usable copy.

import type { ActiveCredentialStore, OAuthCredential } from "@swisscode/core";
import { ClaudeActiveCredentialStore } from "./activeStore.js";

let platformStore: ActiveCredentialStore | undefined;

/**
 * Process-wide handle on Claude Code's own store. Built lazily: callers that
 * disable the mirror (hermetic tests) must not even resolve CLAUDE_CONFIG_DIR.
 */
export function defaultLiveStore(): ActiveCredentialStore {
  return (platformStore ??= new ClaudeActiveCredentialStore());
}

/**
 * Mirror target for an option value: the platform store unless the caller
 * explicitly opted out with `null` ("this rotation cannot be shared, or the
 * mirror is already handled one layer up").
 */
export function resolveLiveStore(
  option: ActiveCredentialStore | null | undefined,
): ActiveCredentialStore | undefined {
  if (option === null) return undefined;
  return option ?? defaultLiveStore();
}

/**
 * Write `next` into Claude Code's store when it still holds `previous`.
 * Returns true only when the mirror actually wrote. Never throws: see the
 * header — the caller's credential is already good either way.
 */
export async function mirrorRotatedCredential(
  live: ActiveCredentialStore | undefined,
  previous: OAuthCredential,
  next: OAuthCredential,
  onWarning?: (message: string) => void,
): Promise<boolean> {
  if (!live || !previous.refreshToken) return false;
  // Nothing was spent, so nothing is owed.
  if (previous.refreshToken === next.refreshToken) return false;
  const active = await live.readActive().catch(() => undefined);
  // Not the lineage we rotated: either somebody else's login (never ours to
  // move) or a copy an inner layer already mirrored (already holds `next`).
  if (active?.credential?.refreshToken !== previous.refreshToken) return false;
  try {
    await live.writeActive(next);
    return true;
  } catch (err) {
    onWarning?.(
      `Refreshed the login shared with Claude Code but could not write it back ` +
        `(${(err as Error).message}). Run \`claude login\` if Claude Code stops working.`,
    );
    return false;
  }
}
