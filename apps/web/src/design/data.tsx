import type { ReactNode } from "react";
import { Stack } from "./Card";

export interface Column<T> {
  header: string;
  render: (row: T) => ReactNode;
}

interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  getKey: (row: T, index: number) => string;
  empty?: ReactNode;
}

/** Strictly typed table. Columns declare headers + renderers; no raw markup. */
export function Table<T>({ columns, rows, getKey, empty }: TableProps<T>) {
  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;
  return (
    <div className="sw-tablewrap">
      <table className="sw-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.header} scope="col">{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={getKey(row, i)}>
              {columns.map((c) => (
                <td key={c.header}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Inline action cluster for table cells. */
export function RowActions(props: { children: ReactNode }) {
  return <div className="sw-rowactions">{props.children}</div>;
}

export type BadgeTone = "neutral" | "info" | "success" | "warn" | "danger";

/** Status pill. */
export function Badge(props: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className="sw-badge" data-tone={props.tone ?? "neutral"}>
      {props.children}
    </span>
  );
}

export type MeterTone = "info" | "warn" | "danger";

interface MeterProps {
  /** 0–100, or null/undefined when unknown. Clamped either way. */
  value: number | null | undefined;
  label?: string;
  hint?: string;
}

/** Labeled utilization bar. Tone shifts as the value climbs. */
export function Meter({ value, label, hint }: MeterProps) {
  const pct = value === null || value === undefined || Number.isNaN(value) ? null : Math.min(100, Math.max(0, value));
  const tone: MeterTone = pct === null ? "info" : pct >= 90 ? "danger" : pct >= 70 ? "warn" : "info";
  return (
    <div className="sw-meter" data-tone={tone}>
      {(label !== undefined || pct !== null) && (
        <div className="sw-meter-top">
          <span>{label}</span>
          <span>{pct === null ? "n/a" : `${pct}%`}</span>
        </div>
      )}
      <div className="sw-meter-track">
        <div className="sw-meter-fill" style={{ width: `${pct ?? 0}%` }} />
      </div>
      {hint ? <div className="sw-meter-top"><span>{hint}</span></div> : null}
    </div>
  );
}

export type NoticeTone = "info" | "success" | "warn" | "danger";

/** Callout block for errors and notes. */
export function Notice(props: { tone?: NoticeTone; children: ReactNode }) {
  return (
    <div className="sw-notice" data-tone={props.tone ?? "info"} role={props.tone === "danger" ? "alert" : undefined}>
      {props.children}
    </div>
  );
}

/** Secondary text. */
export function Muted(props: { children: ReactNode }) {
  return <span className="sw-muted">{props.children}</span>;
}

interface DisclosureProps {
  summary: ReactNode;
  children: ReactNode;
  onOpen?: () => void;
}

/** Page section: h2 heading plus stacked content. For headings outside cards. */
export function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="sw-section">
      <h2>{props.title}</h2>
      <Stack>{props.children}</Stack>
    </section>
  );
}

/** Ordered setup steps. Items render as list rows. */
export function Steps(props: { items: ReactNode[] }) {
  return (
    <ol className="sw-steps">
      {props.items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ol>
  );
}

/** External link. Always opens a new tab with noreferrer. */
export function ExtLink(props: { href: string; children: ReactNode }) {
  return (
    <a className="sw-extlink" href={props.href} target="_blank" rel="noreferrer">
      {props.children}
    </a>
  );
}

/** Native collapsible section, styled. onOpen fires lazily on first open. */
export function Disclosure(props: DisclosureProps) {
  return (
    <details
      className="sw-disclosure"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) props.onOpen?.();
      }}
    >
      <summary className="sw-disclosure-summary">{props.summary}</summary>
      {props.children}
    </details>
  );
}

/** Inline code. */
export function Code(props: { children: ReactNode }) {
  return <code className="sw-code">{props.children}</code>;
}

/** Preformatted block. */
export function Pre(props: { children: ReactNode }) {
  return <pre className="sw-pre">{props.children}</pre>;
}
