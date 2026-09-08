// User-defined providers: the same ProviderPort shape as built-ins, declared
// as data and interpreted by the CustomProviderAdapter — no code to write.
// A definition says which config fields to collect and how they become env
// vars for the agent launch.

import type { FieldDef, PluginHelp } from "./domain.js";
import { isDeniedEnvName } from "./envPolicy.js";
import { ProfileError } from "./service.js";

/**
 * Declarative pre-save credential check for a custom provider.
 * The interpreter calls the endpoint and turns the status into a verdict —
 * customs get "test before save" with no code.
 */
export interface CustomProviderTest {
  /**
   * https URL probed to check the credentials, e.g. a key-info endpoint.
   * Must be a public host with no userinfo: swisscode itself makes this
   * request, so loopback/link-local/private targets are rejected at save time.
   */
  url: string;
  method?: "GET" | "POST";
  /** Request header carrying the credential. Default "Authorization". */
  headerName?: string;
  /** Config field whose value is sent. Omit for anonymous probes. */
  authField?: string;
  /** Prefix before the value, e.g. "Bearer ". Omitted = "Bearer ". */
  authScheme?: string;
  /** Expected status. Default: any 2xx. */
  expectStatus?: number;
}

export interface CustomProviderDef {
  /** Lowercase slug, e.g. "my-gateway". Must not shadow a built-in. */
  id: string;
  displayName: string;
  description?: string;
  /** Shown on /accounts next to the provider, like built-in hints. */
  hint?: string;
  /** Config schema collected on /accounts (same FieldDef as built-ins). */
  fields: FieldDef[];
  /** Pre-save credential check. Absent = no Test button for this provider. */
  test?: CustomProviderTest;
  /** Env vars always set for launches, e.g. { ANTHROPIC_BASE_URL: "…" }. */
  envStatic?: Record<string, string>;
  /** ENV_VAR -> config field key. Empty values are skipped. */
  envFromConfig?: Record<string, string>;
  /** Model env var, e.g. ANTHROPIC_MODEL. Value: profile model, else config. */
  modelEnvVar?: string;
  /** Config field holding the default model. Default "model". */
  modelConfigKey?: string;
  /** Same help DNA as built-in plugins, rendered on /help. */
  help?: PluginHelp;
  createdAt: string;
  updatedAt: string;
}

const PROVIDER_ID_RE = /^[a-z0-9-]+$/;
const FIELD_KEY_RE = /^[A-Za-z0-9_]+$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

function envName(value: unknown, what: string): void {
  if (typeof value !== "string" || !ENV_NAME_RE.test(value)) {
    throw new ProfileError(`Invalid env var name ${what}: ${JSON.stringify(value)}. Use A-Z, 0-9, _.`);
  }
  // A provider definition is data a user (or an imported bundle) supplies, and
  // these names are not configuration: they decide which binary runs and what
  // code it loads before main(). No provider ever needs them.
  if (isDeniedEnvName(value)) {
    throw new ProfileError(
      `Env var name ${what} is not allowed: "${value}" controls how the agent process loads code.`,
    );
  }
}

/** Dotted-quad only; the URL parser has already canonicalised other IPv4 forms. */
function parseIpv4(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    octets.push(n);
  }
  return octets;
}

function isPrivateIpv4(o: number[]): boolean {
  if (o[0] === 0) return true; // 0.0.0.0/8 "this network" — reaches localhost on many stacks
  if (o[0] === 127) return true; // loopback
  if (o[0] === 10) return true; // RFC1918
  if (o[0] === 172 && o[1]! >= 16 && o[1]! <= 31) return true; // RFC1918
  if (o[0] === 192 && o[1] === 168) return true; // RFC1918
  if (o[0] === 169 && o[1] === 254) return true; // link-local (cloud metadata)
  return false;
}

/** Expand an IPv6 literal into its eight 16-bit groups. undefined = not IPv6. */
function parseIpv6(host: string): number[] | undefined {
  if (!host.includes(":")) return undefined;
  const zone = host.indexOf("%"); // scope id, e.g. fe80::1%en0
  let text = zone >= 0 ? host.slice(0, zone) : host;
  const lastColon = text.lastIndexOf(":");
  const embedded = text.slice(lastColon + 1);
  if (embedded.includes(".")) {
    // ::ffff:127.0.0.1 — fold the trailing IPv4 into two hex groups.
    const v4 = parseIpv4(embedded);
    if (!v4) return undefined;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (part: string): number[] | undefined => {
    if (!part) return [];
    const out: number[] = [];
    for (const piece of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return undefined;
      out.push(parseInt(piece, 16));
    }
    return out;
  };
  const head = groups(halves[0] ?? "");
  const tail = groups(halves[1] ?? "");
  if (!head || !tail) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return undefined;
  return [...head, ...Array<number>(fill).fill(0), ...tail];
}

/**
 * True for hosts that only exist inside the machine or the private network.
 * A custom provider's test endpoint is fetched by swisscode itself, so an
 * attacker-supplied definition would otherwise turn "Test connection" into a
 * probe of localhost services and cloud metadata (169.254.169.254).
 * Names are taken literally: a pure validator cannot resolve DNS, so a hostname
 * that resolves to a private address is out of scope here.
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const v4 = parseIpv4(host);
  if (v4) return isPrivateIpv4(v4);
  const v6 = parseIpv6(host);
  if (!v6) return false;
  if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) {
    // IPv4-mapped: judge it by the address it actually carries.
    return isPrivateIpv4([v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff]);
  }
  if (v6.slice(0, 7).every((g) => g === 0) && v6[7]! <= 1) return true; // :: and ::1
  if ((v6[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((v6[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  return false;
}

export interface ValidateCustomOptions {
  /** Built-in ids the definition must not shadow. */
  reservedIds?: string[];
}

