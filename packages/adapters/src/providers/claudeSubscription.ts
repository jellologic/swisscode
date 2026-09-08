// Adapter: Claude Subscription provider.
// Uses the user's existing `claude login` session — no env vars needed.
// buildEnv returns {} so launches inherit a clean provider slate.

import type { ProviderPort } from "@swisscode/core";

export const claudeSubscriptionProvider: ProviderPort = {
  id: "claude-subscription",
  displayName: "Claude Subscription",
  description: "Your existing Claude login (no API key needed).",
  fields: [],

  buildEnv(): Record<string, string> {
    return {};
  },
};
