// Per-model routing: pure decision functions over Profile.modelRoutes.
// No I/O here — the proxy (adapters) calls these per request with data it
// loaded, so route edits apply to the very next request with no restart.

import type { ModelRoute, Profile } from "./domain.js";
import { ProfileError } from "./service.js";

/**
 * First route whose `match` equals the resolved request model, or undefined
 * when nothing matches (caller falls back to the base provider). Matching is
 * deliberately exact: the proxy only ever observes full model ids (aliases
 * resolve client-side), so prefix/glob rules would mostly match surprises.
 */
export function selectModelRoute(
  profile: Pick<Profile, "modelRoutes">,
  model: string,
): ModelRoute | undefined {
  const routes = profile.modelRoutes ?? [];
  return routes.find((r) => r.match === model);
}

/** Request paths that carry a top-level `model` field in Anthropic-compatible APIs. */
const MODEL_PATH_SUFFIXES = ["/v1/messages", "/v1/messages/count_tokens"] as const;

/**
 * Pull the request model out of a proxied call without any provider-specific
 * knowledge: every supported upstream is Anthropic-compatible, so the model is
 * the top-level JSON `model` string on the messages (or count-tokens) path.
 * Anything else — wrong method, unknown path, unparseable body — is undefined,
 * and the caller routes it to the base provider.
 */
export function extractRequestModel(
  method: string,
  path: string,
  bodyJson: unknown,
): string | undefined {
  if (method.toUpperCase() !== "POST") return undefined;
  const pathname = path.split("?", 1)[0] ?? "";
  if (!MODEL_PATH_SUFFIXES.some((s) => pathname === s || pathname.endsWith(s))) return undefined;
  if (typeof bodyJson !== "object" || bodyJson === null || Array.isArray(bodyJson)) return undefined;
  const model = (bodyJson as Record<string, unknown>)["model"];
  if (typeof model !== "string") return undefined;
  const trimmed = model.trim();
  return trimmed ? trimmed : undefined;
}

/** Lookups the caller supplies from its own stores (core never reads files). */
export interface ModelRouteLookups {
  /** True when the vault holds this subscription account. */
  hasSubscriptionAccount?: (id: string) => boolean;
  /** True when this provider account is stored. */
  hasProviderAccount?: (providerId: string, id: string) => boolean;
}

/**
 * Vendor model ids ("claude-opus-5", "anthropic/claude-opus-4",
 * "openai/gpt-5"): slug-shaped, never blank, never carrying whitespace or
 * shell metacharacters — a `match` feeds an exact equality check and an
 * `upstreamModel` is written into the upstream request body verbatim. The web
 * form imports this for per-row validation so both surfaces enforce the same
 * charset the proxy would otherwise trust blindly.
 */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Internal-consistency checks for a profile's routes: shape-adjacent rules the
 * shape guard cannot express (duplicates, kind-field pairing, direct clash).
 * Referenced-account existence goes through `lookups` (omitted lookups skip
 * that check — callers without the stores still get everything else).
 * Throws ProfileError naming the offending route.
 */