/** Throws ProfileError on the first problem (same style as validateProfile). */
export function validateCustomProviderDef(def: CustomProviderDef, opts: ValidateCustomOptions = {}): void {
  if (!def || typeof def !== "object") throw new ProfileError("Provider definition must be an object.");
  if (typeof def.id !== "string" || !PROVIDER_ID_RE.test(def.id)) {
    throw new ProfileError(`Invalid provider id ${JSON.stringify(def.id)}. Use lowercase letters, numbers, "-".`);
  }
  if (opts.reservedIds?.includes(def.id)) {
    throw new ProfileError(`Provider id "${def.id}" shadows a built-in provider. Pick another id.`);
  }
  if (typeof def.displayName !== "string" || !def.displayName.trim()) {
    throw new ProfileError("Provider displayName is required.");
  }
  if (!Array.isArray(def.fields)) throw new ProfileError("Provider fields must be a list.");
  const keys = new Set<string>();
  for (const f of def.fields) {
    if (!f || typeof f.key !== "string" || !FIELD_KEY_RE.test(f.key)) {
      throw new ProfileError(`Invalid field key ${JSON.stringify(f?.key)}. Use letters, numbers, _.`);
    }
    if (keys.has(f.key)) throw new ProfileError(`Duplicate field key "${f.key}".`);
    keys.add(f.key);
    if (typeof f.label !== "string" || !f.label.trim()) {
      throw new ProfileError(`Field "${f.key}" needs a label.`);
    }
  }
  for (const name of Object.keys(def.envStatic ?? {})) envName(name, `(static) "${name}"`);
  for (const [name, fieldKey] of Object.entries(def.envFromConfig ?? {})) {
    envName(name, `(mapping) "${name}"`);
    if (!keys.has(fieldKey)) {
      throw new ProfileError(`Env mapping "${name}" points at unknown field "${fieldKey}".`);
    }
  }
  if (def.modelEnvVar !== undefined) envName(def.modelEnvVar, `(model) "${def.modelEnvVar}"`);
  if (def.modelConfigKey !== undefined && !keys.has(def.modelConfigKey)) {
    throw new ProfileError(`modelConfigKey "${def.modelConfigKey}" is not a defined field.`);
  }
  const test = def.test;
  if (test !== undefined) {
    if (!test || typeof test.url !== "string" || !/^https:\/\//.test(test.url)) {
      throw new ProfileError("test.url must be an https URL.");
    }
    let url: URL;
    try {
      url = new URL(test.url);
    } catch {
      throw new ProfileError(`test.url is not a valid URL: ${JSON.stringify(test.url)}`);
    }
    if (url.username || url.password) {
      throw new ProfileError("test.url must not embed a username or password. Use test.authField.");
    }
    if (isPrivateHost(url.hostname)) {
      throw new ProfileError(
        `test.url host "${url.hostname}" is a loopback, link-local or private address. Point the test at a public endpoint.`,
      );
    }
    if (test.method !== undefined && test.method !== "GET" && test.method !== "POST") {
      throw new ProfileError('test.method must be "GET" or "POST".');
    }
    if (test.headerName !== undefined && !/^[A-Za-z0-9-]+$/.test(test.headerName)) {
      throw new ProfileError(`Invalid test header name "${test.headerName}".`);
    }
    if (test.authField !== undefined && !keys.has(test.authField)) {
      throw new ProfileError(`test.authField "${test.authField}" is not a defined field.`);
    }
    if (
      test.expectStatus !== undefined &&
      (!Number.isInteger(test.expectStatus) || test.expectStatus < 200 || test.expectStatus > 599)
    ) {
      throw new ProfileError("test.expectStatus must be an HTTP status (200-599).");
    }
  }
  for (const link of def.help?.links ?? []) {
    if (typeof link?.href !== "string" || !/^https:\/\//.test(link.href)) {
      throw new ProfileError(`Help link "${link?.label ?? ""}" must be an https URL.`);
    }
  }
}
