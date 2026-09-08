// Adapter: Claude Code coding agent.
// Knows the `claude` binary and which env vars steer its model.
// Provider endpoint/auth arrives via providerEnv; model override via profile.

import type { AgentPort, LaunchSpec, Profile } from "@swisscode/core";

export const claudeCodeAgent: AgentPort = {
  id: "claude-code",
  displayName: "Claude Code",
  description: "Anthropic's Claude Code CLI (`claude` binary).",
  command: "claude",
  defaultArgs: [],

  buildLaunch(profile: Profile, providerEnv: Record<string, string>): LaunchSpec {
    const env: Record<string, string> = { ...providerEnv };
    // Model override: Claude Code respects ANTHROPIC_MODEL.
    if (profile.model?.trim()) {
      env["ANTHROPIC_MODEL"] ??= profile.model.trim();
    }
    const args = [...(profile.agentArgs ?? [])];
    return { command: "claude", args, env };
  },
};
