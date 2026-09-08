// Provider-account config rules shared by the save path and the launch preview.
// Pure: the store owns the I/O, this owns the decisions.

import { DEFAULT_SECRET_NAME_RE, maskSecretValue, type FieldDef } from "@swisscode/core";

/**
 * Seed values for the edit form. The summary the page loads carries MASKED
 * secrets ("sk-1…9f"); leaving them in the inputs makes the mask the value the
 * form submits. Declared secret fields therefore start empty, which is exactly
 * the case mergeAccountConfig reads as "keep the stored secret".
 */
export function blankSecrets(
  config: Record<string, string>,
  fields: readonly FieldDef[],
): Record<string, string> {
  const secretKeys = new Set(fields.filter((f) => f.secret).map((f) => f.key));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = secretKeys.has(key) ? "" : value;
  }
  return out;
}

/**
 * Merge a submitted patch onto the stored config.
 *
 * Three rules, in order:
 *  - a value equal to the mask the UI showed means the user never retyped the
 *    secret. Storing it would overwrite the real API key with "sk-1…9f" — the
 *    account then fails every request and the key is gone from disk;
 *  - blank on a secret field keeps the stored secret (that is what the edit
 *    form's "blank keeps stored" hint promises);
 *  - blank on anything else clears the field.
 */
export function mergeAccountConfig(
  prev: Record<string, string>,
  patch: Record<string, string> | undefined,
  secretKeys: ReadonlySet<string>,
): Record<string, string> {
  const config = { ...prev };
  for (const [key, value] of Object.entries(patch ?? {})) {
    const stored = prev[key];
    if (stored !== undefined && stored !== "" && value === maskSecretValue(stored)) continue;
    if (value === "" && secretKeys.has(key)) continue;
    if (value === "") delete config[key];
    else config[key] = value;
  }
  return config;
}

/**
 * The secret VALUES in a config, for value-based redaction.
 *
 * Name-based redaction alone leaks: a custom provider is free to map its
 * `token` field to `MY_PASSWORD`, or to anything else. Feeding the actual
 * stored values to redactEnv masks the secret wherever it landed. A field
 * counts as secret when the provider declared it so, or when its key reads
 * like one — the same widened pattern redactEnv falls back to.
 */
export function collectSecretValues(
  config: Record<string, string> | undefined,
  secretKeys: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(config ?? {})) {
    if (!value) continue;
    if (secretKeys.has(key) || DEFAULT_SECRET_NAME_RE.test(key)) out.push(value);
  }
  return out;
}
