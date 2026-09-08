// Claude Code session emission: pure flag/settings/file builders over
// Profile.session. No I/O here — these functions return argv fragments, a
// settings object and file *descriptors*; only the real CLI launch path
// materializes the descriptors (adapters' writeEphemeralFiles), so `show`,
// `--dry-run` and the web UI render the same output without touching the
// filesystem. The user's own settings files are never rewritten: everything
// goes through one ephemeral `--settings` file (managed > --settings >
// local > project > user, so org policy still wins — surfaced in UI copy).

import type { ClaudeSessionOptions, EphemeralFile, Profile } from "./domain.js";
import { isDeniedEnvName } from "./envPolicy.js";
import { ProfileError } from "./service.js";

/** Validated `--effort` levels, exactly as `claude -h` lists them. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Validated `--permission-mode` choices, exactly as `claude -h` lists them. */
export const PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "manual",
  "dontAsk",
  "plan",
] as const;

/** Validated `--setting-sources` layers. Omit the field = load all layers. */
export const SETTING_SOURCES = ["user", "project", "local"] as const;

/**
 * Placeholder for the ephemeral dir inside emitted argv. The adapter cannot
 * know the temp dir (the CLI picks it at launch), so flags reference
 * `<TOKEN>/settings.json`; the materializer rewrites the token to the real
 * dir after writing the files. `show`/`--dry-run` display the token form plus
 * the file contents.
 */
export const EPHEMERAL_DIR_TOKEN = "__SWISSCODE_EPHEMERAL_DIR__";

export const SETTINGS_FILE_REL = "settings.json";
export const MCP_FILE_REL = "mcp.json";

/**
 * True when the value reads as inline JSON rather than a file path: the
 * trimmed text starts with `{` or `[`. A filesystem path can never parse as
 * JSON, so the reading is unambiguous.
 */
export function isInlineJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function fail(profileName: string, what: string): never {
  throw new ProfileError(`Profile "${profileName}" session.${what}`);
}

/**
 * Structural-plus-value checks for `profile.session`. Shape (right primitive
 * types) stays with the shape guard; everything here needs a value judgement:
 * enum membership, non-blank entries, inline-JSON parseability. Throws
 * ProfileError naming the offending field.
 */
export function validateSessionOptions(
  profile: Pick<Profile, "name" | "session">,
): void {
  const session = profile.session;
  if (session === undefined) return;
  const name = profile.name;

  if (session.effort !== undefined && !(EFFORT_LEVELS as readonly string[]).includes(session.effort)) {
    fail(name, `effort must be one of ${EFFORT_LEVELS.join("|")} (got ${JSON.stringify(session.effort)}).`);
  }
  if (
    session.permissionMode !== undefined &&
    !(PERMISSION_MODES as readonly string[]).includes(session.permissionMode)
  ) {
    fail(
      name,
      `permissionMode must be one of ${PERMISSION_MODES.join("|")} (got ${JSON.stringify(session.permissionMode)}).`,
    );
  }
  for (const [key, values] of [
    ["allowedTools", session.allowedTools],
    ["disallowedTools", session.disallowedTools],
    ["addDirs", session.addDirs],
    ["fallbackModel", session.fallbackModel],
  ] as const) {
    if (values === undefined) continue;
    if (values.length === 0) {
      fail(name, `${key} needs at least one entry — omit it for none.`);
    }
    // Shape guard already proved string[]; emptiness is the value judgement.
    const bad = values.findIndex((v) => !nonEmpty(v));
    if (bad !== -1) {
      fail(name, `${key}[${bad}] must be a non-empty string — omit the entry instead of blanking it.`);
    }
  }
  // `tools` is the one string field where "" is meaningful (`--tools ""`
  // disables every tool), so any string passes — including "".
  for (const key of ["systemPrompt", "appendSystemPrompt", "promptPreset", "agent", "mcpConfig"] as const) {
    const value = session[key];
    if (value !== undefined && !nonEmpty(value)) {
      fail(name, `${key} must be a non-empty string — omit it instead of blanking it.`);
    }
  }
  if (session.settingSources !== undefined) {
    if (session.settingSources.length === 0) {
      fail(name, "settingSources needs at least one of user|project|local — omit it to load all layers.");
    }
    const bad = session.settingSources.find(
      (s) => !(SETTING_SOURCES as readonly string[]).includes(s),
    );
    if (bad !== undefined) {
      fail(name, `settingSources must be a subset of user|project|local (got ${JSON.stringify(bad)}).`);
    }
  }
  if (session.mcpConfig !== undefined && isInlineJson(session.mcpConfig)) {
    try {
      JSON.parse(session.mcpConfig);
    } catch {
      fail(name, "mcpConfig looks like inline JSON but does not parse — fix it or point at a file.");
    }
  }
}

