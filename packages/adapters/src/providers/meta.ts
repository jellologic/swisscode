// Adapter: Meta provider (Meta Model API, Muse Spark models).
// Maps stored config to the ANTHROPIC_* env vars Claude Code understands,
// pointed at Meta's Anthropic-compatible endpoint: Claude Code sends
// {BASE}/v1/messages with the bearer key and gets Anthropic-protocol answers.

import type { ProviderPort } from "@swisscode/core";

export const META_BASE_URL = "https://api.meta.ai";

/** Current flagship Spark model; the account default when nothing else is set. */
export const META_DEFAULT_MODEL = "muse-spark-1.3-contributor";

export const metaProvider: ProviderPort = {
  id: "meta",
  displayName: "Meta",
  description: "Muse Spark models via Meta's Anthropic-compatible endpoint.",
  accountCapabilities: {
    importActive: false,
    usageMetrics: false,
    modelCatalog: true,
    modelEndpoints: false,
    connectionTest: true,
    switchVia: [],
    hint: "Store API keys once, reference them from profiles.",
  },
  help: {
    summary:
      "Muse Spark models through Meta's Anthropic-compatible endpoint. Store the key once, pick models from the live catalog.",
    setup: [
      "Get a key (MODEL_API_KEY) at dev.meta.ai.",
      "On /accounts, add a Meta account with the key.",
      "Pick a default model from the catalog suggestions.",
      "Create a profile with the Meta provider and launch it.",
    ],
    commands: ["swisscode accounts --provider meta models"],
    links: [{ label: "Meta Model API docs", href: "https://dev.meta.ai/docs/" }],
  },
  fields: [
    {
      key: "apiKey",
      label: "API Key",
      secret: true,
      required: true,
      placeholder: "LLM_...",
      help: "MODEL_API_KEY from https://dev.meta.ai",
    },
    {
      key: "model",
      label: "Default Model",
      secret: false,
      required: false,
      placeholder: META_DEFAULT_MODEL,
      help: "Used when the profile has no model override.",
    },
  ],

  buildEnv(
    config: Record<string, string> | undefined,
    profile: { model?: string },
  ): Record<string, string> {
    const apiKey = (config?.["apiKey"] ?? "").trim();
    // Profile-level model wins; fall back to the provider default model,
    // then the flagship — Meta rejects requests without a known model id.
    const model =
      (profile.model ?? "").trim() ||
      (config?.["model"] ?? "").trim() ||
      META_DEFAULT_MODEL;
    // Claude Code routes its internal tiers (opus/sonnet/haiku) and subagents
    // by model name; without these it requests Claude ids Meta rejects.
    return {
      ANTHROPIC_BASE_URL: META_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: apiKey,
      ANTHROPIC_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
    };
  },
};
