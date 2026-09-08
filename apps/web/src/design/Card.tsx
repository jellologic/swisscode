import type { ReactNode } from "react";

export type CardPad = "sm" | "md" | "lg";

/** Frosted glass panel. */
export function Card(props: { pad?: CardPad; children: ReactNode }) {
  return (
    <article className="sw-card" data-pad={props.pad ?? "md"}>
      {props.children}
    </article>
  );
}

/** Vertical rhythm between blocks. */
export function Stack(props: { children: ReactNode }) {
  return <div className="sw-stack">{props.children}</div>;
}

/** Two-column layout collapsing to one on narrow screens. */
export function Grid2(props: { children: ReactNode }) {
  return <div className="sw-grid-2">{props.children}</div>;
}
