import type { ReactNode } from "react";
import { rove } from "./rove";
import { cx } from "./Button";

export interface SegmentOption<T extends string> { value: T; label: ReactNode; disabled?: boolean }

/** 2–4 mutually exclusive options that change the view at once (Sub/Dub, Theme).
 *  Not for navigation and not for 5+ options (use Tabs or a Menu). */
export function SegmentedControl<T extends string>({ value, options, onChange, label, className }:
  { value: T; options: SegmentOption<T>[]; onChange: (v: T) => void; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cx("segmented", className)}
      onKeyDown={(e) => { const el = rove(e, '[role="radio"]'); if (el) onChange(el.dataset.value as T); }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-value={o.value}
            disabled={o.disabled} className="seg-opt" onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
