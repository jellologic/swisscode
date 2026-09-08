// Adapter: Claude Code coding agent.
// Knows the `claude` binary and which env vars steer its model.
// Provider endpoint/auth arrives via providerEnv; model override via profile.

import type { AgentPort, LaunchSpec, Profile } from "@swisscode/core";
import { buildClaudeFlags, sessionEphemeralFiles } from "@swisscode/core";

export const claudeCodeAgent: AgentPort = {
  id: "claude-code",
  displayName: "Claude Code",
  description: "Anthropic's Claude Code CLI (`claude` binary).",
  command: "claude",
  defaultArgs: [],
  help: {
    summary:
      "Claude Code CLI driven by environment: swisscode sets the provider endpoint, auth token, and model, then runs `claude`.",
    setup: [
      "Install Claude Code. Log in (`claude login`) when you plan to use the Claude Subscription provider.",
      "Create a profile pairing claude-code with an AI provider.",
      "Launch with `swisscode <profileName>` — extra args after `--` go to `claude`.",
    ],
    commands: ["swisscode <profileName>", "swisscode show <profileName>"],
  },

  buildLaunch(profile: Profile, providerEnv: Record<string, string>): LaunchSpec {
    const env: Record<string, string> = { ...providerEnv };
    const args: string[] = [];
    // Model override: `--model` wins over env, but ANTHROPIC_MODEL stays as
    // back-compat for anything that reads the env (older wrappers, subshells).
    if (profile.model?.trim()) {
      args.push("--model", profile.model.trim());
      env["ANTHROPIC_MODEL"] ??= profile.model.trim();
    }
    // Curated session fields emit first; agentArgs appends so power users
    // override (visible in show/--dry-run final order). Stays pure: flags
    // reference the ephemeral-dir token, file contents ride as descriptors —
    // only the real CLI launch path materializes them.
    if (profile.session) {
      args.push(...buildClaudeFlags(profile.session));
    }
    args.push(...(profile.agentArgs ?? []));
    const ephemeralFiles = profile.session ? sessionEphemeralFiles(profile.session) : [];
    return {
      command: "claude",
      args,
      env,
      ...(ephemeralFiles.length > 0 ? { ephemeralFiles } : {}),
    };
  },
};
