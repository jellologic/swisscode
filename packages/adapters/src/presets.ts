// Starter gallery: named profile presets kept as pure data. Core stays
// preset-free — these are adapter opinions about good starting points, filled
// with real store ids at scaffold time and then copied into the form (never
// linked: later preset edits must not surprise existing profiles).
//
// A preset's `profile` may contain `${SLOT}` placeholders in any string field.
// The scaffolder lists `slots`, resolves each one from the stores (caller
// supplies the lookup — same pattern as route validation), and calls
// `fillPresetSlots` to get a plain Profile ready for `validateProfile`.

import type { Profile } from "@swisscode/core";

export interface PresetSlotDef {
  /** Placeholder key: `${SUBSCRIPTION}` in the profile JSON. */
  key: string;
  /** Human line for prompts and error messages. */
  label: string;
  kind: "subscription" | "providerAccount";
  /** Required when kind is "providerAccount". */
  providerId?: string;
}

export interface ProfilePreset {
  /** Stable id — also the suggested profile name. */
  id: string;
  title: string;
  blurb: string;
  slots: PresetSlotDef[];
  profile: Profile;
}

/** Named append-system-prompt snippets (C2 wires the form select; the Reviewer
 * preset inlines `reviewer` today so the text has one home). */
export interface PromptPreset {
  id: string;
  title: string;
  text: string;
}

export const PROMPT_PRESETS: readonly PromptPreset[] = [
  {
    id: "reviewer",
    title: "Reviewer",
    text: "You are a careful code reviewer. For every change: state what it does, then list correctness risks, edge cases, and simpler alternatives. Prefer questions over assertions when intent is unclear.",
  },
  {
    id: "planner",
    title: "Planner",
    text: "You are a planning assistant. Before writing code: restate the goal, list the files you will touch and why, name the risks, and stop for approval.",
  },
  {
    id: "explainer",
    title: "Explainer",
    text: "You are a patient explainer. Teach the why behind the code: key abstractions, data flow, and where a newcomer would get lost. Concrete file references over generalities.",
  },
];

const SUBSCRIPTION_SLOT: PresetSlotDef = {
  key: "SUBSCRIPTION",
  label: "Claude subscription account",
  kind: "subscription",
};

export const PROFILE_PRESETS: readonly ProfilePreset[] = [
  {
    id: "solo",
    title: "Solo dev",
    blurb: "One Claude login through the proxy, with 429 failover to your other logins.",
    slots: [SUBSCRIPTION_SLOT],
    profile: {
      name: "solo",
      agentId: "claude-code",
      providerId: "claude-subscription",
      subscriptionAccountId: "${SUBSCRIPTION}",
    },
  },
  {
    id: "heavy-opus",
    title: "Heavy Opus",
    blurb: "Opus requests ride an OpenRouter key; everything else uses the subscription.",
    slots: [
      SUBSCRIPTION_SLOT,
      { key: "KEY", label: "OpenRouter key account", kind: "providerAccount", providerId: "openrouter" },
    ],
    profile: {
      name: "heavy-opus",
      agentId: "claude-code",
      providerId: "claude-subscription",
      subscriptionAccountId: "${SUBSCRIPTION}",
      // Matching is exact, so duplicate this row per Opus id you actually use.
      modelRoutes: [
        {
          kind: "providerAccount",
          match: "claude-opus-5",
          providerId: "openrouter",
          providerAccountId: "${KEY}",
        },
      ],
    },
  },
  {
    id: "frugal",
    title: "Frugal",
    blurb: "Haiku by default with tight effort; switch to Sonnet inside Claude Code with /model.",
    slots: [],
    profile: {
      name: "frugal",
      agentId: "claude-code",
      providerId: "claude-subscription",
      model: "claude-haiku-4-5",
      session: { effort: "low" },
    },
  },
  {
    id: "reviewer",
    title: "Reviewer",
    blurb: "Plan permission mode plus a reviewer system prompt; proposes first, runs after approval.",
    slots: [],
    profile: {
      name: "reviewer",
      agentId: "claude-code",
      providerId: "claude-subscription",
      session: {
        permissionMode: "plan",
        appendSystemPrompt: PROMPT_PRESETS[0]!.text,
      },
    },
  },
];

export function presetById(id: string): ProfilePreset | undefined {
  return PROFILE_PRESETS.find((p) => p.id === id);
}

const SLOT_RE = /\$\{([A-Za-z0-9_]+)\}/g;

/**
 * Replace every `${KEY}` in the preset's profile with `values[KEY]`. Pure —
 * no store access; the caller resolves slot values first. Throws naming the
 * missing slot; also throws if a placeholder survives (a typo'd key would
 * otherwise save as a literal account id).
 */
export function fillPresetSlots(
  preset: ProfilePreset,
  values: Record<string, string>,
): Profile {
  const missing = preset.slots.filter((s) => !(values[s.key] ?? "").trim());
  if (missing.length > 0) {
    throw new Error(
      `Preset "${preset.id}" needs ${missing.map((s) => `${s.key} (${s.label})`).join(", ")}.`,
    );
  }
  const filled = JSON.parse(
    JSON.stringify(preset.profile).replace(SLOT_RE, (_m, key: string) => values[key]!.trim()),
  ) as Profile;
  const leftover = JSON.stringify(filled).match(SLOT_RE);
  if (leftover) {
    throw new Error(`Preset "${preset.id}" has an unknown slot ${leftover[0]} — fix the preset data.`);
  }
  return filled;
}
