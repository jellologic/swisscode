// Thread page: one conversation at /proxy/<threadId> (the session/resume id
// for session runs) rendered as a timeline. Every turn is a node with its
// verdict, reply, tools, and usage; the latest turn renders its full detail
// inline, earlier turns expand in place.

import { useEffect } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { Badge, Card, Code, Disclosure, Muted, Notice, Page, Pre, Stack } from "../../design";
import { proxySessionContextFn, proxyTrafficFn } from "../../lib/functions";
import type { ProxyTrafficItem } from "../../lib/store.server";
import type { SessionContext, TrafficConversation } from "@swisscode/adapters";
import {
  EntryDetail,
  Fact,
  fmtSpan,
  launchLabel,
  statusTone,
  type FollowupResults,
} from "../../components/TrafficEntryDetail";
import { ago } from "../../components/ModelPicker";

export const Route = createFileRoute("/proxy/$threadId")({
  validateSearch: (search: Record<string, unknown>) => ({
    profile: typeof search["profile"] === "string" ? search["profile"] : "",
  }),
  loader: async ({ params }) => {
    const traffic = await proxyTrafficFn({ data: {} });
    const conversation =
      traffic.conversations.find((c) => c.id === params.threadId) ?? null;
    if (!conversation) throw new Error(`Unknown thread "${params.threadId}".`);
    // Latest turn renders expanded; earlier turns expand in place.
    const index = conversation.indexes[conversation.indexes.length - 1]!;
    // Local session behind the thread: transcript, Workflow scripts,
    // subagent branches. Null when the run happened on another machine.
    const session = conversation.sessionId
      ? (await proxySessionContextFn({ data: { sessionId: conversation.sessionId } })).context
      : null;
    return { traffic, index, conversation, session };
  },
  component: EntryPage,
});

function convUsageLine(conv: TrafficConversation): string | undefined {
  if (conv.totalInputTokens === undefined && conv.totalOutputTokens === undefined) {
    return undefined;
  }
  const cached = (conv.cacheCreationInputTokens ?? 0) + (conv.cacheReadInputTokens ?? 0);
  const inPart =
    conv.totalInputTokens === undefined
      ? undefined
      : cached > 0
        ? `${conv.totalInputTokens.toLocaleString()} in (${cached.toLocaleString()} cached)`
        : `${conv.totalInputTokens.toLocaleString()} in`;
  const bits = [inPart, conv.totalOutputTokens !== undefined ? `${conv.totalOutputTokens.toLocaleString()} out` : undefined].filter(
    (b): b is string => b !== undefined,
  );
  return bits.length > 0 ? bits.join(" / ") : undefined;
}

/**
 * Tool results for a turn's calls surface in the NEXT turn's request.
 * Collect its tool-result excerpt lines so the detail can show them inline.
 */
function followupFor(
  entries: ProxyTrafficItem[],
  conversation: TrafficConversation | null,
  index: number,
): FollowupResults | null {
  if (!conversation) return null;
  const pos = conversation.indexes.indexOf(index);
  for (const next of conversation.indexes.slice(pos + 1)) {
    const item = entries[next];
    const lines = (item?.summary.request?.messages ?? [])
      .flatMap((m) => [m.preview, m.full ?? ""])
      .flatMap((t) => t.split("\n"))
      .map((l) => l.trim())
      .filter((l) => l.startsWith("[tool result"));
    if (lines.length > 0) {
      return { turn: `turn ${conversation.indexes.indexOf(next) + 1}`, lines };
    }
  }
  return null;
}

function RoleBadges({ entry }: { entry: ProxyTrafficItem }) {
  const role = entry.summary.role;
  if (role?.kind === "policy-check") return <Badge tone="warn">policy check</Badge>;
  if (role?.kind === "agent-launch") {
    return <Badge tone="info">{launchLabel(role.detail)}</Badge>;
  }
  return null;
}

