import {
  MODEL_PRICES,
  describeModelRoute,
  type ModelRoute,
  type ModelRouteLabels,
} from "@swisscode/core";

/** One routes-editor row. `dest` encodes the destination picker value. */
export interface RouteFormRow {
  match: string;
  /** "subscription:" (base), "subscription:<id>", or "key:<providerId>:<accountId>". */
  dest: string;
  upstreamModel: string;
}

export function routeToRow(route: ModelRoute): RouteFormRow {
  const dest =
    route.kind === "providerAccount"
      ? `key:${route.providerId ?? ""}:${route.providerAccountId ?? ""}`
      : `subscription:${route.subscriptionAccountId?.trim() ?? ""}`;
  return { match: route.match, dest, upstreamModel: route.upstreamModel ?? "" };
}

export function rowToRoute(row: RouteFormRow): ModelRoute {
  const match = row.match.trim();
  const upstream = row.upstreamModel.trim();
  const extra = upstream ? { upstreamModel: upstream } : {};
  if (row.dest.startsWith("key:")) {
    const rest = row.dest.slice("key:".length);
    const sep = rest.indexOf(":");
    return {
      match,
      kind: "providerAccount",
      providerId: rest.slice(0, sep),
      providerAccountId: rest.slice(sep + 1),
      ...extra,
    };
  }
  const accountId = row.dest.slice("subscription:".length);
  return {
    match,
    kind: "subscription",
    ...(accountId ? { subscriptionAccountId: accountId } : {}),
    ...extra,
  };
}

/**
 * Last-resort Match suggestions when no provider API or traffic has named a
 * model. Seeded from the spend-estimate table plus ids the gallery presets use;
 * stale-prone by nature — the UI labels it as curated, and free text always
 * wins. Web-local on purpose: core stays pure and this list is a picker hint,
 * not domain truth. Refresh against Anthropic's published models when stale.
 */
export const SUBSCRIPTION_KNOWN_MODELS: string[] = [
  ...Object.keys(MODEL_PRICES),
  "claude-opus-5",
  "claude-haiku-5",
].filter((id, i, all) => all.indexOf(id) === i);

export interface DestinationOption {
  value: string;
  /** "Work (work)" / "OR key · OpenRouter" — what the picker row shows. */
  label: string;
  /** Backend kind for the second column / search text. */
  kind: string;
}

/**
 * Every backend a route (or the default) can point at: the profile base first,
 * then vault accounts, then stored key accounts with their provider names.
 * The same list feeds the default picker and every row — one concept, one
 * builder.
 */
export function destinationOptions(
  subscriptionAccounts: { id: string; label: string }[],
  keyAccounts: { id: string; label: string; providerId: string }[],
  providerDisplayName: (providerId: string) => string | undefined,
): DestinationOption[] {
  return [
    { value: "subscription:", label: "Profile base account", kind: "Subscription" },
    ...subscriptionAccounts.map((a) => ({
      value: `subscription:${a.id}`,
      label: `${a.label} (${a.id})`,
      kind: "Subscription",
    })),
    ...keyAccounts.map((a) => ({
      value: `key:${a.providerId}:${a.id}`,
      label: `${a.label} (${a.id})`,
      kind: providerDisplayName(a.providerId) ?? a.providerId,
    })),
  ];
}

export type MappingKind = "route" | "duplicate" | "fallback";

export interface MappingRow {
  sentence: string;
  kind: MappingKind;
}

/**
 * "Every model and what it maps to": one sentence per override row in order
 * (same renderer as `swisscode show`, so both surfaces agree), duplicates
 * flagged never-fires to mirror first-row-wins, and an always-last fallback
 * describing the default backend for anything unmatched.
 */
export function effectiveMapping(
  rows: RouteFormRow[],
  labels: ModelRouteLabels,
  fallbackSentence: string,
): MappingRow[] {
  const seen = new Set<string>();
  const out: MappingRow[] = rows.map((row, i) => {
    const match = row.match.trim();
    const duplicate = match !== "" && seen.has(match);
    if (match !== "") seen.add(match);
    return {
      sentence: `Row ${i + 1}: ${describeModelRoute(rowToRoute(row), labels)}`,
      kind: duplicate ? "duplicate" : "route",
    } as MappingRow;
  });
  out.push({ sentence: fallbackSentence, kind: "fallback" });
  return out;
}
