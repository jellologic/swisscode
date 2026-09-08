// Full layout for one proxied request/response, shared by the /proxy list
// peek and the dedicated /proxy/$entryId page.
//
// Reading order is deliberate: verdict first, then the answer, then the
// evidence. Usage is told as a fresh-vs-reused story, tool calls read as
// one-liners, and provider-agnostic mechanics stay in the "details".

import type { ReactNode } from "react";
import { Badge, Card, Code, Disclosure, Muted, Pre, Stack } from "../design";
import type { BadgeTone } from "../design";
import type { ProxyTrafficItem } from "../lib/store.server";

export function statusTone(status: number): BadgeTone {
  if (status < 300) return "success";
  if (status === 429 || status === 529) return "warn";
  if (status >= 500) return "danger";
  return "neutral";
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

export function fmtSpan(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Short role label for a subagent launch (detail may be just the tool name). */
export function launchLabel(detail?: string): string {
  return detail && detail !== "Task" && detail !== "Agent"
    ? `launched ${detail}`
    : "launched subagent";
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <Muted>{label} </Muted>
      <span>{children}</span>
    </div>
  );
}

/** One step in the turn's story: request → thinking → reply → tools → stop. */
function FlowChips({ entry }: { entry: ProxyTrafficItem }) {
  const { request, response } = entry.summary;
  const steps: ReactNode[] = [];
  const push = (key: string, node: ReactNode): void => {
    if (steps.length > 0) {
      steps.push(
        <Muted key={`${key}-arrow`}>
          {" → "}
        </Muted>,
      );
    }
    steps.push(<span key={key}>{node}</span>);
  };
  if (request?.messageCount !== undefined) {
    push("in", <Badge tone="neutral">{request.messageCount} in</Badge>);
  } else if (entry.reqBytes > 0) {
    push("in", <Badge tone="neutral">request</Badge>);
  }
  if ((response?.thinkingChars ?? 0) > 0) {
    push("thinking", <Badge tone="neutral">thought</Badge>);
  }
  if (response?.textPreview) {
    push("reply", <Badge tone="success">replied</Badge>);
  }
  for (const call of (response?.toolCalls ?? []).slice(0, 4)) {
    push(`tool-${call.name}`, <Badge tone="info">{call.name}</Badge>);
  }
  if ((response?.toolCalls ?? []).length > 4) {
    push("tools-more", <Badge tone="info">+{(response?.toolCalls ?? []).length - 4}</Badge>);
  }
  if (response?.stopReason) {
    push(
      "stop",
      <Badge tone={response.stopReason === "max_tokens" ? "warn" : "neutral"}>
        {response.stopReason}
      </Badge>,
    );
  } else if (response?.kind === "error") {
    push("stop", <Badge tone="danger">rejected</Badge>);
  }
  if (steps.length === 0) return null;
  return <div>{steps}</div>;
}

/** Fresh-vs-reused token story with a share bar. No dollars — shares only. */
function TokenStory({ entry }: { entry: ProxyTrafficItem }) {
  const response = entry.summary.response;
  if (response?.kind !== "sse-stream" && response?.kind !== "json") return null;
  const total = response.totalInputTokens ?? response.inputTokens;
  const out = response.outputTokens;
  if (total === undefined && out === undefined) return null;
  const cached = (response.cacheCreationInputTokens ?? 0) + (response.cacheReadInputTokens ?? 0);
  const fresh = Math.max(0, (total ?? 0) - cached);
  const share = total !== undefined && total > 0 ? Math.round((cached / total) * 100) : 0;
  return (
    <Stack>
      <Muted>Tokens</Muted>
      <div>
        <span>
          {total !== undefined ? `${total.toLocaleString()} in` : "input unknown"}
          {out !== undefined ? ` · ${out.toLocaleString()} out` : ""}
        </span>{" "}
        {total !== undefined && total > 0 && (
          <Muted>
            — {fresh.toLocaleString()} fresh, {cached.toLocaleString()} reused ({share}%)
          </Muted>
        )}
      </div>
      {total !== undefined && total > 0 && (
        <div
          style={{
            display: "flex",
            height: 8,
            borderRadius: 4,
            overflow: "hidden",
            background: "var(--sw-muted-bg, #eee)",
          }}
          title={`${share}% reused from cache`}
        >
          <div style={{ width: `${share}%`, background: "var(--sw-accent, #4a7)" }} />
        </div>
      )}
      {(response.thinkingChars ?? 0) > 0 && (
        <Muted>
          Includes ~{(response.thinkingChars ?? 0).toLocaleString()} chars of private reasoning,
          billed as output.
        </Muted>
      )}
    </Stack>
  );
}

export interface FollowupResults {
  /** e.g. "turn 2". */
  turn: string;
  /** Tool-result excerpts echoed back by the following turn. */
  lines: string[];
}

function ToolCards({
  entry,
  followup,
}: {
  entry: ProxyTrafficItem;
  followup?: FollowupResults | null;
}) {
  const calls = entry.summary.response?.toolCalls ?? [];
  const uses = entry.summary.response?.toolUses ?? [];
  if (calls.length === 0 && uses.length === 0) return null;
  return (
    <Stack>
      <Muted>
        Tools · {calls.length > 0 ? calls.length : uses.length} call
        {(calls.length > 0 ? calls.length : uses.length) === 1 ? "" : "s"}
      </Muted>
      {calls.map((t, i) => (
        <div key={i}>
          <Badge tone="neutral">{t.name}</Badge>{" "}
          <span>{t.summary ?? t.name}</span>
          {t.id && (
            <Muted>
              {" "}
              <Code>{t.id}</Code>
            </Muted>
          )}
          {t.input && (
            <Disclosure summary={<span>raw input</span>}>
              <Pre>
                {t.input}
                {t.inputTruncated ? "\n…" : ""}
              </Pre>
            </Disclosure>
          )}
        </div>
      ))}
      {calls.length === 0 && <Fact label="Tools used">{uses.join(", ")}</Fact>}
      {followup && followup.lines.length > 0 && (
        <div>
          <Muted>Results, echoed back in {followup.turn}</Muted>
          {followup.lines.slice(0, 4).map((line, i) => (
            <Pre key={i}>{line.slice(0, 400)}</Pre>
          ))}
          {followup.lines.length > 4 && <Muted>…and {followup.lines.length - 4} more</Muted>}
        </div>
      )}
    </Stack>
  );
}

export function EntryDetail({
  entry,
  followup,
}: {
  entry: ProxyTrafficItem;
  followup?: FollowupResults | null;
}) {
  const { request, response, explanation, headline, role } = entry.summary;
  const technical: ReactNode[] = [];
  if (request?.model && request.model !== response?.model) {
    technical.push(
      <Fact key="model" label="Asked model">
        <Code>{request.model}</Code>
      </Fact>,
    );
  }
  if (response?.model) {
    technical.push(
      <Fact key="rmodel" label="Answered model">
        <Code>{response.model}</Code>
      </Fact>,
    );
  }
  if (response?.messageId) {
    technical.push(
      <Fact key="mid" label="Message ID">
        <Code>{response.messageId}</Code>
      </Fact>,
    );
  }
  if (request?.toolCount) {
    technical.push(
      <Fact key="offered" label={`Tools offered (${request.toolCount})`}>
        {(request.toolNames ?? []).join(", ") || "—"}
        {request.toolCount > (request.toolNames ?? []).length ? ", …" : ""}
      </Fact>,
    );
  }
  if (request?.maxTokens !== undefined) {
    technical.push(<Fact key="max" label="Max tokens">{request.maxTokens.toLocaleString()}</Fact>);
  }
  if (response?.contentBlocks && response.contentBlocks.some((b) => b.type !== "text")) {
    technical.push(
      <Fact key="struct" label="Structure">
        {response.contentBlocks.map((b) => `${b.count} ${b.type}`).join(" + ")}
      </Fact>,
    );
  }
  if (response?.serverIterations) {
    technical.push(<Fact key="iter" label="Server iterations">{response.serverIterations}</Fact>);
  }
  if (response?.serviceTier && response.serviceTier !== "standard") {
    technical.push(
      <Fact key="tier" label="Tier">
        <Code>{response.serviceTier}</Code>
      </Fact>,
    );
  }
  if (response?.inferenceGeo) {
    technical.push(
      <Fact key="geo" label="Region">
        <Code>{response.inferenceGeo}</Code>
      </Fact>,
    );
  }
  if (response?.events && response.events.length > 0) {
    technical.push(
      <Fact key="events" label="Events">
        {response.events
          .slice(0, 6)
          .map((e) => `${e.type}×${e.count}`)
          .join(", ")}
      </Fact>,
    );
  }
  if (response?.totalItems !== undefined) {
    technical.push(
      <Fact key="items" label={`${response.totalItems} entries`}>
        {(response.items ?? []).join(", ")}
        {response.itemsTruncated ? ", …" : ""}
      </Fact>,
    );
  }
  if (response?.detail && response?.totalItems === undefined) {
    technical.push(<Muted key="detail">{response.detail}</Muted>);
  }

  return (
    <Card>
      <Stack>
        <div>
          <strong>
            {entry.method} {entry.path}
          </strong>{" "}
          <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>{" "}
          {entry.profile && <Badge tone="info">{entry.profile}</Badge>}{" "}
          {role?.kind === "policy-check" && <Badge tone="warn">policy check</Badge>}{" "}
          <Muted>
            {new Date(entry.ts).toLocaleString()} · {entry.ms}ms · ↑{fmtBytes(entry.reqBytes)} ↓
            {fmtBytes(entry.resBytes)}
          </Muted>
        </div>

        {headline && <strong>{headline}</strong>}
        <FlowChips entry={entry} />

        {(response?.textPreview || (response?.toolUses && response.toolUses.length > 0)) && (
          <Stack>
            <Muted>Reply</Muted>
            {response.textPreview && (
              <Pre>
                {response.textPreview}
                {response.textTruncated ? "\n…" : ""}
              </Pre>
            )}
            <ToolCards entry={entry} followup={followup} />
          </Stack>
        )}

        <TokenStory entry={entry} />

        {(request?.systemPreview || (request?.messages && request.messages.length > 0)) && (
          <Stack>
            <Muted>
              Context in
              {request.messageCount !== undefined ? ` · ${request.messageCount} messages` : ""}
              {request.systemChars ? ` · ${(request.systemChars / 1000).toFixed(1)}k system` : ""}
              {request.cacheBreakpoints
                ? ` · ${request.cacheBreakpoints} cache tag${request.cacheBreakpoints === 1 ? "" : "s"}`
                : ""}
              {request.toolResultCount
                ? ` · ${request.toolResultCount} tool result${request.toolResultCount === 1 ? "" : "s"} back`
                : ""}
            </Muted>
            {request.systemPreview && (
              <div>
                <Badge tone="neutral">system</Badge> <span>{request.systemPreview}</span>
              </div>
            )}
            {request.messages?.map((m, i) => (
              <div key={i}>
                <Badge tone={m.role === "user" ? "info" : m.role === "assistant" ? "success" : "neutral"}>
                  {m.role}
                </Badge>{" "}
                <span style={{ whiteSpace: "pre-wrap" }}>
                  {m.preview}
                  {m.truncated ? " …" : ""}
                </span>
                {m.truncated && m.full && m.full !== m.preview && (
                  <Disclosure summary={<span>Full message</span>}>
                    <Pre>
                      {m.full}
                      {m.fullTruncated ? "\n…" : ""}
                    </Pre>
                  </Disclosure>
                )}
              </div>
            ))}
            {request.messagesTruncated && (
              <Muted>…and {Math.max(0, (request.messageCount ?? 0) - (request.messages?.length ?? 0))} later messages not shown.</Muted>
            )}
          </Stack>
        )}

        <Muted>Why this happened</Muted>
        <Stack>
          {explanation.map((line, i) => (
            <div key={i}>
              <Muted>{i + 1}. </Muted>
              <span>{line}</span>
            </div>
          ))}
        </Stack>

        {technical.length > 0 && (
          <Disclosure summary={<span>Technical details</span>}>
            <Stack>{technical}</Stack>
          </Disclosure>
        )}

        {response?.errorMessage && (
          <Fact label="Error">{response.errorMessage}</Fact>
        )}
        {!request && !response && <Muted>Bodies weren't kept for this exchange.</Muted>}

        {entry.attempts.length > 1 && (
          <Fact label="Failover">
            {entry.attempts.map((a) => `${a.accountId} → ${a.status}`).join(" · ")}
          </Fact>
        )}

        {(entry.reqBody !== undefined || entry.resBody !== undefined) && (
          <Stack>
            {entry.reqBody !== undefined && (
              <Disclosure
                summary={
                  <span>
                    Request body ({fmtBytes(entry.reqBytes)}
                    {entry.reqBodyTruncated ? ", truncated" : ""})
                  </span>
                }
              >
                <Pre>{entry.reqBody}</Pre>
              </Disclosure>
            )}
            {entry.resBody !== undefined && (
              <Disclosure
                summary={
                  <span>
                    Response body ({fmtBytes(entry.resBytes)}
                    {entry.resBodyTruncated ? ", truncated" : ""})
                  </span>
                }
              >
                <Pre>{entry.resBody}</Pre>
              </Disclosure>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}