/**
 * The merged ephemeral settings payload. Free-form `claudeSettings` go in
 * first so the curated fields win on conflict — a validated enum beats a raw
 * typo. Returns {} when the session contributes nothing, in which case the
 * caller emits no file and no `--settings` flag (absent = today's behavior).
 *
 * `settings.env` gets the same code-loading deny list as the launch env
 * (existing strip rule, both sides): a stored profile must never be a vector
 * for PATH/NODE_OPTIONS injection into the agent or its subprocesses.
 */
export function buildClaudeSettings(session: ClaudeSessionOptions): Record<string, unknown> {
  const settings: Record<string, unknown> = { ...(session.claudeSettings ?? {}) };
  if (session.fallbackModel !== undefined && session.fallbackModel.length > 0) {
    settings["fallbackModel"] = session.fallbackModel.map((m) => m.trim());
  }
  const env = settings["env"];
  if (env !== undefined && env !== null && typeof env === "object" && !Array.isArray(env)) {
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (typeof v !== "string" || isDeniedEnvName(k)) continue;
      clean[k] = v;
    }
    settings["env"] = clean;
  }
  return settings;
}

/** File descriptors for this session: settings JSON and/or inline MCP JSON. */
export function sessionEphemeralFiles(session: ClaudeSessionOptions): EphemeralFile[] {
  const files: EphemeralFile[] = [];
  if (Object.keys(buildClaudeSettings(session)).length > 0) {
    files.push({
      rel: SETTINGS_FILE_REL,
      content: `${JSON.stringify(buildClaudeSettings(session), null, 2)}\n`,
      mode: 0o600,
    });
  }
  if (session.mcpConfig !== undefined && isInlineJson(session.mcpConfig)) {
    files.push({ rel: MCP_FILE_REL, content: session.mcpConfig.trim(), mode: 0o600 });
  }
  return files;
}

/**
 * Explicit argv fragment for this session, in stable curated order. Emits
 * `--settings` / `--mcp-config` with the ephemeral-dir token (rewritten at
 * materialization time) only when the matching descriptor exists. Print-only
 * upstream flags (`--fallback-model`, `--max-budget-usd`) are deliberately
 * never emitted — fallback travels as the `fallbackModel` settings key.
 * The caller appends `agentArgs` AFTER these so power users override.
 */
export function buildClaudeFlags(session: ClaudeSessionOptions): string[] {
  const flags: string[] = [];
  if (session.effort !== undefined) flags.push("--effort", session.effort);
  if (session.permissionMode !== undefined) flags.push("--permission-mode", session.permissionMode);
  for (const tool of session.allowedTools ?? []) flags.push("--allowedTools", tool);
  for (const tool of session.disallowedTools ?? []) flags.push("--disallowedTools", tool);
  // "" is meaningful here (disables every tool), so emit whenever defined.
  if (session.tools !== undefined) flags.push("--tools", session.tools);
  for (const dir of session.addDirs ?? []) flags.push("--add-dir", dir);
  if (session.systemPrompt !== undefined) flags.push("--system-prompt", session.systemPrompt);
  if (session.appendSystemPrompt !== undefined) {
    flags.push("--append-system-prompt", session.appendSystemPrompt);
  }
  if (session.agent !== undefined) flags.push("--agent", session.agent);
  if (session.mcpConfig !== undefined) {
    flags.push(
      "--mcp-config",
      isInlineJson(session.mcpConfig)
        ? `${EPHEMERAL_DIR_TOKEN}/${MCP_FILE_REL}`
        : session.mcpConfig,
    );
  }
  if (session.strictMcp === true) flags.push("--strict-mcp-config");
  if (session.settingSources !== undefined && session.settingSources.length > 0) {
    flags.push("--setting-sources", session.settingSources.join(","));
  }
  if (Object.keys(buildClaudeSettings(session)).length > 0) {
    flags.push("--settings", `${EPHEMERAL_DIR_TOKEN}/${SETTINGS_FILE_REL}`);
  }
  return flags;
}

/**
 * Rewrite the ephemeral-dir token to the real dir after the CLI materializes
 * the descriptors. Pure string mapping — one place so CLI and tests agree.
 */
export function resolveEphemeralPaths(args: string[], dir: string): string[] {
  return args.map((a) => a.split(EPHEMERAL_DIR_TOKEN).join(dir));
}
