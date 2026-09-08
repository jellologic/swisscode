// Session-context reader: transcript + workflow sidecars + agent defs.
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findClaudeSession, readFileHead, readSessionContext } from "./sessionContext.js";

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

  it("stops reading a huge transcript at the byte cap", async () => {
    const home = await mkdtemp(join(tmpdir(), "swisscode-session-"));
    const proj = join(home, ".claude", "projects", "-huge-proj");
    await mkdir(proj, { recursive: true });
    const first = JSON.stringify({
      type: "user",
      cwd: "/work",
      message: { role: "user", content: "first" },
    });
    // Everything past the cap must stay unread: a Workflow call and a second
    // prompt live there, so their absence proves the cap bit at the read.
    const beyond = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_x", name: "Workflow", input: { script: "x".repeat(500_000) } },
          ],
        },
      }),
      JSON.stringify({ type: "user", message: { role: "user", content: "second" } }),
    ];
    const path = join(proj, "huge1.jsonl");
    await writeFile(path, `${[first, ...beyond].join("\n")}\n`);
    const cap = Buffer.byteLength(first) + 1;
    const ctx = await readSessionContext("huge1", { home, maxTranscriptBytes: cap });
    assert.ok(ctx);
    assert.equal(ctx.transcriptEntries, 1);
    assert.equal(ctx.userPrompts, 1);
    assert.equal(ctx.firstPrompt, "first");
    assert.deepEqual(ctx.toolTally, []);
    assert.deepEqual(ctx.workflowScripts, []);
  });

  it("reads a multi-gigabyte transcript without loading it", async () => {
    const home = await mkdtemp(join(tmpdir(), "swisscode-session-"));
    const proj = join(home, ".claude", "projects", "-sparse-proj");
    await mkdir(proj, { recursive: true });
    const path = join(proj, "huge2.jsonl");
    await writeFile(
      path,
      `${JSON.stringify({ type: "user", message: { role: "user", content: "first" } })}\n`,
    );
    // Sparse extension: 3 GiB of holes cost no blocks, but a whole-file read
    // would allocate gigabytes or throw ERR_FS_FILE_TOO_LARGE.
    await truncate(path, 3 * 1024 ** 3);
    const ctx = await readSessionContext("huge2", { home, maxTranscriptBytes: 4_096 });
    assert.ok(ctx);
    assert.equal(ctx.firstPrompt, "first");
    assert.equal(ctx.transcriptEntries, 1);
  });
});

describe("readFileHead", () => {
  it("reads at most the cap, never the whole file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swisscode-head-"));
    const path = join(dir, "big.txt");
    await writeFile(path, "z".repeat(500_000));
    const head = await readFileHead(path, 1_000);
    assert.ok(head);
    assert.equal(head.bytesRead, 1_000);
    assert.equal(head.text.length, 1_000);
    assert.equal(head.truncated, true);
  });

  it("reads a short file whole and reports it complete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swisscode-head-"));
    const path = join(dir, "small.txt");
    await writeFile(path, "hello\n");
    const head = await readFileHead(path, 1_000);
    assert.deepEqual(head, { text: "hello\n", bytesRead: 6, truncated: false });
  });

  it("returns null for a missing file instead of throwing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swisscode-head-"));
    assert.equal(await readFileHead(join(dir, "nope.txt"), 10), null);
  });
});
