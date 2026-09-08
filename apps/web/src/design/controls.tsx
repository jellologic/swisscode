import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { Link } from "@tanstack/react-router";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Internal route: renders a router Link styled as a button. */
  to?: string;
}

/** The only button. Pick a variant, never a class. `to` navigates instead. */
export function Button(props: ButtonProps) {
  const { variant = "secondary", size = "md", to, children, ...rest } = props;
  if (to !== undefined) {
    if (rest.disabled) {
      return (
        <span className="sw-btn" data-variant={variant} data-size={size} aria-disabled="true">
          {children}
        </span>
      );
    }
    return (
      <Link to={to} className="sw-btn" data-variant={variant} data-size={size}>
        {children}
      </Link>
    );
  }
  return (
    <button {...rest} className="sw-btn" data-variant={variant} data-size={size}>
      {children}
    </button>
  );
}

/** Labeled form row with optional hint. */
export function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="sw-field">
      <span>{props.label}</span>
      {props.children}
      {props.hint ? <small>{props.hint}</small> : null}
    </label>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** Text-like input. */
export function Input(props: InputProps) {
  return <input {...props} className="sw-input" />;
}

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Multi-line text input. Shares input styling. */
export function Textarea(props: TextareaProps) {
  return <textarea {...props} rows={props.rows ?? 3} className="sw-input" />;
}

type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

/** Native select, styled. */
export function Select(props: SelectProps) {
  const { children, ...rest } = props;
  return (
    <select {...rest} className="sw-select">
      {children}
    </select>
  );
}

/** Checkbox row. */
export function Check(props: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="sw-check">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>{props.children}</span>
    </label>
  );
}

/** Vertical form rhythm. */
export function Form(props: { onSubmit: (e: React.FormEvent) => void; children: ReactNode }) {
  return (
    <form className="sw-form" onSubmit={props.onSubmit}>
      {props.children}
    </form>
  );
}
