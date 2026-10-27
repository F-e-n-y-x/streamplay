import { useEffect, useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, X } from "../icons";
import { IconButton, cx } from "./Button";

const SHEET = "(max-width: 767px) and (orientation: portrait)";
const EXIT_MS = 200;   // ≥ --duration-exit
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export interface PanelProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Shows a back chevron (sub-view). Sub-views push inside the same panel, never a second panel. */
  onBack?: () => void;
  /** Key of the current view. Changing it slides the new view in (from the right when onBack is set). */
  view?: string;
  /** Sticky area under the header: season Tabs/Select, a search field */
  subheader?: ReactNode;
  /** Sticky actions at the bottom */
  footer?: ReactNode;
  /** Render inside this element (the player, so it works in fullscreen). undefined = document.body;
   *  null = not ready yet (renders nothing). Side panel fills the container; the phone-portrait
   *  bottom sheet always attaches to the viewport. */
  container?: HTMLElement | null;
  /** Dim behind a side panel. Default true; false for in-player panels: the video stays
   *  visible AND usable (the container's chrome insets by --panel-w; a tap on the bare
   *  picture closes). The bottom sheet always dims and is always modal. */
  scrim?: boolean;
  /** Selector for the element to focus on open. Default: the current item
   *  ([aria-current="true"] / checked radio), else the first focusable in the body. */
  initialFocus?: string;
  className?: string;
}

/**
 * The one overlay primitive: right side panel on tablet/desktop/landscape, bottom sheet on
 * phone portrait (pure CSS switch). Dialog semantics, focus trapped, background inert,
 * Esc / scrim tap / swipe-down closes, focus returns to the opener.
 */
