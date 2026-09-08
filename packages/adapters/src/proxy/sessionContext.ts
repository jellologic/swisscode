// Session context: the local Claude Code session behind a proxy thread.
// The proxy sees API turns; the rest lives on disk under ~/.claude:
// - projects/<slug>/<sessionId>.jsonl — the full transcript, including the
//   Workflow tool call whose input.script is the orchestration source and
//   Task calls whose input carries each subagent's prompt.
// - projects/<slug>/<sessionId>/subagents/workflows/<wfId>/{journal.jsonl,
//   agent-<id>.jsonl, agent-<id>.meta.json} — workflow-subagent branches:
//   journal has started/result records with summaries, metas carry the
//   agent type, agent transcripts carry each branch's prompt.
// - agents/<name>.md — user-level agent definitions backing subagent_type.
// All reads are bounded and failure-safe: unknown sessions, huge files, or
// malformed lines yield null/empty fields, never a throw.

import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A Workflow tool call found in the transcript, with its script source. */
export interface SessionWorkflowScript {
  toolId: string;
  /** Workflow name from `export const meta = { name }`, when present. */
  name?: string;
  description?: string;
  phases: { title: string; detail?: string }[];
  scriptChars: number;
  /** Script source, truncated to the read cap. */
  script: string;
  scriptTruncated: boolean;
}

/** A Task/Agent tool call: a subagent launched through the API. */
export interface SessionTaskLaunch {
  toolId: string;
  subagentType?: string;
  description?: string;
  /** Launch prompt head, truncated. */
  promptHead?: string;
}

/** One workflow-subagent branch from a workflow journal + agent files. */
export interface SessionWorkflowAgent {
  agentId: string;
  workflowId: string;
  agentType?: string;
  spawnDepth?: number;
  /** First user-message head of the agent's transcript (its assignment). */
  promptHead?: string;
  /** Journal result area/summary, when the branch finished. */
  resultArea?: string;
  resultSummary?: string;
  finished: boolean;
}

/** A user-level agent definition backing a subagent_type name. */
export interface SessionAgentDefinition {
  name: string;
  path: string;
  /** File head, truncated. */
  head: string;
}

/** Local context for one Claude Code session id. */
export interface SessionContext {
  sessionId: string;
  transcriptPath: string;
  cwd?: string;
  /** Preview of the first user prompt (what started the run). */
  firstPrompt?: string;
  userPrompts: number;
  transcriptEntries: number;
  toolTally: { name: string; count: number }[];
  workflowScripts: SessionWorkflowScript[];
  taskLaunches: SessionTaskLaunch[];
  workflowAgents: SessionWorkflowAgent[];
  agentDefinitions: SessionAgentDefinition[];
}

export interface ReadSessionContextOptions {
  /** Home directory override (tests). Defaults to os.homedir(). */
  home?: string;
  /** Max transcript bytes parsed. Default 24MB. */
  maxTranscriptBytes?: number;
  /** Max workflow script chars kept per script. Default 12000. */
  maxScriptChars?: number;
  /** Max workflow agents reported. Default 24. */
  maxAgents?: number;
  /** subagent_type names to resolve against ~/.claude/agents. */
  agentNames?: string[];
}

