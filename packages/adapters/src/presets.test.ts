// Pure-data preset tests: no stores, no fs, no network. The gallery is a
// constant — pin its shape so a stray edit can't ship a preset that fails
// validation or references a slot nobody fills.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateProfile } from "@swisscode/core";
import {
  PROFILE_PRESETS,
  PROMPT_PRESETS,
  fillPresetSlots,
  presetById,
} from "./presets.js";

describe("profile presets", () => {
  it("ships the four planned presets with unique ids", () => {
    assert.deepEqual(
      PROFILE_PRESETS.map((p) => p.id),
      ["solo", "heavy-opus", "frugal", "reviewer"],
    );
  });

  it("every preset fills to a valid profile with test ids", () => {
    for (const preset of PROFILE_PRESETS) {
      const values: Record<string, string> = {};
      for (const slot of preset.slots) values[slot.key] = `test-${slot.key.toLowerCase()}`;
      const filled = fillPresetSlots(preset, values);
      // The suggested name matches the preset id (the CLI offers --name to change it).
      assert.equal(filled.name, preset.id);
      // No placeholder survives the fill.
      assert.doesNotMatch(JSON.stringify(filled), /\$\{[A-Za-z0-9_]+\}/);
      validateProfile({ ...filled, name: "preset-probe" });
    }
  });

  it("slot-less presets need no values", () => {
    for (const id of ["frugal", "reviewer"]) {
      const filled = fillPresetSlots(presetById(id)!, {});
      validateProfile({ ...filled, name: "preset-probe" });
    }
  });

  it("missing slot values throw naming the slot", () => {
    assert.throws(
      () => fillPresetSlots(presetById("solo")!, {}),
      /SUBSCRIPTION.*Claude subscription account/,
    );
    assert.throws(
      () => fillPresetSlots(presetById("heavy-opus")!, { SUBSCRIPTION: "a" }),
      /KEY.*OpenRouter key account/,
    );
  });

  it("heavy-opus routes Opus to the key account, base to the subscription", () => {
    const filled = fillPresetSlots(presetById("heavy-opus")!, {
      SUBSCRIPTION: "personal",
      KEY: "main",
    });
    assert.equal(filled.subscriptionAccountId, "personal");
    assert.equal(filled.modelRoutes?.length, 1);
    assert.equal(filled.modelRoutes?.[0]?.providerAccountId, "main");
  });

  it("reviewer preset inlines the reviewer prompt snippet", () => {
    const reviewer = PROMPT_PRESETS.find((p) => p.id === "reviewer")!;
    const filled = fillPresetSlots(presetById("reviewer")!, {});
    assert.equal(filled.session?.permissionMode, "plan");
    assert.equal(filled.session?.appendSystemPrompt, reviewer.text);
  });

  it("prompt presets ship reviewer/planner/explainer", () => {
    assert.deepEqual(
      PROMPT_PRESETS.map((p) => p.id),
      ["reviewer", "planner", "explainer"],
    );
    for (const preset of PROMPT_PRESETS) {
      assert.match(preset.text, /\S/);
    }
  });
});
