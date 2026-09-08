// Reusable traffic-inspection mechanics shared by every provider parser.
// Pure byte plumbing only: SSE framing, safe JSON, truncation, token math,
// generic JSON shape description. Response *semantics* (usage field names,
// content-block types, stop reasons) stay in each provider's own adapter.

/** ~4 chars per token — rough sizing for display, never billing. */
export function approxTokens(chars: number): number {
  return Math.max(1, Math.round(chars / 4));
}

export function truncateText(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  return { text: text.slice(0, cap), truncated: true };
}

/** JSON.parse that returns undefined instead of throwing. */
export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Split an SSE body into its `data:` payloads, in order. Trims each line
 * first (proxies and stubs indent); skips event-name/comment lines.
 */
export function splitSsePayloads(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("data:")) out.push(trimmed.slice(5).trim());
  }
  return out;
}

/** True when the kept bytes look like an SSE stream. */
export function looksLikeSse(body: string): boolean {
  return body.includes("data:");
}

/** Frequency tally that preserves first-seen order. */
export function tallyNames(names: string[]): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);
}

export function describeJsonShape(value: unknown): string {
  if (Array.isArray(value)) return `array of ${value.length}`;
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (Array.isArray(obj["data"])) {
      return `object with a data array of ${(obj["data"] as unknown[]).length}`;
    }
    const keys = Object.keys(obj);
    return `object with keys ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""}`;
  }
  return typeof value;
}

/** Human display string for one data-array entry: id, name, or fallback. */
export function displayItem(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (typeof item !== "object" || item === null) return null;
  const obj = item as Record<string, unknown>;
  for (const key of ["id", "display_name", "name"]) {
    if (typeof obj[key] === "string" && (obj[key] as string).length > 0) {
      return obj[key] as string;
    }
  }
  return null;
}

export function listItems(
  data: unknown[],
  maxItems: number,
): { items: string[]; itemsTruncated: boolean; totalItems: number } {
  const named = data.map(displayItem).filter((s): s is string => s !== null);
  return {
    items: named.slice(0, maxItems),
    itemsTruncated: named.length > maxItems,
    totalItems: data.length,
  };
}

/** Plain-object guard for unknown JSON. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
