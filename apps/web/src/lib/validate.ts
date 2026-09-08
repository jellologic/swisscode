// Runtime validation for every server function that takes input.
//
// A `createServerFn` validator is the process boundary: the payload arrived
// over HTTP, so the declared TypeScript type says nothing about what is
// actually there. An identity cast lets a hand-written POST reach the vault,
// the Keychain and the proxy with values no store ever expected (a size of
// "abc" became /size/NaN and was proxied upstream). Everything here is a real
// check, it runs BEFORE any I/O, and it mirrors the syntax rules the stores
// already enforce so the UI fails the same way the CLI does.
//
// Messages name the field and the expectation but never echo the value —
// these payloads carry API keys.

import { RECORD_ID_RE, isRecord, profileShapeProblem, type Profile } from "@swisscode/core";

/** Rejected input. Typed like ProfileError/OAuthError so callers can tell it apart. */
export class InputError extends Error {
  readonly field: string;

  constructor(field: string, expectation: string) {
    super(`Invalid input: ${field} ${expectation}.`);
    this.name = "InputError";
    this.field = field;
  }
}

/** Stored-record ids: literally core's rule, so the UI and the stores agree. */
export const ID_RE = RECORD_ID_RE;

/** Model ids are vendor strings ("anthropic/claude-sonnet-4.5"), not record ids. */
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

/** Free text cap: an unbounded string would be buffered before any store sees it. */
const MAX_TEXT = 4096;
const MAX_ID = 128;
const MAX_LIST = 500;
const MAX_MAP_KEYS = 200;

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new InputError(field, "must be an object");
  return value;
}

export function text(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string") throw new InputError(field, "must be a string");
  if (value.length > max) throw new InputError(field, `must be at most ${max} characters`);
  return value;
}

export function nonEmptyText(value: unknown, field: string, max = MAX_TEXT): string {
  const out = text(value, field, max);
  if (!out.trim()) throw new InputError(field, "must not be empty");
  return out;
}

export function optionalText(value: unknown, field: string, max = MAX_TEXT): string | undefined {
  return value === undefined ? undefined : text(value, field, max);
}

export function identifier(value: unknown, field: string): string {
  const out = text(value, field, MAX_ID).trim();
  if (!ID_RE.test(out)) {
    throw new InputError(field, 'must start with a letter or digit and use only letters, digits, "-" or "_"');
  }
  return out;
}

export function optionalIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : identifier(value, field);
}

export function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new InputError(field, "must be true or false");
  return value;
}

export function optionalFlag(value: unknown, field: string): boolean | undefined {
  return value === undefined ? undefined : flag(value, field);
}

/** A count: a real finite integer ≥ 0 ("abc" and NaN are rejected, not coerced). */
export function count(value: unknown, field: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new InputError(field, "must be a whole number");
  }
  if (value < 0) throw new InputError(field, "must not be negative");
  if (value > max) throw new InputError(field, `must be at most ${max}`);
  return value;
}

/** Record<string,string> only — a nested object here 500s four routes later. */
export function stringMap(value: unknown, field: string): Record<string, string> {
  const rec = asRecord(value, field);
  const keys = Object.keys(rec);
  if (keys.length > MAX_MAP_KEYS) throw new InputError(field, `must have at most ${MAX_MAP_KEYS} keys`);
  const out: Record<string, string> = {};
  for (const key of keys) out[key] = text(rec[key], `${field}.${key}`);
  return out;
}

export function optionalStringMap(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  return value === undefined ? undefined : stringMap(value, field);
}

export function identifierList(value: unknown, field: string, max = MAX_LIST): string[] {
  if (!Array.isArray(value)) throw new InputError(field, "must be a list");
  if (value.length > max) throw new InputError(field, `must have at most ${max} entries`);
  return value.map((entry, i) => identifier(entry, `${field}[${i}]`));
}

// ---- Per-function parsers (one per server fn that takes input) ----

/**
 * A whole profile submitted by the form. Deep rules stay in validateProfile;
 * the shape check (and the sentence naming the bad field) is core's, so the
 * form and the store reject the same payloads for the same stated reason.
 */
export function parseProfile(data: unknown): Profile {
  const problem = profileShapeProblem(data);
  if (problem !== undefined) throw new InputError("profile", `is invalid — ${problem}`);
  return data as Profile;
}

export function parseProfileRef(data: unknown): { name: string } {
  const rec = asRecord(data, "data");
  return { name: identifier(rec["name"], "name") };
}

/** Blank id is legal: importAccount derives it from the login's email. */
export function parseImportAccount(data: unknown): {
  id: string;
  label?: string;
  overwrite?: boolean;
} {
  const rec = asRecord(data, "data");
  const raw = text(rec["id"], "id", MAX_ID).trim();
  const id = raw === "" ? "" : identifier(raw, "id");
  const label = optionalText(rec["label"], "label", MAX_ID);
  const overwrite = optionalFlag(rec["overwrite"], "overwrite");
  return {
    id,
    ...(label === undefined ? {} : { label }),
    ...(overwrite === undefined ? {} : { overwrite }),
  };
}

