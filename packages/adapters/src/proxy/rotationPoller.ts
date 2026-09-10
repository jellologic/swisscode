// Adapter: background subscription health check + auto-rollover for the proxy.
// Owned by SubscriptionProxy: start/stop ride on listen()/close(), so the CLI
// and `swisscode web` share the one code path. The verdict is applied through
// the existing setActive(), so pins stay preferences and key routes are
// untouched. Scoring itself stays pure in core (rotation.ts); this file only
// does I/O and maps live snapshots onto RotationInput.
//
// Poll discipline: strictly sequential per account (never Promise.all), one
// fetchUsage per account per cycle at most, the usage-cache notBeforeMs
// honored before any network, 401/403 never retried, overlapping ticks
// skipped, and the whole tick try/caught so a usage outage can't crash
// listen(). The poller never writes credentials and never mutates the proxy
// cooldown map — both are read-only signals here.

import type {
  AccountRepository,
  AccountUsage,
  GlobalSettings,
  RankedAccount,
  RotationEvent,
  RotationInput,
  RotationStrategy,
  UsageClient,
} from "@swisscode/core";
import {
  DEFAULT_GLOBAL_SETTINGS,
  rankAccountsForRotation,
  shouldRotate,
} from "@swisscode/core";
import { usageCacheKey, vaultIdentityResolver } from "../subscriptions/usageCache.js";
import type { UsageCacheEntry } from "../subscriptions/usageCache.js";
import { UsageError } from "../subscriptions/anthropic.js";

/** Tick interval when nothing overrides it. Matches the usage 429 backoff, so
 * a backed-off account is rechecked just as its cooldown lifts. */
export const DEFAULT_ROTATION_POLL_MS = 5 * 60 * 1000;

/** Floor for the interval: below this the poller would hammer the usage
 * endpoint faster than a rate-limited account can recover. */
export const MIN_ROTATION_POLL_MS = 60 * 1000;

/** Idle heartbeat: log a summary line at most this often without a switch. */
const ROTATION_HEARTBEAT_MS = 60 * 60 * 1000;

/** What `proxy status` and the /proxy state row render. */
export interface RotationSnapshot {
  enabled: boolean;
  strategy: RotationStrategy;
  lastRunAt: number | null;
  checked: number;
  usable: number;
  /** "a→b" of the last switch, null when this run never switched. */
  switched: string | null;
  /** This tick's outcome (or the last tick's, between runs). */
  reason: string | null;
}

/** CLI flags: top precedence, above env, above the settings file. */
export interface RotationOverrides {
  enabled?: boolean;
  strategy?: RotationStrategy;
  pollMs?: number;
}

export interface RotationPollerDeps {
  accounts: AccountRepository;
  usageClient: UsageClient;
  /** Read-only: pre-check notBeforeMs and last-good numbers, never written. */
  usageCache: { get(key: string): Promise<UsageCacheEntry | undefined> };
  /** Re-read every tick, so the /settings toggle needs no restart. */
  settings: { get(): Promise<GlobalSettings> };
  /**
   * Stable identity for usage-cache keying. Defaults to the vault-email
   * resolver — the same keying CachingUsageClient uses, or the poller would
   * miss its notBeforeMs entries. Override only in tests.
   */
  accountIdentity?: (accountId: string) => Promise<string | undefined>;
  /** Read-only proxy 429/529 cooldowns (epoch ms until which to avoid). */
  cooldownUntil?: (accountId: string) => number;
  getActive?: () => string | null;
  setActive?: (accountId: string) => Promise<unknown>;
  overrides?: RotationOverrides;
  /** Default process.env; tests pass {} to isolate from the real shell. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Rotation log lines ("[rotation] ..."). Default console.log. */
  log?: (message: string) => void;
  /** Every completed tick, for richer surfaces than the snapshot. */
  onEvent?: (event: RotationEvent) => void;
}

function parseEnabled(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}

function parseStrategy(raw: string | undefined): RotationStrategy | undefined {
  return raw === "reset-soonest" || raw === "least-used" ? raw : undefined;
}

function parsePollMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(Math.floor(n), MIN_ROTATION_POLL_MS);
}

function clampPollMs(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n) || n <= 0) return DEFAULT_ROTATION_POLL_MS;
  return Math.max(Math.floor(n), MIN_ROTATION_POLL_MS);
}