export function Panel({ open, onClose, title, children, onBack, view, subheader, footer, container, scrim = true, initialFocus, className }: PanelProps) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // mount → paint closed → flip to open (so the enter transition runs); close → exit → unmount
  useEffect(() => {
    if (open) { setMounted(true); return; }
    setShown(false);
    setExpanded(false);
    const t = window.setTimeout(() => setMounted(false), EXIT_MS);
    return () => window.clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (!mounted || !open) return;
    let r2 = 0;
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setShown(true)); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  }, [mounted, open]);

  // Modal behaviour: inert everything else, move focus in, restore on close.
  // An in-player panel (no scrim, side layout) leaves its container's player usable.
  const armed = useRef(false);   // focus moves after the initial one expand the sheet
  useEffect(() => {
    const root = rootRef.current, panel = panelRef.current;
    if (!mounted || !open || !root || !panel) return;
    const opener = document.activeElement as HTMLElement | null;
    const modal = scrim || !container || matchMedia(SHEET).matches;
    const inerted: [Element, boolean][] = [];   // [el, had aria-hidden already]
    // inert + aria-hidden + pointer-events:none ([data-inert]): Safari < 15.5 has no inert
    for (let el: Element = modal ? root : container!; el !== document.body && el.parentElement; el = el.parentElement) {
      for (const sib of el.parentElement.children) {
        if (sib !== el && !sib.hasAttribute("inert") && !/^(SCRIPT|STYLE|LINK)$/.test(sib.tagName)) {
          inerted.push([sib, sib.getAttribute("aria-hidden") === "true"]);
          sib.setAttribute("inert", ""); sib.setAttribute("aria-hidden", "true"); sib.setAttribute("data-inert", "");
        }
      }
    }
    const current = (initialFocus && panel.querySelector<HTMLElement>(initialFocus))
      || panel.querySelector<HTMLElement>('.panel-body [aria-current="true"] :is(a, button), .panel-body :is(a, button)[aria-current="true"], .panel-body [role="radio"][aria-checked="true"]');
    const target = current || panel.querySelector<HTMLElement>(`.panel-body :is(${FOCUSABLE})`) || panel;
    armed.current = false;
    target.focus({ preventScroll: true });
    armed.current = true;
    // only when it's out of view (a list that placed itself, e.g. EpisodeRows, is left alone)
    const body = panel.querySelector(".panel-body");
    if (current && body) {
      const r = current.getBoundingClientRect(), b = body.getBoundingClientRect();
      if (r.top < b.top || r.bottom > b.bottom) current.scrollIntoView({ block: "nearest" });
    }
    // the covered strip of the container: its own chrome insets by this (player.css)
    const cover = () => container?.style.setProperty("--panel-w", modal ? "0px" : `${panel.offsetWidth}px`);
    const ro = container ? new ResizeObserver(cover) : null;
    ro?.observe(panel);
    // non-modal: a tap on the bare picture (not a control) closes, and still lands
    const outside = (e: Event) => {
      const t = e.target as Element;
      if (!panel.contains(t) && !t.closest("button, a, input, select, [role='slider']")) closeRef.current();
    };
    if (!modal) container!.addEventListener("pointerdown", outside);
    // a scroll or swipe over the scrim must not move the page behind
    const block = (e: Event) => { if (e.target === root) e.preventDefault(); };
    root.addEventListener("touchmove", block, { passive: false });
    root.addEventListener("wheel", block, { passive: false });
    // Esc closes even when focus fell to <body> (e.g. the focused row left with a sub-view)
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); closeRef.current(); } };
    document.addEventListener("keydown", esc);
    return () => {
      ro?.disconnect();
      container?.style.removeProperty("--panel-w");
      container?.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc);
      root.removeEventListener("touchmove", block);
      root.removeEventListener("wheel", block);
      inerted.forEach(([el, hidden]) => { el.removeAttribute("inert"); el.removeAttribute("data-inert"); if (!hidden) el.removeAttribute("aria-hidden"); });
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, open]);

  // A new sub-view replaces the focused row: put focus on its current item or first control.
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    const body = panelRef.current?.querySelector(".panel-body");
    if (body) body.scrollTop = 0;   // a new view starts at its top
    (body?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"], [aria-current="true"]') ?? body?.querySelector<HTMLElement>(FOCUSABLE))?.focus({ preventScroll: true });
  }, [view]);

  // Sub-view slide direction: a view with a back chevron arrives from the right.
  const dir = onBack ? "push" : "back";

  // Swipe down to close (bottom sheet only). Pointer capture starts after 6px so taps on
  // the close button still click.
  const drag = useRef<{ y: number; t: number; base: number; id: number; moved: boolean } | null>(null);
  const onDown = (e: PointerEvent<HTMLElement>) => {
    const panel = panelRef.current;
    if (!panel || !matchMedia(SHEET).matches || e.button !== 0) return;
    drag.current = { y: e.clientY, t: e.timeStamp, base: new DOMMatrixReadOnly(getComputedStyle(panel).transform).m42, id: e.pointerId, moved: false };
  };
  const onMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current, panel = panelRef.current;
    if (!d || !panel || e.pointerId !== d.id) return;
    const dy = e.clientY - d.y;
    if (!d.moved) {
      if (Math.abs(dy) < 6) return;
      d.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      panel.setAttribute("data-dragging", "");
    }
    panel.style.transform = `translateY(${Math.max(0, d.base + dy)}px)`;
  };
  const onUp = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current, panel = panelRef.current;
    drag.current = null;
    if (!d?.moved || !panel) return;
    panel.removeAttribute("data-dragging");
    const dy = e.clientY - d.y;
    const fast = dy / Math.max(1, e.timeStamp - d.t) > 0.6;
    if (dy > panel.offsetHeight * 0.25 || (fast && dy > 0)) { panel.style.transform = "translateY(100%)"; closeRef.current(); return; }
    panel.style.transform = "";
    if (dy < -24) setExpanded(true);
  };
  const grab = { onPointerDown: onDown, onPointerMove: onMove, onPointerUp: onUp, onPointerCancel: onUp };

  if (!mounted || container === null) return null;
  return createPortal(
    <div ref={rootRef} className="panel-root" data-state={shown ? "open" : "closed"} data-contained={container ? "" : undefined} data-scrim={scrim ? "" : undefined}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={cx("panel", className)} data-expanded={expanded ? "" : undefined}
        onFocus={() => { if (armed.current) setExpanded(true); }}
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          const f = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length);
          if (!f.length) return;
          const first = f[0], last = f[f.length - 1];
          if (e.shiftKey && (document.activeElement === first || document.activeElement === e.currentTarget)) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }}>
        <div className="panel-grab" {...grab}>
          <div className="panel-handle" aria-hidden="true" />
          <div className="panel-head">
            {onBack && <IconButton className="panel-back" label="Back" onClick={onBack}><ChevronLeft size={20} /></IconButton>}
            <h2 id={titleId} className="panel-title">{title}</h2>
            <IconButton label="Close" onClick={onClose}><X size={20} /></IconButton>
          </div>
        </div>
        {subheader && <div className="panel-sub">{subheader}</div>}
        <div className="panel-body" onTouchMove={() => setExpanded(true)} onWheel={() => setExpanded(true)}>
          <div className="panel-view" key={view} data-dir={dir}>{children}</div>
        </div>
        {footer && <div className="panel-foot">{footer}</div>}
      </div>
    </div>,
    container ?? document.body,
  );
}
