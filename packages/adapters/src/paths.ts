// Adapter: where swisscode's runtime artefacts live, and which port the proxy
// answers on. Split out of index.ts so a module can resolve the proxy's base
// URL without importing the package barrel (which would import that module
// straight back).

import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_PROXY_PORT } from "./proxy/server.js";

/** Default JSONL traffic log next to the vault: ~/.swisscode/proxy-traffic.jsonl. */
export function defaultTrafficLogPath(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "proxy-traffic.jsonl");
}

/** Proxy port: SWISSCODE_PROXY_PORT override, else the default. */
export function proxyPort(explicit?: number | string): number {
  const raw = explicit ?? process.env["SWISSCODE_PROXY_PORT"];
  const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && (n as number) > 0 ? (n as number) : DEFAULT_PROXY_PORT;
}

/** Base URL for a proxy on the given port. */
export function proxyBaseUrl(port?: number | string): string {
  return `http://127.0.0.1:${proxyPort(port)}`;
}
