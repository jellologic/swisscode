// Pure account-ranking for the proxy's background rotation poller. Zero I/O,
// zero clocks: the caller passes `now`, so tests pin time and the policy reads
// as data. The poller (adapters) maps live AccountUsage snapshots onto
// RotationInput; this module only decides the order and whether to switch.

import type { RotationStrategy } from "./domain.js";

/** Utilization at/above this means exhausted: never auto-selected. */
export const ROTATION_EXHAUSTED_UTIL = 98;

/** A utilization gap this big (percentage points) justifies a switch at once. */
export const ROTATION_HYSTERESIS_PTS = 10;

/**
 * Inside the utilization band, the winner must reset sooner by at least this
 * to justify a switch — smaller deltas are noise between two healthy accounts.
 */
export const ROTATION_MIN_RESET_EDGE_MS = 15 * 60 * 1000;

/**
 * Utilization when no window reported one: mid-pack, so an unknown account
 * never outranks a known-good one nor sinks to the dead tier.
 */
export const ROTATION_UNKNOWN_UTIL = 50;

/** One account's health as the poller observed it this tick. */
export interface RotationInput {
  accountId: string;
  /** 0-100, null = the API reported unlimited/unknown, undefined = no window. */
  fiveHourUtil: number | null | undefined;
  /** Epoch ms of the 5h reset; undefined = unreported or unparseable. */
  fiveHourResetMs?: number;
  sevenDayUtil: number | null | undefined;
  sevenDayResetMs?: number;
  /** Max utilization across scoped/model/extra windows, when any were reported. */
  extraMaxUtil?: number;
  extraSoonestResetMs?: number;
  /** Served from cache because the live fetch failed. */
  stale: boolean;
  /** Under a 429/529 cooldown (proxy) or a usage backoff (notBeforeMs). */
  cooling: boolean;
  /** Credential rejected this tick (401/403): re-login needed, not load. */
  dead: boolean;
}

export type RotationTier = "usable" | "degraded" | "excluded";

export interface RankedAccount {
  accountId: string;
  tier: RotationTier;
  /** Max known utilization across windows (null counted as 0 = unlimited). */
  effectiveUtil: number;
  /** Soonest future reset across windows; Infinity when none is known. */
  soonestResetMs: number;
  reason: string;
}

/** Last-tick outcome, for `proxy status` and the /proxy state row. */
export interface RotationEvent {
  at: string;
  enabled: boolean;
  strategy: RotationStrategy;
  checked: number;
  usable: number;
  previousId: string | null;
  activeId: string | null;
  switched: boolean;
  reason: string;
}

function tierRank(tier: RotationTier): number {
  return tier === "usable" ? 0 : tier === "degraded" ? 1 : 2;
}

/** Null (unlimited) counts as 0; undefined (unreported) is ignored. */
function effectiveUtilOf(input: RotationInput): number {
  const known: number[] = [];
  for (const u of [input.fiveHourUtil, input.sevenDayUtil]) {
    if (u === undefined) continue;
    known.push(u === null ? 0 : u);
  }
  if (input.extraMaxUtil !== undefined) known.push(input.extraMaxUtil);
  return known.length > 0 ? Math.max(...known) : ROTATION_UNKNOWN_UTIL;
}

/**
 * Soonest reset across windows. A reset that already passed means quota is
 * back NOW, so it clamps to `now` (sorts first) instead of being ignored as
 * stale data. Nothing here invents a reset: unreported stays Infinity.
 */
function soonestResetOf(input: RotationInput, now: number): number {
  const times = [input.fiveHourResetMs, input.sevenDayResetMs, input.extraSoonestResetMs].filter(
    (t): t is number => typeof t === "number" && Number.isFinite(t),
  );
  if (times.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...times.map((t) => (t <= now ? now : t)));
}

