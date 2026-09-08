// Adapter: Claude Subscription provider.
// Uses the user's existing `claude login` session — no env vars needed.
// buildEnv returns {} so launches inherit a clean provider slate.

import type { ProviderPort } from "@swisscode/core";

export const claudeSubscriptionProvider: ProviderPort = {
  id: "claude-subscription",
  displayName: "Claude Subscription",
  description: "Your existing Claude login (no API key needed).",
  fields: [],
  accountCapabilities: {
    importActive: true,
    usageMetrics: true,
    switchVia: ["proxy", "file-swap"],
    hint: "Snapshot whichever Claude account is currently logged in, then switch between them.",
  },
  help: {
    summary:
      "Reuses your existing Claude Code login — no API key. Snapshot each login on /accounts, then switch between subscriptions.",
    setup: [
      "Log in to the account you want to keep (`claude login` or /login in Claude Code).",
      "On /accounts, import the current login with an id and label.",
      "Repeat for each subscription you hold.",
      "Point a profile at a stored account — directly (credential swap at launch) or via the proxy.",
    ],
    commands: ["swisscode accounts list", "swisscode accounts usage", "swisscode proxy run"],
  },

  buildEnv(): Record<string, string> {
    return {};
  },
};
