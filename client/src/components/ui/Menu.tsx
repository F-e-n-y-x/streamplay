import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check } from "../icons";
import { Panel } from "./Panel";
import { ListGroup, ListRow } from "./ListRow";
import { rove } from "./rove";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Set on every item to make this a single-choice menu (menuitemradio + trailing Check) */
  checked?: boolean;
  meta?: ReactNode;
  disabled?: boolean;
  /** Group heading shown above this item */
  group?: string;
}

export interface TriggerProps {
  "aria-haspopup": "menu";
  "aria-expanded": boolean;
  "aria-controls": string;
  onClick: () => void;
}

/**
 * Menu anchored to its trigger. Arrow keys, Home/End, typeahead, Esc returns to the trigger.
 * Phone portrait with more than 6 items renders as a bottom-sheet Panel instead.
 *   <Menu label="Sort" items={…} trigger={(p) => <Button {...p} variant="ghost">Popular</Button>} />
 */
export function Menu({ label, items, trigger, align = "start" }:
  { label: string; items: MenuItem[]; trigger: (p: TriggerProps) => ReactNode; align?: "start" | "end" }) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [sheet, setSheet] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const id = useId();
  const radio = items.some((i) => i.checked !== undefined);
  const focusTrigger = () => wrap.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus();
  const close = (refocus = true) => { setOpen(false); if (refocus) focusTrigger(); };

  const toggle = () => {
    if (open) return close();
    const r = wrap.current!.getBoundingClientRect();
    setAbove(innerHeight - r.bottom < 280 && r.top > innerHeight - r.bottom);
    setSheet(items.length > 6 && matchMedia("(max-width: 767px) and (orientation: portrait)").matches);
    setOpen(true);
  };

  useEffect(() => {
    if (!open || sheet) return;
    const menu = wrap.current?.querySelector<HTMLElement>('[role="menu"]');
    (menu?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu?.querySelector<HTMLElement>("button:not(:disabled)"))?.focus();
    const outside = (e: PointerEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open, sheet]);

  const pick = (it: MenuItem) => { it.onSelect(); close(); };

  return (
    <div className="menu-wrap" ref={wrap}>
      {trigger({ "aria-haspopup": "menu", "aria-expanded": open, "aria-controls": id, onClick: toggle })}
      {open && !sheet && (
        <div id={id} role="menu" aria-label={label} className={`menu ${above ? "above" : "below"}${align === "end" ? " right" : ""}`}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); return close(); }
            if (e.key === "Tab") return close(false);
            if (rove(e, '[role^="menuitem"]', "y")) return;
            if (e.key.length === 1 && /\S/.test(e.key)) {   // typeahead
              const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')];
              const from = all.indexOf(document.activeElement as HTMLElement);
              const hit = [...all.slice(from + 1), ...all.slice(0, from + 1)].find((el) => el.textContent?.trim().toLowerCase().startsWith(e.key.toLowerCase()));
              hit?.focus();
            }
          }}>
          {items.map((it, i) => (
            <MenuRow key={i} it={it} radio={radio} onPick={() => pick(it)} />
          ))}
        </div>
      )}
      {sheet && (
        <Panel open={open} onClose={() => setOpen(false)} title={label}>
          <ListGroup role={radio ? "radiogroup" : "group"} label={label}>
            {items.map((it, i) => (
              <ListRow key={i} title={it.label} value={it.meta} kind={radio ? "choice" : "plain"} checked={it.checked} disabled={it.disabled}
                onClick={() => pick(it)} />
            ))}
          </ListGroup>
        </Panel>
      )}
    </div>
  );
}

function MenuRow({ it, radio, onPick }: { it: MenuItem; radio: boolean; onPick: () => void }) {
  return (
    <>
      {it.group && <div className="menu-label" role="presentation">{it.group}</div>}
      <button type="button" role={radio ? "menuitemradio" : "menuitem"} aria-checked={radio ? !!it.checked : undefined} tabIndex={-1}
        disabled={it.disabled} className="menu-item" onClick={onPick}>
        <span className="mi-label">{it.label}</span>
        {it.meta != null && <span className="mi-meta">{it.meta}</span>}
        {radio && <Check size={16} aria-hidden="true" style={{ visibility: it.checked ? "visible" : "hidden" }} />}
      </button>
    </>
  );
}
