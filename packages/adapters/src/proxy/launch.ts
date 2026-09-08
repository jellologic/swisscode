// Launch-side proxy wiring: which env a proxied profile actually spawns with.
// The CLI launch path and the web Preview modal share this so an inspection
// can never describe a launch that would not happen.

import type { Profile } from "@swisscode/core";
import { proxyBaseUrl } from "../paths.js";

/**
 * Proxy routing is a profile-only decision: every profile launches through
 * the proxy unless it opts out with `direct: true`. That covers key
 * providers too — their upstream env resolves proxy-side via buildEnv.
 * `useProxy` is legacy (kept on stored profiles, no longer read).
 */
export function usesProxy(profile: Pick<Profile, "direct">): boolean {
  return profile.direct !== true;
}

/**
 * The env a launch actually applies. Proxy mode: the agent talks to
 * <proxy>/p/<profileName> so the proxy knows the profile without trusting a
 * header alone; ANTHROPIC_AUTH_TOKEN carries the same name as a fallback tag
 * (read for traffic attribution, then discarded). Profile names pass
 * validateProfileName (letters/digits/-/_), so the path segment is safe.
 */
export function proxyLaunchEnv(
  profile: Pick<Profile, "name" | "direct">,
  env: Record<string, string>,
): Record<string, string> {
  if (!usesProxy(profile)) return env;
  return {
    ...env,
    ANTHROPIC_BASE_URL: `${proxyBaseUrl()}/p/${profile.name}`,
    ANTHROPIC_AUTH_TOKEN: `swisscode-profile/${profile.name}`,
  };
}