export function parseAccountRef(data: unknown): { id: string } {
  const rec = asRecord(data, "data");
  return { id: identifier(rec["id"], "id") };
}

export function parseRenameAccount(data: unknown): { id: string; label: string } {
  const rec = asRecord(data, "data");
  return { id: identifier(rec["id"], "id"), label: text(rec["label"], "label", MAX_ID) };
}

export function parseSwitchAccount(data: unknown): { id: string; force?: boolean } {
  const rec = asRecord(data, "data");
  const force = optionalFlag(rec["force"], "force");
  return { id: identifier(rec["id"], "id"), ...(force === undefined ? {} : { force }) };
}

export function parseAccountUsage(data: unknown): { ids?: string[] } {
  const rec = asRecord(data, "data");
  if (rec["ids"] === undefined) return {};
  return { ids: identifierList(rec["ids"], "ids", 100) };
}

export function parseProviderRef(data: unknown): { providerId: string } {
  const rec = asRecord(data, "data");
  return { providerId: identifier(rec["providerId"], "providerId") };
}

export function parseOptionalProviderRef(data: unknown): { providerId?: string } {
  const rec = asRecord(data, "data");
  const providerId = optionalIdentifier(rec["providerId"], "providerId");
  return providerId === undefined ? {} : { providerId };
}

export function parseModelRef(data: unknown): { providerId: string; modelId: string } {
  const rec = asRecord(data, "data");
  const modelId = nonEmptyText(rec["modelId"], "modelId", 256);
  if (!MODEL_RE.test(modelId)) throw new InputError("modelId", "must be a model identifier");
  return { providerId: identifier(rec["providerId"], "providerId"), modelId };
}

export function parseProviderAccountRef(data: unknown): { providerId: string; id: string } {
  const rec = asRecord(data, "data");
  return {
    providerId: identifier(rec["providerId"], "providerId"),
    id: identifier(rec["id"], "id"),
  };
}

export function parseSaveProviderAccount(data: unknown): {
  providerId: string;
  id: string;
  label: string;
  config: Record<string, string>;
} {
  const rec = asRecord(data, "data");
  return {
    providerId: identifier(rec["providerId"], "providerId"),
    id: identifier(rec["id"], "id"),
    label: text(rec["label"], "label", MAX_ID),
    config: stringMap(rec["config"], "config"),
  };
}

export function parseUpdateProviderAccount(data: unknown): {
  providerId: string;
  id: string;
  label?: string;
  config?: Record<string, string>;
} {
  const rec = asRecord(data, "data");
  const label = optionalText(rec["label"], "label", MAX_ID);
  const config = optionalStringMap(rec["config"], "config");
  return {
    providerId: identifier(rec["providerId"], "providerId"),
    id: identifier(rec["id"], "id"),
    ...(label === undefined ? {} : { label }),
    ...(config === undefined ? {} : { config }),
  };
}

export function parseValidateProviderAccount(data: unknown): {
  providerId: string;
  config: Record<string, string>;
} {
  const rec = asRecord(data, "data");
  return {
    providerId: identifier(rec["providerId"], "providerId"),
    config: stringMap(rec["config"], "config"),
  };
}

/** Profile tags are launch labels, not ids — any text, bounded. */
export function parseTrafficFilter(data: unknown): { profile?: string } {
  const rec = asRecord(data, "data");
  const profile = optionalText(rec["profile"], "profile", MAX_ID);
  return profile === undefined ? {} : { profile };
}

export function parseTrafficSize(data: unknown): { size: number } {
  const rec = asRecord(data, "data");
  return { size: count(rec["size"], "size", 1_000_000) };
}

export function parseTrafficEntryRefs(data: unknown): { ids: string[] } {
  const rec = asRecord(data, "data");
  return { ids: identifierList(rec["ids"], "ids") };
}

export function parseSessionRef(data: unknown): { sessionId: string } {
  const rec = asRecord(data, "data");
  return { sessionId: identifier(rec["sessionId"], "sessionId") };
}

/** Secrets ship only when the caller asks in this request — never by default. */
export function parseExportBundle(data: unknown): { includeSecrets: boolean } {
  if (data === undefined) return { includeSecrets: false };
  const rec = asRecord(data, "data");
  return { includeSecrets: optionalFlag(rec["includeSecrets"], "includeSecrets") ?? false };
}

/** The bundle body stays unknown: importBundle validates it per record. */
export function parseImportBundle(data: unknown): { bundle: unknown; overwrite: boolean } {
  const rec = asRecord(data, "data");
  if (!("bundle" in rec)) throw new InputError("bundle", "is required");
  return { bundle: rec["bundle"], overwrite: flag(rec["overwrite"], "overwrite") };
}

export interface CustomFieldInput {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder?: string;
  help?: string;
}

export interface CustomProviderInput {
  id: string;
  displayName: string;
  description?: string;
  hint?: string;
  fields: CustomFieldInput[];
  envStatic?: Record<string, string>;
  envFromConfig?: Record<string, string>;
  modelEnvVar?: string;
  modelConfigKey?: string;
  test?: {
    url: string;
    method?: "GET" | "POST";
    headerName?: string;
    authField?: string;
    authScheme?: string;
    expectStatus?: number;
  };
  help?: {
    summary?: string;
    setup?: string[];
    commands?: string[];
    links?: { label: string; href: string }[];
  };
}

