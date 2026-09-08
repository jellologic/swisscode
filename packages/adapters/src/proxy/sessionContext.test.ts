// Session-context reader: transcript + workflow sidecars + agent defs.
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findClaudeSession, readSessionContext } from "./sessionContext.js";

const SID = "cf868b08-45c5-4313-9e32-fa2edf88df43";

async function fakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "swisscode-session-"));
  const proj = join(home, ".claude", "projects", "-test-proj");
  await mkdir(proj, { recursive: true });
  const lines = [
    JSON.stringify({ type: "mode", mode: "normal", sessionId: SID }),
    JSON.stringify({
      type: "attachment",
      attachment: { type: "environment", snapshot: { workingDirectory: "/repo" } },
    }),
    JSON.stringify({
      type: "user",
      message: { role: "user", content: "build the thing" },
      uuid: "u1",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_wf",
            name: "Workflow",
            input: {
              script:
                "export const meta = {\n  name: 'mine-and-plan',\n  description: 'Mine the repo and plan',\n  phases: [\n    { title: 'Mine', detail: 'read the code' },\n    { title: 'Plan', detail: 'write the plan' },\n  ],\n}\nconst x = 1;\n",
            },
          },
          {
            type: "tool_use",
            id: "toolu_task",
            name: "Task",
            input: {
              subagent_type: "Explore",
              description: "Explore repo",
              prompt: "Explore the repository structure and report back.",
            },
          },
        ],
      },
      uuid: "a1",
    }),
    "not-json{{{",
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
  ];
  await writeFile(join(proj, `${SID}.jsonl`), `${lines.join("\n")}\n`);
  const wf = join(proj, SID, "subagents", "workflows", "wf_1");
  await mkdir(wf, { recursive: true });
  await writeFile(
    join(wf, "journal.jsonl"),
    `${JSON.stringify({ type: "started", key: "k1", agentId: "abc123" })}\n${
      JSON.stringify({
        type: "result",
        key: "k1",
        agentId: "abc123",
        result: { area: "repo map", summary: "The repo has three packages." },
      })
    }\n`,
  );
  await writeFile(join(wf, "agent-abc123.meta.json"), JSON.stringify({ agentType: "workflow-subagent", spawnDepth: 1 }));
  await writeFile(
    join(wf, "agent-abc123.jsonl"),
    `${JSON.stringify({ type: "user", message: { role: "user", content: "Map the repo packages." } })}\n`,
  );
  await mkdir(join(home, ".claude", "agents"), { recursive: true });
  await writeFile(join(home, ".claude", "agents", "Explore.md"), "# Explore\nFast codebase explorer.\n");
  return home;
}

describe("findClaudeSession", () => {
  it("locates the transcript across project slugs", async () => {
    const home = await fakeHome();
    const found = await findClaudeSession(SID, home);
    assert.ok(found);
    assert.ok(found.transcriptPath.endsWith(`${SID}.jsonl`));
  });

  it("returns null for unknown sessions and rejects path tricks", async () => {
    const home = await fakeHome();
    assert.equal(await findClaudeSession("nope-nope", home), null);
    assert.equal(await findClaudeSession("../evil", home), null);
    assert.equal(await findClaudeSession("a/b", home), null);
  });
});

describe("readSessionContext", () => {
  it("reads prompts, workflow script meta, and task launches", async () => {
    const home = await fakeHome();
    const ctx = await readSessionContext(SID, { home });
    assert.ok(ctx);
    assert.equal(ctx.sessionId, SID);
    assert.equal(ctx.cwd, "/repo");
    assert.equal(ctx.firstPrompt, "build the thing");
    assert.equal(ctx.userPrompts, 1);
    assert.ok(ctx.transcriptEntries > 0);
    assert.deepEqual(ctx.toolTally, [
      { name: "Workflow", count: 1 },
      { name: "Task", count: 1 },
    ]);
    assert.equal(ctx.workflowScripts.length, 1);
    const script = ctx.workflowScripts[0]!;
    assert.equal(script.toolId, "toolu_wf");
    assert.equal(script.name, "mine-and-plan");
    assert.equal(script.description, "Mine the repo and plan");
    assert.deepEqual(script.phases, [
      { title: "Mine", detail: "read the code" },
      { title: "Plan", detail: "write the plan" },
    ]);
    assert.equal(script.scriptTruncated, false);
    assert.ok(script.script.includes("const x = 1;"));
    assert.equal(ctx.taskLaunches.length, 1);
    assert.deepEqual(ctx.taskLaunches[0], {
      toolId: "toolu_task",
      subagentType: "Explore",
      description: "Explore repo",
      promptHead: "Explore the repository structure and report back.",
    });
  });

  it("reads workflow agents from journal, metas, and agent transcripts", async () => {
    const home = await fakeHome();
    const ctx = await readSessionContext(SID, { home });
    assert.ok(ctx);
    assert.equal(ctx.workflowAgents.length, 1);
    assert.deepEqual(ctx.workflowAgents[0], {
      agentId: "abc123",
      workflowId: "wf_1",
      agentType: "workflow-subagent",
      spawnDepth: 1,
      promptHead: "Map the repo packages.",
      resultArea: "repo map",
      resultSummary: "The repo has three packages.",
      finished: true,
    });
  });

  it("resolves agent definitions for launched subagent types", async () => {
    const home = await fakeHome();
    const ctx = await readSessionContext(SID, { home });
    assert.ok(ctx);
    assert.equal(ctx.agentDefinitions.length, 1);
    assert.equal(ctx.agentDefinitions[0]!.name, "Explore");
    assert.ok(ctx.agentDefinitions[0]!.path.endsWith("Explore.md"));
    assert.ok(ctx.agentDefinitions[0]!.head.includes("Fast codebase explorer."));
  });

  it("returns null for missing sessions and never throws", async () => {
    const home = await fakeHome();
    assert.equal(await readSessionContext("missing", { home }), null);
    assert.equal(await readSessionContext("..", { home }), null);
  });

  it("reads top-level entry cwd when no environment attachment exists", async () => {
    const home = await mkdtemp(join(tmpdir(), "swisscode-session-"));
    const proj = join(home, ".claude", "projects", "-cwd-proj");
    await mkdir(proj, { recursive: true });
    await writeFile(
      join(proj, "abc123.jsonl"),
      `${JSON.stringify({ type: "user", cwd: "/work/here", message: { role: "user", content: "hi" } })}\n`,
    );
    const ctx = await readSessionContext("abc123", { home });
    assert.ok(ctx);
    assert.equal(ctx.cwd, "/work/here");
  });

  it("truncates long scripts with a flag", async () => {
    const home = await fakeHome();
    const ctx = await readSessionContext(SID, { home, maxScriptChars: 10 });
    assert.ok(ctx);
    assert.equal(ctx.workflowScripts[0]!.scriptTruncated, true);
    assert.ok(ctx.workflowScripts[0]!.script.length <= 11);
  });
});