function TurnNode({
  entries,
  conversation,
  entryIndex,
  turn,
  focus,
}: {
  entries: ProxyTrafficItem[];
  conversation: TrafficConversation;
  entryIndex: number;
  turn: number;
  focus: boolean;
}) {
  const item = entries[entryIndex];
  if (!item) return null;
  const anchor = `turn-${item.id ?? entryIndex}`;
  const headline = item.summary.headline ?? item.summary.explanation[0] ?? `${item.method} ${item.path}`;
  const reply = (item.summary.response?.textPreview ?? "").replace(/\s+/g, " ").trim();
  const toolLine = (item.summary.response?.toolCalls ?? [])
    .map((t) => t.summary ?? t.name)
    .join(" · ");
  const followup = followupFor(entries, conversation, entryIndex);
  return (
    <div id={anchor} style={focus ? { outline: "2px solid var(--sw-accent, #4a7)", borderRadius: 8 } : undefined}>
      <Card>
        <Stack>
          <div>
            <Muted>
              turn {turn} · {new Date(item.ts).toLocaleTimeString()} · {ago(item.ts)}{" "}
            </Muted>
            <Badge tone={statusTone(item.status)}>{item.status}</Badge>{" "}
            <RoleBadges entry={item} />{" "}
            {!focus ? (
              <a href={`#${anchor}`}>link</a>
            ) : (
              <Muted>in view</Muted>
            )}
          </div>
          <strong>{headline}</strong>
          {reply && <span>{reply.length > 240 ? `${reply.slice(0, 240)}…` : reply}</span>}
          {toolLine && (
            <Muted>
              {toolLine}
            </Muted>
          )}
          <Muted>
            {item.summary.response?.usageLine ?? `${item.ms}ms`}
          </Muted>
          {focus ? (
            <EntryDetail entry={item} followup={followup} />
          ) : (
            <Disclosure summary={<span>Full turn details</span>}>
              <EntryDetail entry={item} followup={followup} />
            </Disclosure>
          )}
        </Stack>
      </Card>
    </div>
  );
}

/**
 * Local Claude Code session behind the thread: what the proxy cannot see —
 * the Workflow orchestration script with its phases, each subagent branch
 * with its assignment and result, and the agent definitions behind Task
 * launches. Read from ~/.claude on the proxy's machine.
 */
function SessionPanel({ session, sessionId }: { session: SessionContext | null; sessionId: string }) {
  if (!session) {
    return (
      <Card>
        <Muted>
          No local session on this machine — the run happened elsewhere, so only
          proxy-visible turns show below.
        </Muted>
        <Fact label="Resume id">
          <Code>{sessionId}</Code>
        </Fact>
      </Card>
    );
  }
  return (
    <Card>
      <Stack>
        <div>
          <strong>Claude Code session</strong>{" "}
          <Muted>
            {session.cwd ? `${session.cwd} · ` : ""}{session.userPrompts} prompt
            {session.userPrompts === 1 ? "" : "s"} · {session.transcriptEntries} transcript entries
          </Muted>
        </div>
        <Fact label="Resume id">
          <Code>{session.sessionId}</Code>
        </Fact>
        <Muted>
          This is the same id Claude gives at quit — resume with{" "}
          <Code>claude --resume {session.sessionId}</Code>, and new turns land back in
          this thread.
        </Muted>
        {session.firstPrompt && <Fact label="Started with">{session.firstPrompt}</Fact>}
        {session.toolTally.length > 0 && (
          <Fact label="Transcript tools">
            {session.toolTally.map((t) => `${t.name}×${t.count}`).join(", ")}
          </Fact>
        )}
        {session.workflowScripts.map((w, i) => (
          <div key={w.toolId || i}>
            <strong>
              Workflow{w.name ? `: ${w.name}` : ""}
            </strong>{" "}
            <Muted>
              {w.description ?? "orchestration script from the transcript"}
              {w.scriptChars > 0 ? ` · ${w.scriptChars.toLocaleString()} chars` : ""}
            </Muted>
            {w.phases.length > 0 && (
              <ol>
                {w.phases.map((p, j) => (
                  <li key={j}>
                    <strong>{p.title}</strong>
                    {p.detail ? <Muted> — {p.detail}</Muted> : null}
                  </li>
                ))}
              </ol>
            )}
            {w.script && (
              <Disclosure summary={<span>Workflow script source{w.scriptTruncated ? " (truncated)" : ""}</span>}>
                <Pre>{w.script}</Pre>
              </Disclosure>
            )}
          </div>
        ))}
        {session.workflowAgents.length > 0 && (
          <div>
            <strong>
              Subagent branches ({session.workflowAgents.length})
            </strong>{" "}
            <Muted>workflow-subagent transcripts from the session sidecar</Muted>
            <Stack>
              {session.workflowAgents.map((a) => (
                <div key={a.agentId}>
                  <Badge tone={a.finished ? "success" : "info"}>
                    {a.agentType ?? "subagent"}
                  </Badge>{" "}
                  <Muted>
                    {a.workflowId} · <Code>{a.agentId.slice(0, 8)}</Code>
                    {a.finished ? " · done" : " · running"}
                  </Muted>
                  {a.promptHead && (
                    <div>
                      <Muted>Assignment: </Muted>
                      {a.promptHead.length > 300 ? `${a.promptHead.slice(0, 300)}…` : a.promptHead}
                    </div>
                  )}
                  {(a.resultArea || a.resultSummary) && (
                    <div>
                      <Muted>Result{a.resultArea ? ` (${a.resultArea})` : ""}: </Muted>
                      {a.resultSummary ?? ""}
                    </div>
                  )}
                </div>
              ))}
            </Stack>
          </div>
        )}
        {session.taskLaunches.length > 0 && (
          <div>
            <strong>Task launches ({session.taskLaunches.length})</strong>{" "}
            <Muted>subagents spawned through the API — full prompts from the transcript</Muted>
            <Stack>
              {session.taskLaunches.map((t, i) => (
                <div key={t.toolId || i}>
                  {t.subagentType && <Badge tone="info">{t.subagentType}</Badge>}{" "}
                  {t.description && <strong>{t.description}</strong>}
                  {t.promptHead && <div>{t.promptHead}</div>}
                </div>
              ))}
            </Stack>
          </div>
        )}
        {session.agentDefinitions.length > 0 && (
          <div>
            <strong>Agent definitions</strong>
            <Stack>
              {session.agentDefinitions.map((d) => (
                <Disclosure key={d.name} summary={<span>{d.name} — <Muted>{d.path}</Muted></span>}>
                  <Pre>{d.head}</Pre>
                </Disclosure>
              ))}
            </Stack>
          </div>
        )}
        <Muted>{session.transcriptPath}</Muted>
      </Stack>
    </Card>
  );
}

