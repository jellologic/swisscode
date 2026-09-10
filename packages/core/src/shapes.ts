// Runtime shape guards for records that arrive from OUTSIDE this process:
// an imported config bundle, a hand-edited store file, a web form payload.
// The type system stops at the process boundary; these guards restart it.
//
// Rules: structural only (a guard says "the fields have the right types", not
// "the value is usable" — emptiness, id syntax and cross-references stay with
// validateProfile/validateAccountId), and NEVER throw. A malformed record is
// data, so callers can report it per record instead of losing the whole import.

import type { GlobalSettings, Profile } from "./domain.js";
import type { OAuthCredential, ProviderAccount, SubscriptionAccount } from "./subscriptions.js";
import type { SubscriptionBackup } from "./configBundle.js";

/**
 * A plain object: not null, not an array. The foundation every other guard
 * (and every store, form parser and cache reader) stands on, so it is exported
 * rather than re-typed at each boundary.
 */
export function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Record<string,string> with no nested objects — what env mapping assumes. */
export function isStringRecord(x: unknown): x is Record<string, string> {
  return isRecord(x) && Object.values(x).every((v) => typeof v === "string");
}

function isOptionalString(x: unknown): boolean {
  return x === undefined || typeof x === "string";
}

function isOptionalStringArray(x: unknown): boolean {
  return x === undefined || (Array.isArray(x) && x.every((v) => typeof v === "string"));
}

function isOptionalStringRecord(x: unknown): boolean {
  return x === undefined || isStringRecord(x);
}

/** Structural only: kind values and cross-field pairing stay with validateModelRoutes. */
function isModelRouteShape(x: unknown): boolean {
  if (!isRecord(x)) return false;
  if (typeof x["match"] !== "string" || typeof x["kind"] !== "string") return false;
  return (
    isOptionalString(x["subscriptionAccountId"]) &&
    isOptionalString(x["providerId"]) &&
    isOptionalString(x["providerAccountId"]) &&
    isOptionalString(x["upstreamModel"])
  );
}

function isOptionalModelRouteArray(x: unknown): boolean {
  return x === undefined || (Array.isArray(x) && x.every(isModelRouteShape));
}

/**
 * Structural only: every session field optional with the right primitive
 * type. Enum membership, non-blank entries and inline-JSON parseability are
 * value judgements — they stay with validateSessionOptions.
 */
function isClaudeSessionOptionsShape(x: unknown): boolean {
  if (x === undefined) return true;
  if (!isRecord(x)) return false;
  return (
    isOptionalString(x["effort"]) &&
    isOptionalString(x["permissionMode"]) &&
    isOptionalStringArray(x["allowedTools"]) &&
    isOptionalStringArray(x["disallowedTools"]) &&
    isOptionalString(x["tools"]) &&
    isOptionalStringArray(x["addDirs"]) &&
    isOptionalString(x["systemPrompt"]) &&
    isOptionalString(x["appendSystemPrompt"]) &&
    isOptionalString(x["promptPreset"]) &&
    isOptionalString(x["agent"]) &&
    isOptionalString(x["mcpConfig"]) &&
    (x["strictMcp"] === undefined || typeof x["strictMcp"] === "boolean") &&
    isOptionalStringArray(x["settingSources"]) &&
    isOptionalStringArray(x["fallbackModel"]) &&
    (x["claudeSettings"] === undefined || isRecord(x["claudeSettings"]))
  );
}

/** Timestamps are re-stamped by every repository save, so absent is tolerated. */
function hasValidTimestamps(rec: Record<string, unknown>): boolean {
  return isOptionalString(rec["createdAt"]) && isOptionalString(rec["updatedAt"]);
}

/**
 * One rule per profile field: the predicate that accepts it and the sentence
 * that explains a rejection. Accept/reject and the diagnosis therefore come
 * from a single list — a second hand-written copy of these predicates (there
 * used to be one in service.ts) drifts the moment a field is added.
 */
