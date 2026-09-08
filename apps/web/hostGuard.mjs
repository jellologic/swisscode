// Host policy for the production server (see server.mjs).
//
// This UI reads the vault, the Keychain and every stored API key with no login
// of its own: reaching the port IS the authorization. Two holes followed from
// that. Listening on 0.0.0.0 published it to the LAN, and building the request
// URL from the Host header let a spoofed Host+Origin pair look same-origin to
// the framework's CSRF check — a page on another machine could then drive a
// bundle export. So: bind loopback, and refuse any request whose Host is not
// one this server is meant to answer for.
//
// Plain JS: server.mjs runs straight from node with no build step. Its ONE
// import is the loopback test, which the proxy already owns — two copies of
// that regex is two chances for one of them to drift into accepting a name
// this process should never answer for.

import { isLoopbackHost } from "@swisscode/adapters";

/** Wildcards say "bind everywhere"; they are not a name a client can send. */
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]", ""]);

/** Interface the server binds. Loopback unless SWISSCODE_WEB_HOST says otherwise. */
export function webHost(env = process.env) {
  const configured = (env.SWISSCODE_WEB_HOST ?? "").trim();
  return configured === "" ? "127.0.0.1" : configured;
}

/**
 * True when `host` (a raw Host header) is one we answer for: always loopback,
 * plus the explicitly configured bind address, so an operator who opted into
 * SWISSCODE_WEB_HOST=192.168.1.5 can still reach it by that name.
 */
export function isAllowedHost(host, configuredHost = webHost()) {
  if (typeof host !== "string") return false;
  const value = host.trim().toLowerCase();
  if (value === "") return false;
  if (isLoopbackHost(value)) return true;
  const configured = String(configuredHost ?? "").trim().toLowerCase();
  if (WILDCARD_HOSTS.has(configured)) return false;
  // Same host, with or without the port we are serving on.
  return value.replace(/:\d{1,5}$/, "") === configured;
}
