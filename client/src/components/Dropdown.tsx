import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "./icons";

export interface Option { value: string; label: string }

/**
 * Compact menu-button select. Opening focuses the current option; Up/Down move
 * between options (app-wide spatial nav), Enter picks, Escape closes back to the trigger.
 */
export default function Dropdown({
  value, options, onChange, placeholder = "Select…", ariaLabel,
}: {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    (ref.current?.querySelector<HTMLElement>(".menu-item.active") ?? ref.current?.querySelector<HTMLElement>(".menu-item"))?.focus();
    const onDoc = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("pointerdown", onDoc); document.removeEventListener("keydown", onKey, true); };
  }, [open]);

  const cur = options.find((o) => o.value === value);

  return (
    <div className="dropdown" ref={ref} onBlur={(e) => { if (!ref.current?.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <button ref={trigger} type="button" className="dropdown-trigger" onClick={() => setOpen((v) => !v)} aria-haspopup="true" aria-expanded={open} aria-label={ariaLabel ? `${ariaLabel}: ${cur?.label ?? placeholder}` : undefined}>
        <span className={cur ? "" : "subtle"}>{cur ? cur.label : placeholder}</span>
        <ChevronDown size={16} />
      </button>
      {open && (
        <div className="menu below dropdown-menu">
          {options.map((o) => (
            <button key={o.value} type="button" aria-pressed={o.value === value}
              className={`menu-item ${o.value === value ? "active" : ""}`}
              onClick={() => { onChange(o.value); setOpen(false); trigger.current?.focus(); }}>
              <span>{o.label}</span>
              {o.value === value && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