function resetMs(resetsAt?: string): number | undefined {
  if (!resetsAt) return undefined;
  const ms = Date.parse(resetsAt);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Utilization that isn't a usable number counts as unlimited (0), matching
 * core's ranking: an "unlimited" extra window must not look exhausted. */
function numOrZero(u: unknown): number {
  return typeof u === "number" && Number.isFinite(u) ? u : 0;
}

/**
 * Fold the scoped/model/extra windows into the max/soonest pair core ranks
 * on. 5h and 7d travel as their own fields (so the log line can name them);
 * everything else is one max and one soonest — the balance the user asked
 * for: a hot 7d outranks a cool 5h however soon the 5h resets.
 */
function extraOf(usage: AccountUsage): { extraMaxUtil?: number; extraSoonestResetMs?: number } {
  const utils: number[] = [];
  const resets: number[] = [];
  const take = (utilization: unknown, resetsAt?: string) => {
    utils.push(numOrZero(utilization));
    const ms = resetMs(resetsAt);
    if (ms !== undefined) resets.push(ms);
  };
  for (const w of usage.windows ?? []) take(w.utilization, w.resetsAt);
  for (const s of usage.scoped ?? []) take(s.utilization, s.resetsAt);
  for (const w of Object.values(usage.models ?? {})) take(w.utilization, w.resetsAt);
  return {
    ...(utils.length > 0 ? { extraMaxUtil: Math.max(...utils) } : {}),
    ...(resets.length > 0 ? { extraSoonestResetMs: Math.min(...resets) } : {}),
  };
}

const BASE_INPUT = { fiveHourUtil: undefined, sevenDayUtil: undefined } as const;

export class RotationPoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private pollMs = DEFAULT_ROTATION_POLL_MS;
  private ticking = false;
  private lastSwitchAt: number | null = null;
  private lastSwitch: string | null = null;
  private lastLogAt = 0;
  private notedSparse = false;
  private state: RotationSnapshot = {
    enabled: false,
    strategy: DEFAULT_GLOBAL_SETTINGS.rotationStrategy,
    lastRunAt: null,
    checked: 0,
    usable: 0,
    switched: null,
    reason: null,
  };

  constructor(private readonly deps: RotationPollerDeps) {}

  get running(): boolean {
    return this.timer !== undefined;
  }

  /** Current state for `proxy status` (a copy — mutate nothing through it). */
  snapshot(): RotationSnapshot {
    return { ...this.state, switched: this.lastSwitch };
  }

  /**
   * A manual `POST /__swisscode/use/:id` is a choice, not noise: stamp the
   * min-hold clock so the next tick can't instantly revert it.
   */
  noteManualSwitch(): void {
    this.lastSwitchAt = this.now();
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.notedSparse = false;
    this.arm(this.pollMs);
    // Check now, not one interval from now: enabling rotation should show a
    // verdict on the next status call, and the e2e flow shouldn't wait 5min.
    void this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private arm(ms: number): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.pollMs = ms;
    this.timer = setInterval(() => {
      void this.tick();
    }, ms);
    // A localhost proxy must never hold the process open on its own.
    this.timer.unref();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(message: string): void {
    (this.deps.log ?? console.log)(message);
  }

  /** One cycle. Public so tests drive it without timers; always safe to call. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tickOnce();
    } catch (err) {
      this.log(`[rotation] tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async tickOnce(): Promise<void> {
    const now = this.now();
    const env = this.deps.env ?? process.env;
    const file = await this.deps.settings.get().catch(() => ({ ...DEFAULT_GLOBAL_SETTINGS }));
    const enabled =
      this.deps.overrides?.enabled ??
      parseEnabled(env["SWISSCODE_ROTATION_ENABLED"]) ??
      file.rotationEnabled ??
      false;
    const strategy =
      this.deps.overrides?.strategy ??
      parseStrategy(env["SWISSCODE_ROTATION_STRATEGY"]) ??
      (file.rotationStrategy === "least-used" ? "least-used" : "reset-soonest");
    const pollMs = clampPollMs(
      this.deps.overrides?.pollMs ?? parsePollMs(env["SWISSCODE_ROTATION_POLL_MS"]),
    );
    if (pollMs !== this.pollMs && this.timer !== undefined) this.arm(pollMs);

    if (!enabled) {
      this.state = { ...this.state, enabled, strategy };
      this.log("[rotation] disabled, skipping");
      return;
    }

    const all = await this.deps.accounts.list();
    if (all.length <= 1) {
      this.state = {
        enabled,
        strategy,
        lastRunAt: now,
        checked: all.length,
        usable: all.length,
        switched: this.lastSwitch,
        reason: "only one account",
      };
      if (!this.notedSparse) {
        this.notedSparse = true;
        this.log(`[rotation] ${all.length} account(s), nothing to rotate`);
      }
      return;
    }

    // Strictly sequential: one account at a time, and one account's failure
    // is one degraded input — never an aborted tick.
    const inputs: RotationInput[] = [];
    for (const account of all) {
      try {
        inputs.push(await this.checkOne(account.id, now));
      } catch {
        inputs.push({ ...BASE_INPUT, accountId: account.id, stale: true, cooling: false, dead: false });
      }
    }

    const ranked = rankAccountsForRotation(inputs, strategy, now);
    const current = this.deps.getActive?.() ?? null;
    const verdict = shouldRotate(current, ranked, this.lastSwitchAt, now, pollMs);
    const usable = ranked.filter((r) => r.tier === "usable").length;
    const previousId = current;
    const activeId = verdict.to ?? current;

    if (verdict.to) {
      try {
        await this.deps.setActive?.(verdict.to);
      } catch (err) {
        this.state = { enabled, strategy, lastRunAt: now, checked: inputs.length, usable, switched: this.lastSwitch, reason: `switch failed: ${(err as Error).message}` };
        this.log(`[rotation] checked ${inputs.length} (${usable} usable) switch to ${verdict.to} failed: ${(err as Error).message}`);
        return;
      }
      this.lastSwitchAt = now;
      this.lastSwitch = `${previousId ?? "none"}→${verdict.to}`;
      this.lastLogAt = now;
      this.state = { enabled, strategy, lastRunAt: now, checked: inputs.length, usable, switched: this.lastSwitch, reason: verdict.reason };
      this.log(
        `[rotation] checked ${inputs.length} (${usable} usable) active ${previousId ?? "none"}→${verdict.to}: ${verdict.reason} (${strategy})`,
      );
    } else {
      this.state = { enabled, strategy, lastRunAt: now, checked: inputs.length, usable, switched: this.lastSwitch, reason: verdict.reason };
      if (now - this.lastLogAt >= ROTATION_HEARTBEAT_MS) {
        this.lastLogAt = now;
        this.log(
          `[rotation] checked ${inputs.length} (${usable} usable) active ${previousId ?? "none"}: ${verdict.reason} (${strategy})`,
        );
      }
    }
    this.deps.onEvent?.({
      at: new Date(now).toISOString(),
      enabled,
      strategy,
      checked: inputs.length,
      usable,
      previousId,
      activeId,
      switched: verdict.to !== null,
      reason: verdict.reason,
    });
  }

  private async checkOne(accountId: string, now: number): Promise<RotationInput> {
    const resolve = this.deps.accountIdentity ?? vaultIdentityResolver(this.deps.accounts);
    const identity = await resolve(accountId).catch(() => undefined);
    const entry = await this.deps.usageCache.get(usageCacheKey(accountId, identity)).catch(() => undefined);
    if (entry?.notBeforeMs !== undefined && entry.notBeforeMs > now) {
      // Backed off: no network this cycle. Rank off last-good numbers when
      // there are any, marked cooling so they can't win over fresh data.
      const partial = entry.snapshot ? extraOf(entry.snapshot) : {};
      return {
        ...BASE_INPUT,
        accountId,
        fiveHourUtil: entry.snapshot?.fiveHour?.utilization,
        fiveHourResetMs: resetMs(entry.snapshot?.fiveHour?.resetsAt),
        sevenDayUtil: entry.snapshot?.sevenDay?.utilization,
        sevenDayResetMs: resetMs(entry.snapshot?.sevenDay?.resetsAt),
        ...partial,
        stale: true,
        cooling: true,
        dead: false,
      };
    }
    // Read-only: an expired access token reads as dead for this tick rather
    // than spending a single-use refresh token on a timer. The request path
    // still refreshes on demand, and the next tick sees the fresh token.
    const credential = await this.deps.accounts.loadCredential(accountId).catch(() => undefined);
    if (!credential) return { ...BASE_INPUT, accountId, stale: false, cooling: false, dead: true };
    let usage: AccountUsage;
    try {
      usage = await this.deps.usageClient.fetchUsage(accountId, credential.accessToken);
    } catch (err) {
      // Auth is dead (re-login, not load). Anything else with no snapshot to
      // serve is unknown numbers, demoted — never promoted off nothing.
      if (err instanceof UsageError && (err.status === 401 || err.status === 403)) {
        return { ...BASE_INPUT, accountId, stale: false, cooling: false, dead: true };
      }
      return { ...BASE_INPUT, accountId, stale: true, cooling: false, dead: false };
    }
    const cooling = (this.deps.cooldownUntil?.(accountId) ?? 0) > now;
    return {
      ...BASE_INPUT,
      accountId,
      fiveHourUtil: usage.fiveHour?.utilization,
      fiveHourResetMs: resetMs(usage.fiveHour?.resetsAt),
      sevenDayUtil: usage.sevenDay?.utilization,
      sevenDayResetMs: resetMs(usage.sevenDay?.resetsAt),
      ...extraOf(usage),
      stale: usage.stale ?? false,
      cooling,
      dead: false,
    };
  }
}
