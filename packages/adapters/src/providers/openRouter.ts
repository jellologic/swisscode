// Adapter: OpenRouter provider.
// Maps stored config to the ANTHROPIC_* env vars Claude Code understands,
// pointed at OpenRouter's Anthropic-compatible endpoint.

import type { ProviderPort } from "@swisscode/core";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export const openRouterProvider: ProviderPort = {
  id: "openrouter",
  displayName: "OpenRouter",
  description: "Any OpenRouter model via the Anthropic-compatible endpoint.",
  fields: [
    {
      key: "apiKey",
      label: "API Key",
      secret: true,
      required: true,
      placeholder: "sk-or-...",
      help: "From https://openrouter.ai/keys",
    },
    {
      key: "model",
      label: "Default Model",
      secret: false,
      required: false,
      placeholder: "anthropic/claude-sonnet-4",
      help: "Used when the profile has no model override.",
    },
  ],

  buildEnv(
    config: Record<string, string> | undefined,
    profile: { model?: string },
  ): Record<string, string> {
    const apiKey = (config?.["apiKey"] ?? "").trim();
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: OPENROUTER_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: apiKey,
    };
    // Profile-level model wins; fall back to the provider default model.
    const model = (profile.model ?? "").trim() || (config?.["model"] ?? "").trim();
    if (model) {
      env["ANTHROPIC_MODEL"] = model;
    }
    return env;
  },
};