const PROFILE_RULES: readonly { key: string; ok: (v: unknown) => boolean; problem: string }[] = [
  { key: "name", ok: (v) => typeof v === "string", problem: "profile.name must be a string." },
  { key: "agentId", ok: (v) => typeof v === "string", problem: "profile.agentId must be a string." },
  { key: "providerId", ok: (v) => typeof v === "string", problem: "profile.providerId must be a string." },
  {
    key: "agentArgs",
    ok: isOptionalStringArray,
    problem: "profile.agentArgs must be an array of strings.",
  },
  {
    key: "providerConfig",
    ok: isOptionalStringRecord,
    problem: "profile.providerConfig must be an object of string values.",
  },
  { key: "model", ok: isOptionalString, problem: "profile.model must be a string." },
  {
    key: "useProxy",
    ok: (v) => v === undefined || typeof v === "boolean",
    problem: "profile.useProxy must be true or false.",
  },
  {
    key: "subscriptionAccountId",
    ok: isOptionalString,
    problem: "profile.subscriptionAccountId must be a string.",
  },
  {
    key: "providerAccountId",
    ok: isOptionalString,
    problem: "profile.providerAccountId must be a string.",
  },
  {
    key: "modelRoutes",
    ok: isOptionalModelRouteArray,
    problem:
      "profile.modelRoutes must be an array of { match, kind, subscriptionAccountId?, providerId?, providerAccountId?, upstreamModel? }.",
  },
  {
    key: "direct",
    ok: (v) => v === undefined || typeof v === "boolean",
    problem: "profile.direct must be true or false.",
  },
  {
    key: "session",
    ok: isClaudeSessionOptionsShape,
    problem:
      "profile.session must be an object of Claude Code session options (effort, permissionMode, allowedTools, disallowedTools, tools, addDirs, systemPrompt, appendSystemPrompt, promptPreset, agent, mcpConfig, strictMcp, settingSources, fallbackModel, claudeSettings).",
  },
  {
    key: "cwd",
    ok: isOptionalString,
    problem: "profile.cwd must be a string.",
  },
];

/**
 * Name the first field that makes `x` an invalid Profile, or undefined when it
 * is one. Callers turn the sentence into their own error type (ProfileError in
 * core, InputError in the web validator) so an import or a form message says
 * WHICH field is wrong.
 */
export function profileShapeProblem(x: unknown): string | undefined {
  if (!isRecord(x)) return "Profile must be an object.";
  for (const rule of PROFILE_RULES) {
    if (!rule.ok(x[rule.key])) return rule.problem;
  }
  return undefined;
}

export function isProfileShape(x: unknown): x is Profile {
  return profileShapeProblem(x) === undefined;
}

export function isProviderAccountShape(x: unknown): x is ProviderAccount {
  if (!isRecord(x)) return false;
  return (
    typeof x["id"] === "string" &&
    typeof x["providerId"] === "string" &&
    typeof x["label"] === "string" &&
    isStringRecord(x["config"]) &&
    hasValidTimestamps(x)
  );
}

export function isSubscriptionAccountShape(x: unknown): x is SubscriptionAccount {
  if (!isRecord(x)) return false;
  return (
    typeof x["id"] === "string" &&
    typeof x["label"] === "string" &&
    isOptionalString(x["email"]) &&
    hasValidTimestamps(x)
  );
}

export function isOAuthCredentialShape(x: unknown): x is OAuthCredential {
  if (!isRecord(x)) return false;
  return (
    typeof x["accessToken"] === "string" &&
    typeof x["refreshToken"] === "string" &&
    (x["expiresAt"] === undefined ||
      (typeof x["expiresAt"] === "number" && Number.isFinite(x["expiresAt"]))) &&
    isOptionalStringArray(x["scopes"]) &&
    (x["extra"] === undefined || isRecord(x["extra"]))
  );
}

/** A bundle entry: account metadata plus the credential (absent = secrets stripped). */
export function isSubscriptionBackupShape(x: unknown): x is SubscriptionBackup {
  if (!isRecord(x)) return false;
  if (!isSubscriptionAccountShape(x["account"])) return false;
  return x["credential"] === undefined || isOAuthCredentialShape(x["credential"]);
}

/**
 * Structural only: the enable flag plus a strategy from the closed enum, plus
 * an update mode from its closed enum. Extra fields are tolerated (settings
 * grow over time); a missing updateMode is valid (pre-update-mode files read
 * as auto at get() time); wrong types fall back to
 * DEFAULT_GLOBAL_SETTINGS at read time and fail the import record.
 */
export function isGlobalSettingsShape(x: unknown): x is GlobalSettings {
  if (!isRecord(x)) return false;
  if (typeof x["rotationEnabled"] !== "boolean") return false;
  if (x["rotationStrategy"] !== "reset-soonest" && x["rotationStrategy"] !== "least-used") return false;
  const mode = x["updateMode"];
  return mode === undefined || mode === "off" || mode === "notify-only" || mode === "auto";
}
