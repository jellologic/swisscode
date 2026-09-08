// User-defined providers: the same ProviderPort shape as built-ins, declared
// as data and interpreted by the CustomProviderAdapter — no code to write.
// A definition says which config fields to collect and how they become env
// vars for the agent launch.

import type { FieldDef, PluginHelp } from "./domain.js";
import { ProfileError } from "./service.js";

/**
 * Declarative pre-save credential check for a custom provider.
 * The interpreter calls the endpoint and turns the status into a verdict —
 * customs get "test before save" with no code.
 */
export interface CustomProviderTest {
  /** https URL probed to check the credentials, e.g. a key-info endpoint. */
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
