import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronRight } from "../icons";
import { cx } from "./Button";

type Kind = "plain" | "nav" | "toggle" | "choice";
export interface ListRowProps {
  title: ReactNode;
  /** Second line: helper text or status ("Working · starts fast") */
  description?: ReactNode;
  leading?: ReactNode;
  /** Current value shown right-aligned in muted text: "Auto (1080p)" */
  value?: ReactNode;
  /** Extra trailing content (badges) before the value/chevron/check */
  trailing?: ReactNode;
  /** nav: chevron, pushes a sub-view · toggle: role=switch with a Switch · choice: role=radio with a Check */
  kind?: Kind;
  /** toggle/choice state */
  checked?: boolean;
  onClick?: () => void;
  to?: string;
  disabled?: boolean;
  /** Overrides the role (e.g. "menuitemradio" inside a Menu) */
  role?: string;
  className?: string;
  /** Native tooltip, e.g. the raw server name on a source row */
  tooltip?: string;
}

/** Full-width row: Settings rows, panel choice lists, source rows, suggestion rows. */
export function ListRow({ title, description, leading, value, trailing, kind = "plain", checked, onClick, to, disabled, role, className, tooltip }: ListRowProps) {
  const inner = (
    <>
      {leading && <span className="list-row-lead">{leading}</span>}
      <span className="list-row-text">
        <span className="list-row-title">{title}</span>
        {description && <span className="list-row-desc">{description}</span>}
      </span>
      {(trailing || value != null || kind !== "plain") && (
        <span className="list-row-trail">
          {trailing}
          {value != null && <span>{value}</span>}
          {kind === "nav" && <ChevronRight size={20} aria-hidden="true" />}
          {kind === "toggle" && <span className="switch" aria-hidden="true" />}
          {kind === "choice" && checked && <Check size={20} className="list-row-check" aria-hidden="true" />}
        </span>
      )}
    </>
  );
  const cls = cx("list-row", className);
  if (to) return <Link to={to} className={cls} title={tooltip}>{inner}</Link>;
  if (!onClick && kind === "plain") return <div className={cls} title={tooltip}>{inner}</div>;
  const r = role ?? (kind === "toggle" ? "switch" : kind === "choice" ? "radio" : undefined);
  return (
    <button type="button" className={cls} role={r} aria-checked={r ? !!checked : undefined} disabled={disabled} onClick={onClick} title={tooltip}>
      {inner}
    </button>
  );
}

/** Groups rows. role="radiogroup" for a choice list; divided = hairlines between rows. */
export function ListGroup({ children, label, role = "group", divided, className }:
  { children: ReactNode; label?: string; role?: "group" | "radiogroup"; divided?: boolean; className?: string }) {
  return <div role={role} aria-label={label} className={cx("list-group", divided && "divided", className)}>{children}</div>;
}

/** Standalone switch. Inside a ListRow use kind="toggle" instead (the whole row toggles). */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className="switch" onClick={() => onChange(!checked)} />;
}
