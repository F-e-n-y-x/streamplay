import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Check, X } from "../icons";
import { IconButton, cx } from "./Button";

/** Toggle filter. The only pill-shaped control besides avatars. */
export function FilterChip({ selected, count, className, children, ...rest }:
  { selected: boolean; count?: number; children: ReactNode } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  return (
    <button type="button" className={cx("filter-chip", className)} aria-pressed={selected} {...rest}>
      {selected && <Check size={16} aria-hidden="true" />}
      {children}
      {count != null && <span className="chip-count">{count}</span>}
    </button>
  );
}

/** Removable value, e.g. a preferred audio language. */
export function InputChip({ children, onRemove, removeLabel }: { children: ReactNode; onRemove: () => void; removeLabel?: string }) {
  return (
    <span className="input-chip">
      {children}
      <IconButton size="sm" label={removeLabel ?? `Remove ${typeof children === "string" ? children : ""}`.trim()} onClick={onRemove}><X size={14} /></IconButton>
    </span>
  );
}