function ThreadPanel({
  entries,
  conversation,
  focusId,
  session,
}: {
  entries: ProxyTrafficItem[];
  conversation: TrafficConversation;
  focusId: string;
  session: SessionContext | null;
}) {
  const usage = convUsageLine(conversation);
  const launches = conversation.agentLaunches;
  return (
    <Stack>
      <Card>
        <Stack>
          <div>
            <strong>
              Thread · {conversation.turns} turn{conversation.turns === 1 ? "" : "s"}
            </strong>{" "}
            <Muted>
              {conversation.policyChecks.length > 0
                ? `incl. ${conversation.policyChecks.length} safety screen${conversation.policyChecks.length === 1 ? "" : "s"}`
                : "linked turns"}
              {conversation.spanMs > 0 ? ` · over ${fmtSpan(conversation.spanMs)}` : ""}
            </Muted>
          </div>
          <Stack>
            {usage && <Fact label="Total usage">{usage}</Fact>}
            {conversation.upstreamMs > 0 && (
              <Fact label="Upstream time">{fmtSpan(conversation.upstreamMs)} summed</Fact>
            )}
            {conversation.models.length > 0 && (
              <Fact label="Models">{conversation.models.join(", ")}</Fact>
            )}
            {conversation.profiles.length > 0 && (
              <Fact label="Profiles">{conversation.profiles.join(", ")}</Fact>
            )}
            {conversation.tools.length > 0 && (
              <Fact label="Tools">{conversation.tools.slice(0, 12).join(", ")}{conversation.tools.length > 12 ? ", …" : ""}</Fact>
            )}
            {launches.length > 0 && (
              <Fact label="Subagents">
                {launches.map((l) => l.agent).join(", ")} — sidechains run in-process with their
                own transcript; their turns bypass the proxy, only verdicts return here.
              </Fact>
            )}
          </Stack>
        </Stack>
      </Card>
      {conversation.sessionId && (
        <SessionPanel session={session} sessionId={conversation.sessionId} />
      )}
      {conversation.indexes.map((entryIndex, turn) => {
        const item = entries[entryIndex];
        return (
          <TurnNode
            key={item?.id ?? entryIndex}
            entries={entries}
            conversation={conversation}
            entryIndex={entryIndex}
            turn={turn + 1}
            focus={item?.id === focusId}
          />
        );
      })}
    </Stack>
  );
}

function EntryPage() {
  const { traffic, index, conversation, session } = Route.useLoaderData();
  const { profile } = Route.useSearch();
  const router = useRouter();
  const entry = traffic.entries[index]!;
  const focusNo = conversation.indexes.indexOf(index) + 1;

  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void router.invalidate();
    }, 2500);
    return () => clearInterval(id);
  }, [router]);

  return (
    <Page
      title={conversation.turns === 1 ? "Thread · 1 turn" : `Thread · ${conversation.turns} turns`}
      sub={
        <>
          <Link to="/proxy" search={{ profile }}>
            Proxy traffic
          </Link>{" "}
          · viewing turn {focusNo} of {conversation.turns}
        </>
      }
    >
      <Stack>
        {!traffic.running ? (
          <Notice tone="warn">
            The proxy is not running. Start it with <Code>swisscode proxy run</Code> — this
            view shows the last buffered snapshot.
          </Notice>
        ) : null}
        <ThreadPanel
          entries={traffic.entries}
          conversation={conversation}
          focusId={entry.id ?? ""}
          session={session}
        />
      </Stack>
    </Page>
  );
}