const MAX_TRANSCRIPT_BYTES = 24_000_000;
const MAX_SCRIPT_CHARS = 12_000;
const MAX_AGENTS = 24;
const MAX_HEAD_CHARS = 600;
/** Only the head of an agent definition is shown, so only the head is read. */
const MAX_AGENT_DEF_BYTES = 2_000;
const MAX_WORKFLOWS = 8;
const MAX_TALLY = 12;

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function oneLine(text: string, max = MAX_HEAD_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** What a bounded head read saw: decoded text plus how much of the file it is. */
export interface FileHead {
  text: string;
  bytesRead: number;
  /** The file is longer than what was read, so `text` ends mid-record. */
  truncated: boolean;
}

/**
 * Read at most `maxBytes` from the head of a file. Transcripts reach many
 * gigabytes, so the cap has to bound the syscall — reading the whole file and
 * slicing afterwards buys the cap at the cost of the memory it was meant to
 * save. Never throws: an unreadable file is null.
 */
export async function readFileHead(path: string, maxBytes: number): Promise<FileHead | null> {
  const fh = await open(path, "r").catch(() => null);
  if (!fh) return null;
  try {
    const size = (await fh.stat()).size;
    const want = Math.max(0, Math.min(maxBytes, size));
    const buf = Buffer.allocUnsafe(want);
    let bytesRead = 0;
    // read(2) may come up short of the request; loop until full or EOF.
    while (bytesRead < want) {
      const chunk = await fh.read(buf, bytesRead, want - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    return {
      text: buf.subarray(0, bytesRead).toString("utf8"),
      bytesRead,
      truncated: size > bytesRead,
    };
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Message text of a transcript entry (string or text-block content). */
function entryText(message: unknown): string | undefined {
  const msg = asRecord(message);
  if (!msg) return undefined;
  const content = msg["content"];
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = asRecord(block);
      if (!b) continue;
      if (typeof b["text"] === "string") parts.push(b["text"] as string);
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

function toolUses(message: unknown): { id?: string; name?: string; input?: Record<string, unknown> }[] {
  const msg = asRecord(message);
  if (!msg) return [];
  const content = msg["content"];
  if (!Array.isArray(content)) return [];
  const out: { id?: string; name?: string; input?: Record<string, unknown> }[] = [];
  for (const block of content) {
    const b = asRecord(block);
    if (b?.["type"] !== "tool_use") continue;
    out.push({
      ...(typeof b["id"] === "string" ? { id: b["id"] as string } : {}),
      ...(typeof b["name"] === "string" ? { name: b["name"] as string } : {}),
      ...(asRecord(b["input"]) ? { input: asRecord(b["input"])! } : {}),
    });
  }
  return out;
}

/** Pull `export const meta = { name, description, phases }` from script source. */
function parseWorkflowMeta(script: string): {
  name?: string;
  description?: string;
  phases: { title: string; detail?: string }[];
} {
  const out: { title: string; detail?: string }[] = [];
  // Prefer the meta block when present; fall back to first hits in source.
  const metaBlock = /export\s+const\s+meta\s*=\s*\{([\s\S]{0,4000}?)\n\}/.exec(script)?.[1];
  const scope = metaBlock ?? script;
  const name = quotedAfter(scope, /name\s*:/);
  const description = quotedAfter(scope, /description\s*:/);
  if (metaBlock !== undefined) {
    for (const m of metaBlock.matchAll(/title\s*:\s*(['"`])((?:\\\1|(?!\1).){0,200}?)\1/g)) {
      out.push({ title: m[2] ?? "" });
    }
    const details = [...metaBlock.matchAll(/detail\s*:\s*(['"`])((?:\\\1|(?!\1).){0,300}?)\1/g)].map(
      (m) => m[2] ?? "",
    );
    out.forEach((p, i) => {
      if (details[i]) p.detail = details[i];
    });
  }
  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    phases: out,
  };
}

function quotedAfter(source: string, key: RegExp): string | undefined {
  const re = new RegExp(key.source + "\\s*(['\"`])((?:\\\\\\1|(?!\\1).){0,500}?)\\1");
  return re.exec(source)?.[2];
}

/** Locate a session's transcript + sidecar dir under ~/.claude/projects. */
export async function findClaudeSession(
  sessionId: string,
  home: string = homedir(),
): Promise<{ transcriptPath: string; dir: string } | null> {
  if (!SESSION_ID_RE.test(sessionId)) return null;
  let slugs: string[];
  try {
    slugs = await readdir(join(home, ".claude", "projects"));
  } catch {
    return null;
  }
  for (const slug of slugs) {
    if (slug.startsWith(".")) continue;
    const candidate = join(home, ".claude", "projects", slug, `${sessionId}.jsonl`);
    try {
      const st = await stat(candidate);
      if (st.isFile()) {
        return { transcriptPath: candidate, dir: join(home, ".claude", "projects", slug, sessionId) };
      }
    } catch {
      // Not in this project slug; keep scanning.
    }
  }
  return null;
}

async function readAgentPromptHead(path: string, maxBytes: number): Promise<string | undefined> {
  const head = await readFileHead(path, maxBytes);
  if (!head) return undefined;
  for (const line of head.text.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const e = asRecord(parsed);
    if (e?.["type"] !== "user") continue;
    const text = entryText(e["message"]);
    if (text && text.trim() !== "") return oneLine(text);
  }
  return undefined;
}

interface JournalAgent {
  agentId: string;
  resultArea?: string;
  resultSummary?: string;
  finished: boolean;
}

async function readWorkflowDir(wfDir: string, workflowId: string, maxAgents: number): Promise<SessionWorkflowAgent[]> {
  const agents: SessionWorkflowAgent[] = [];
  let journal: JournalAgent[] = [];
  try {
    const raw = await readFile(join(wfDir, "journal.jsonl"), "utf8");
    const byId = new Map<string, JournalAgent>();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const e = asRecord(parsed);
      const agentId = asString(e?.["agentId"]);
      if (!agentId) continue;
      if (e?.["type"] === "started") {
        if (!byId.has(agentId)) byId.set(agentId, { agentId, finished: false });
      } else if (e?.["type"] === "result") {
        const result = asRecord(e["result"]);
        const rec = byId.get(agentId) ?? { agentId, finished: false };
        rec.finished = true;
        const area = asString(result?.["area"]);
        const summary = asString(result?.["summary"]);
        if (area) rec.resultArea = oneLine(area, 200);
        if (summary) rec.resultSummary = oneLine(summary);
        byId.set(agentId, rec);
      }
    }
    journal = [...byId.values()];
  } catch {
    journal = [];
  }
  let metas = new Map<string, { agentType?: string; spawnDepth?: number }>();
  try {
    const files = await readdir(wfDir);
    for (const f of files) {
      if (!f.endsWith(".meta.json")) continue;
      const agentId = f.slice("agent-".length, -".meta.json".length);
      try {
        const meta = asRecord(
          JSON.parse(await readFile(join(wfDir, f), "utf8")),
        );
        metas.set(agentId, {
          ...(asString(meta?.["agentType"]) ? { agentType: asString(meta?.["agentType"])! } : {}),
          ...(typeof meta?.["spawnDepth"] === "number"
            ? { spawnDepth: meta?.["spawnDepth"] as number }
            : {}),
        });
      } catch {
        // Malformed meta; the journal record still stands.
      }
    }
  } catch {
    metas = new Map();
  }
  const ids: JournalAgent[] =
    journal.length > 0
      ? journal
      : [...metas.keys()].map((agentId) => ({ agentId, finished: false }));
  for (const rec of ids.slice(0, maxAgents)) {
    const meta = metas.get(rec.agentId);
    const promptHead = await readAgentPromptHead(
      join(wfDir, `agent-${rec.agentId}.jsonl`),
      16_384,
    );
    agents.push({
      agentId: rec.agentId,
      workflowId,
      ...(meta?.agentType ? { agentType: meta.agentType } : {}),
      ...(meta?.spawnDepth !== undefined ? { spawnDepth: meta.spawnDepth } : {}),
      ...(promptHead ? { promptHead } : {}),
      ...(rec.resultArea ? { resultArea: rec.resultArea } : {}),
      ...(rec.resultSummary ? { resultSummary: rec.resultSummary } : {}),
      finished: rec.finished,
    });
  }
  return agents;
}

/**
 * Read the local context for a Claude Code session id: transcript prompts,
 * Workflow scripts, Task launches, workflow-subagent branches, and agent
 * definitions. Bounded, read-only, never throws (null = no local session).
 */
export async function readSessionContext(
  sessionId: string,
  opts: ReadSessionContextOptions = {},
): Promise<SessionContext | null> {
  const home = opts.home ?? homedir();
  const maxTranscriptBytes = opts.maxTranscriptBytes ?? MAX_TRANSCRIPT_BYTES;
  const maxScriptChars = opts.maxScriptChars ?? MAX_SCRIPT_CHARS;
  const maxAgents = opts.maxAgents ?? MAX_AGENTS;
  try {
    const found = await findClaudeSession(sessionId, home);
    if (!found) return null;
    const head = await readFileHead(found.transcriptPath, maxTranscriptBytes);
    if (!head || head.bytesRead === 0) return null;
    let raw = head.text;
    if (head.truncated) {
      // The cap lands mid-record; drop the cut trailing line (and with it any
      // partial multi-byte character the decoder replaced).
      const lastNewline = raw.lastIndexOf("\n");
      raw = lastNewline >= 0 ? raw.slice(0, lastNewline) : "";
    }
    const ctx: SessionContext = {
      sessionId,
      transcriptPath: found.transcriptPath,
      userPrompts: 0,
      transcriptEntries: 0,
      toolTally: [],
      workflowScripts: [],
      taskLaunches: [],
      workflowAgents: [],
      agentDefinitions: [],
    };
    const tally = new Map<string, number>();
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const e = asRecord(parsed);
      if (!e || typeof e["type"] !== "string") continue;
      ctx.transcriptEntries += 1;
      // Entries carry their working directory at top level; older sessions
      // only have it on the environment attachment.
      if (!ctx.cwd) {
        const cwd =
          asString(e["cwd"]) ??
          asString(asRecord(asRecord(e["attachment"])?.["snapshot"])?.["workingDirectory"]);
        if (cwd) ctx.cwd = cwd;
      }
      const type = e["type"] as string;
      if (type === "attachment") {
        // No per-entry facts beyond cwd; keep scanning.
      } else if (type === "user") {
        const text = entryText(e["message"]);
        if (text && text.trim() !== "") {
          ctx.userPrompts += 1;
          if (!ctx.firstPrompt) ctx.firstPrompt = oneLine(text, 300);
        }
      } else if (type === "assistant") {
        for (const use of toolUses(e["message"])) {
          if (!use.name) continue;
          tally.set(use.name, (tally.get(use.name) ?? 0) + 1);
          if (use.name === "Workflow" && ctx.workflowScripts.length < MAX_WORKFLOWS) {
            const script = asString(use.input?.["script"]) ?? "";
            const meta = parseWorkflowMeta(script);
            ctx.workflowScripts.push({
              ...(use.id ? { toolId: use.id } : { toolId: "" }),
              ...meta,
              scriptChars: script.length,
              script:
                script.length > maxScriptChars
                  ? `${script.slice(0, maxScriptChars)}…`
                  : script,
              scriptTruncated: script.length > maxScriptChars,
            });
          } else if (
            (use.name === "Task" || use.name === "Agent") &&
            ctx.taskLaunches.length < MAX_AGENTS
          ) {
            const prompt = asString(use.input?.["prompt"]);
            ctx.taskLaunches.push({
              ...(use.id ? { toolId: use.id } : { toolId: "" }),
              ...(asString(use.input?.["subagent_type"])
                ? { subagentType: asString(use.input?.["subagent_type"])! }
                : {}),
              ...(asString(use.input?.["description"])
                ? { description: asString(use.input?.["description"])! }
                : {}),
              ...(prompt ? { promptHead: oneLine(prompt) } : {}),
            });
          }
        }
      }
    }
    ctx.toolTally = [...tally.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_TALLY);
    // Workflow-subagent branches beside the transcript.
    try {
      const subDir = join(found.dir, "subagents", "workflows");
      const wfIds = await readdir(subDir);
      for (const wfId of wfIds.slice(0, MAX_WORKFLOWS)) {
        if (wfId.startsWith(".")) continue;
        const more = await readWorkflowDir(
          join(subDir, wfId),
          wfId,
          Math.max(0, maxAgents - ctx.workflowAgents.length),
        );
        ctx.workflowAgents.push(...more);
        if (ctx.workflowAgents.length >= maxAgents) break;
      }
    } catch {
      // No workflow sidecars for this session.
    }
    // Agent definitions backing Task-launched subagent types.
    const names = [...new Set([
      ...(opts.agentNames ?? []),
      ...ctx.taskLaunches.map((l) => l.subagentType).filter((n): n is string => !!n),
    ])].slice(0, MAX_AGENTS);
    for (const name of names) {
      if (!SESSION_ID_RE.test(name)) continue;
      const path = join(home, ".claude", "agents", `${name}.md`);
      const def = await readFileHead(path, MAX_AGENT_DEF_BYTES);
      // No user-level definition by that name, or an empty one.
      if (def && def.text.trim() !== "") {
        ctx.agentDefinitions.push({ name, path, head: oneLine(def.text, MAX_HEAD_CHARS) });
      }
    }
    return ctx;
  } catch {
    return null;
  }
}
