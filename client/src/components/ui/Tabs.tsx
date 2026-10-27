import { useLayoutEffect, useRef, type ReactNode } from "react";
import { rove } from "./rove";
import { cx } from "./Button";

export interface TabItem<T extends string> { value: T; label: ReactNode; disabled?: boolean }

/**
 * Underline tabs. Scrolls horizontally when it overflows (24px edge fade, the active tab
 * kept in view, never clipped mid-word). Arrow keys / Home / End move and select.
 * Tab buttons get id `${id}-tab-${value}`; give your panel `role="tabpanel"` and
 * `aria-labelledby` that id. `accent` = red ink (only inside player panels).
 */
export function Tabs<T extends string>({ value, items, onChange, label, id, accent, className }:
  { value: T; items: TabItem<T>[]; onChange: (v: T) => void; label: string; id: string; accent?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  // Ink under the active tab + edge fades on the side that has more to scroll to.
  const sync = () => {
    const list = ref.current;
    if (!list) return;
    const tab = list.querySelector<HTMLElement>('[aria-selected="true"]');
    list.style.setProperty("--ink-x", `${tab?.offsetLeft ?? 0}px`);
    list.style.setProperty("--ink-w", String(tab?.offsetWidth ?? 0));
    list.toggleAttribute("data-fade-start", list.scrollLeft > 1);
    list.toggleAttribute("data-fade-end", list.scrollLeft + list.clientWidth < list.scrollWidth - 1);
  };

  // Keep the active tab in view, horizontally only (never moves the page).
  useLayoutEffect(() => {
    sync();
    const list = ref.current;
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !tab) return;
    const pad = 24;
    if (tab.offsetLeft - pad < list.scrollLeft) list.scrollTo({ left: tab.offsetLeft - pad, behavior: "smooth" });
    else if (tab.offsetLeft + tab.offsetWidth + pad > list.scrollLeft + list.clientWidth)
      list.scrollTo({ left: tab.offsetLeft + tab.offsetWidth + pad - list.clientWidth, behavior: "smooth" });
  }, [value, items.length]);

  // Re-measure on resize, webfont swap (tab widths change) and scroll.
  useLayoutEffect(() => {
    const list = ref.current;
    if (!list) return;
    const ro = new ResizeObserver(sync);
    ro.observe(list);
    for (const t of list.children) ro.observe(t);
    list.addEventListener("scroll", sync, { passive: true });
    const r = requestAnimationFrame(() => list.setAttribute("data-ready", ""));   // no ink slide on first paint
    return () => { cancelAnimationFrame(r); ro.disconnect(); list.removeEventListener("scroll", sync); };
  }, [items.length]);

  return (
    <div ref={ref} role="tablist" aria-label={label} className={cx("tabs", accent && "tabs-accent", className)}
      onKeyDown={(e) => { const el = rove(e, '[role="tab"]'); if (el) onChange(el.dataset.value as T); }}>
      {items.map((t) => {
        const on = t.value === value;
        return (
          <button key={t.value} id={`${id}-tab-${t.value}`} type="button" role="tab" aria-selected={on} tabIndex={on ? 0 : -1}
            data-value={t.value} disabled={t.disabled} className="tab" onClick={() => onChange(t.value)}>
            {t.label}
          </button>
        );
      })}
      <span className="tabs-ink" aria-hidden="true" />
    </div>
  );
}