export function validateModelRoutes(profile: Profile, lookups: ModelRouteLookups = {}): void {
  const routes = profile.modelRoutes ?? [];
  if (profile.direct === true && routes.length > 0) {
    throw new ProfileError(
      `Profile "${profile.name}" sets direct:true with modelRoutes — routes need the proxy.`,
    );
  }
  const seen = new Set<string>();
  routes.forEach((route, i) => {
    const where = `Profile "${profile.name}" modelRoutes[${i}]`;
    if (!nonEmpty(route.match)) {
      throw new ProfileError(`${where} needs a non-empty match model id.`);
    }
    const match = route.match.trim();
    if (!MODEL_ID_RE.test(match)) {
      throw new ProfileError(
        `${where} match ${JSON.stringify(route.match)} is not a model id — slug-shaped vendor ids only (letters, digits, . _ : @ / -).`,
      );
    }
    if (seen.has(match)) {
      throw new ProfileError(`${where} duplicates match "${match}".`);
    }
    seen.add(match);
    if (route.kind !== "subscription" && route.kind !== "providerAccount") {
      throw new ProfileError(`${where} has unknown kind ${JSON.stringify(route.kind)}.`);
    }
    if (route.kind === "subscription") {
      if (route.providerId !== undefined || route.providerAccountId !== undefined) {
        throw new ProfileError(
          `${where} is a subscription route and must not set providerId/providerAccountId.`,
        );
      }
      if (route.subscriptionAccountId !== undefined && !nonEmpty(route.subscriptionAccountId)) {
        throw new ProfileError(`${where} has an empty subscriptionAccountId.`);
      }
      const id = route.subscriptionAccountId?.trim() || profile.subscriptionAccountId;
      if (id && lookups.hasSubscriptionAccount && !lookups.hasSubscriptionAccount(id)) {
        throw new ProfileError(`${where} references unknown subscription account "${id}".`);
      }
    } else {
      if (route.subscriptionAccountId !== undefined) {
        throw new ProfileError(
          `${where} is a providerAccount route and must not set subscriptionAccountId.`,
        );
      }
      if (!nonEmpty(route.providerId) || !nonEmpty(route.providerAccountId)) {
        throw new ProfileError(`${where} needs providerId and providerAccountId.`);
      }
      if (
        lookups.hasProviderAccount &&
        !lookups.hasProviderAccount(route.providerId.trim(), route.providerAccountId.trim())
      ) {
        throw new ProfileError(
          `${where} references unknown ${route.providerId.trim()} account "${route.providerAccountId.trim()}".`,
        );
      }
    }
    if (route.upstreamModel !== undefined && typeof route.upstreamModel !== "string") {
      throw new ProfileError(`${where} upstreamModel must be a string.`);
    }
    // Blank is never "passthrough": the proxy rewrites whenever the field is
    // present, so "" would send an empty model id upstream. Omit the field.
    if (typeof route.upstreamModel === "string" && route.upstreamModel.trim().length === 0) {
      throw new ProfileError(`${where} upstreamModel is blank — omit it to send the requested model unchanged.`);
    }
    if (
      typeof route.upstreamModel === "string" &&
      !MODEL_ID_RE.test(route.upstreamModel.trim())
    ) {
      throw new ProfileError(
        `${where} upstreamModel ${JSON.stringify(route.upstreamModel)} is not a model id — slug-shaped vendor ids only.`,
      );
    }
  });
}

/**
 * Human labels for the accounts a route can point at. Callers build these
 * from their stores (CLI: vault + key-account files); a missing entry falls
 * back to the raw id so a deleted account still renders instead of blanking.
 */
export interface ModelRouteLabels {
  subscriptionAccountLabel?(id: string): string | undefined;
  providerAccountLabel?(providerId: string, id: string): string | undefined;
  providerDisplayName?(providerId: string): string | undefined;
}

/**
 * One plain sentence per route — the single renderer behind `swisscode show`
 * and the web profile form, so both surfaces describe the same route the same
 * way. Examples:
 *   Requests for `opus` → Work vault account, model sent unchanged.
 *   Requests for `codex` → Main OpenRouter key, sent as `openai/gpt-5`.
 */
export function describeModelRoute(route: ModelRoute, labels: ModelRouteLabels = {}): string {
  const sent =
    route.upstreamModel !== undefined && route.upstreamModel.length > 0
      ? `, sent as \`${route.upstreamModel}\``
      : ", model sent unchanged";
  if (route.kind === "subscription") {
    const id = route.subscriptionAccountId?.trim() ?? "";
    const account = id.length > 0 ? (labels.subscriptionAccountLabel?.(id) ?? id) : "the profile's base";
    return `Requests for \`${route.match}\` → ${account} vault account${sent}.`;
  }
  const providerId = route.providerId?.trim() ?? "";
  const accountId = route.providerAccountId?.trim() ?? "";
  const provider = labels.providerDisplayName?.(providerId) ?? (providerId || "unknown provider");
  const account =
    accountId.length > 0 ? (labels.providerAccountLabel?.(providerId, accountId) ?? accountId) : "unknown account";
  return `Requests for \`${route.match}\` → ${account} ${provider} key${sent}.`;
}
