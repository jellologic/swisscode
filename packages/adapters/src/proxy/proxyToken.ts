// Adapter: the proxy's per-run control token.
//
// The proxy binds 127.0.0.1, but "localhost" is not an authorization boundary:
// any page in any browser on this machine can POST to it, and DNS rebinding can
// make it same-origin. A shared secret on disk (0600) is the cheap fix — only
// processes running as this user can read it, so a web page cannot forge the
// header even if it can reach the port.

import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../store/atomicJson.js";

/** Header the CLI and web UI send on proxy control requests. */
export const PROXY_TOKEN_HEADER = "x-swisscode-token";

/**
 * The token is echoed into an HTTP header, so only characters that cannot
 * terminate or inject a header line are accepted from disk.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;

/** ~/.swisscode/proxy-token (SWISSCODE_HOME override), next to the vault. */
export function defaultProxyTokenPath(): string {
  const base = process.env["SWISSCODE_HOME"] ?? join(homedir(), ".swisscode");
  return join(base, "proxy-token");
}

/**
 * Mint a fresh token and store it 0600, replacing any previous one.
 * Called once per proxy run: a token that outlives its server would keep
 * authorizing after the port is handed to something else.
 */
export async function createProxyToken(path: string = defaultProxyTokenPath()): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await writeFileAtomic(path, token + "\n", { mode: 0o600 });
  return token;
}

/**
 * Read the current token, or undefined when there is none to read (no proxy
 * has run, or the file is unreadable/garbage). Never throws: callers decide
 * whether a missing token is fatal.
 */
export async function readProxyToken(
  path: string = defaultProxyTokenPath(),
): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const token = raw.trim();
  return TOKEN_RE.test(token) ? token : undefined;
}
