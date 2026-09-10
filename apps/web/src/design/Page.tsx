import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Badge } from "./data.js";

/** Page header: exactly one h1 per page. */
export function Page(props: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="sw-page-head">
        <h1 className="sw-page-title">{props.title}</h1>
        {props.sub ? <p className="sw-page-sub">{props.sub}</p> : null}
      </div>
      {props.children}
    </div>
  );
}

export interface NavLink {
  to: string;
  label: string;
  exact?: boolean;
}

/** Sticky frosted top bar. Version badge is optional: the root loader feeds it. */
export function Topbar(props: {
  brand: string;
  links: NavLink[];
  version?: string;
  updateAvailable?: boolean;
}) {
  return (
    <header className="sw-topbar">
      <span className="sw-brand">{props.brand}</span>
      <nav className="sw-nav">
        {props.links.map((l) => (
          <Link key={l.to} to={l.to} activeOptions={l.exact ? { exact: true } : undefined}>
            {l.label}
          </Link>
        ))}
      </nav>
      {props.version ? (
        <span style={{ marginLeft: "auto" }}>
          <Badge tone={props.updateAvailable ? "warn" : "neutral"}>
            v{props.version}
            {props.updateAvailable ? " · update" : ""}
          </Badge>
        </span>
      ) : null}
    </header>
  );
}