function textList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new InputError(field, "must be a list");
  if (value.length > MAX_LIST) throw new InputError(field, `must have at most ${MAX_LIST} entries`);
  return value.map((entry, i) => text(entry, `${field}[${i}]`));
}

/**
 * Structural check only. The semantic rules (id syntax, env var names, https
 * test URL, field cross-references) live in core's validateCustomProviderDef,
 * which runs on save — duplicating them here would let the two drift.
 */
export function parseCustomProvider(data: unknown): CustomProviderInput {
  const rec = asRecord(data, "data");
  const rawFields = rec["fields"];
  if (!Array.isArray(rawFields)) throw new InputError("fields", "must be a list");
  if (rawFields.length > MAX_MAP_KEYS) {
    throw new InputError("fields", `must have at most ${MAX_MAP_KEYS} entries`);
  }
  const fields = rawFields.map((raw, i): CustomFieldInput => {
    const f = asRecord(raw, `fields[${i}]`);
    const placeholder = optionalText(f["placeholder"], `fields[${i}].placeholder`, MAX_ID);
    const help = optionalText(f["help"], `fields[${i}].help`);
    return {
      key: nonEmptyText(f["key"], `fields[${i}].key`, MAX_ID),
      label: nonEmptyText(f["label"], `fields[${i}].label`, MAX_ID),
      secret: flag(f["secret"], `fields[${i}].secret`),
      required: flag(f["required"], `fields[${i}].required`),
      ...(placeholder === undefined ? {} : { placeholder }),
      ...(help === undefined ? {} : { help }),
    };
  });

  const description = optionalText(rec["description"], "description");
  const hint = optionalText(rec["hint"], "hint");
  const envStatic = optionalStringMap(rec["envStatic"], "envStatic");
  const envFromConfig = optionalStringMap(rec["envFromConfig"], "envFromConfig");
  const modelEnvVar = optionalText(rec["modelEnvVar"], "modelEnvVar", MAX_ID);
  const modelConfigKey = optionalText(rec["modelConfigKey"], "modelConfigKey", MAX_ID);

  let test: CustomProviderInput["test"];
  if (rec["test"] !== undefined) {
    const t = asRecord(rec["test"], "test");
    const method = optionalText(t["method"], "test.method", MAX_ID);
    if (method !== undefined && method !== "GET" && method !== "POST") {
      throw new InputError("test.method", 'must be "GET" or "POST"');
    }
    const headerName = optionalText(t["headerName"], "test.headerName", MAX_ID);
    const authField = optionalText(t["authField"], "test.authField", MAX_ID);
    const authScheme = optionalText(t["authScheme"], "test.authScheme", MAX_ID);
    const expectStatus =
      t["expectStatus"] === undefined ? undefined : count(t["expectStatus"], "test.expectStatus", 599);
    test = {
      url: nonEmptyText(t["url"], "test.url", 2048),
      ...(method === undefined ? {} : { method }),
      ...(headerName === undefined ? {} : { headerName }),
      ...(authField === undefined ? {} : { authField }),
      ...(authScheme === undefined ? {} : { authScheme }),
      ...(expectStatus === undefined ? {} : { expectStatus }),
    };
  }

  let help: CustomProviderInput["help"];
  if (rec["help"] !== undefined) {
    const h = asRecord(rec["help"], "help");
    const summary = optionalText(h["summary"], "help.summary");
    const setup = textList(h["setup"], "help.setup");
    const commands = textList(h["commands"], "help.commands");
    let links: { label: string; href: string }[] | undefined;
    if (h["links"] !== undefined) {
      if (!Array.isArray(h["links"])) throw new InputError("help.links", "must be a list");
      links = h["links"].map((raw, i) => {
        const link = asRecord(raw, `help.links[${i}]`);
        return {
          label: text(link["label"], `help.links[${i}].label`, MAX_ID),
          href: text(link["href"], `help.links[${i}].href`, 2048),
        };
      });
    }
    help = {
      ...(summary === undefined ? {} : { summary }),
      ...(setup === undefined ? {} : { setup }),
      ...(commands === undefined ? {} : { commands }),
      ...(links === undefined ? {} : { links }),
    };
  }

  return {
    id: nonEmptyText(rec["id"], "id", MAX_ID),
    displayName: nonEmptyText(rec["displayName"], "displayName", MAX_ID),
    fields,
    ...(description === undefined ? {} : { description }),
    ...(hint === undefined ? {} : { hint }),
    ...(envStatic === undefined ? {} : { envStatic }),
    ...(envFromConfig === undefined ? {} : { envFromConfig }),
    ...(modelEnvVar === undefined ? {} : { modelEnvVar }),
    ...(modelConfigKey === undefined ? {} : { modelConfigKey }),
    ...(test === undefined ? {} : { test }),
    ...(help === undefined ? {} : { help }),
  };
}