function rankOne(input: RotationInput, now: number): RankedAccount {
  const effectiveUtil = effectiveUtilOf(input);
  const soonestResetMs = soonestResetOf(input, now);
  if (input.dead) {
    return {
      accountId: input.accountId,
      tier: "excluded",
      effectiveUtil,
      soonestResetMs,
      reason: "credential rejected (re-login needed)",
    };
  }
  if (effectiveUtil >= ROTATION_EXHAUSTED_UTIL) {
    return {
      accountId: input.accountId,
      tier: "excluded",
      effectiveUtil,
      soonestResetMs,
      reason: `limit exhausted (${effectiveUtil}%)`,
    };
  }
  if (input.cooling || input.stale) {
    return {
      accountId: input.accountId,
      tier: "degraded",
      effectiveUtil,
      soonestResetMs,
      reason: input.cooling ? "cooling down after rate limit" : "usage snapshot is stale",
    };
  }
  return {
    accountId: input.accountId,
    tier: "usable",
    effectiveUtil,
    soonestResetMs,
    reason: "within limits",
  };
}

/**
 * Best-first ranking. Tiers dominate (no usable account ever loses to a
 * degraded one however soon it resets); within a tier the strategy orders.
 */
export function rankAccountsForRotation(
  inputs: RotationInput[],
  strategy: RotationStrategy,
  now: number,
): RankedAccount[] {
  const ranked = inputs.map((input) => rankOne(input, now));
  const byId = (a: RankedAccount, b: RankedAccount) => a.accountId.localeCompare(b.accountId);
  const byUtilReset =
    strategy === "least-used"
      ? (a: RankedAccount, b: RankedAccount) =>
          a.effectiveUtil - b.effectiveUtil || a.soonestResetMs - b.soonestResetMs || byId(a, b)
      : (a: RankedAccount, b: RankedAccount) =>
          a.soonestResetMs - b.soonestResetMs || a.effectiveUtil - b.effectiveUtil || byId(a, b);
  return ranked.sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || byUtilReset(a, b));
}

/**
 * Whether the proxy should move `currentId` to the ranking winner. Hysteresis
 * keeps two healthy accounts from trading active every tick: a better tier or
 * a decisive utilization gap switches at once, a sooner reset only wins inside
 * the utilization band, past the reset edge, and after a full-cycle min-hold
 * (which also protects a fresh manual `proxy use` from instant revert).
 */
export function shouldRotate(
  currentId: string | null,
  ranked: RankedAccount[],
  lastSwitchAt: number | null,
  now: number,
  pollMs: number,
): { to: string | null; reason: string } {
  const selectable = ranked.filter((r) => r.tier !== "excluded");
  if (selectable.length === 0) return { to: null, reason: "no usable account" };
  const winner = selectable[0];
  if (!winner) return { to: null, reason: "no usable account" };
  if (winner.accountId === currentId) return { to: null, reason: "already on the best account" };
  const current = ranked.find((r) => r.accountId === currentId);
  if (!current) return { to: winner.accountId, reason: "current account is gone" };
  if (tierRank(winner.tier) < tierRank(current.tier)) {
    return {
      to: winner.accountId,
      reason: `current is ${current.tier}, ${winner.accountId} is ${winner.tier}`,
    };
  }
  if (winner.effectiveUtil + ROTATION_HYSTERESIS_PTS < current.effectiveUtil) {
    return {
      to: winner.accountId,
      reason: `${winner.accountId} at ${winner.effectiveUtil}% vs ${current.effectiveUtil}%`,
    };
  }
  const resetEdge = current.soonestResetMs - winner.soonestResetMs;
  const heldLongEnough = lastSwitchAt === null || now - lastSwitchAt >= pollMs;
  if (resetEdge >= ROTATION_MIN_RESET_EDGE_MS && heldLongEnough) {
    return {
      to: winner.accountId,
      reason: `${winner.accountId} resets ${Math.round(resetEdge / 60000)}min sooner`,
    };
  }
  return { to: null, reason: "within noise band" };
}
