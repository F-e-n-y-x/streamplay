import { Children, cloneElement, useCallback, useEffect, useId, useRef, useState, type ReactElement } from "react";
import { Link } from "react-router-dom";
import { dragScroll } from "../lib/useDragScroll";
import { ChevronLeft, ChevronRight } from "./icons";
import "../styles/home.css";

type Kind = "poster" | "wide" | "top10";

/**
 * Row / carousel (§8.7). The next card always peeks; arrows show only on hover devices and
 * only when the row actually overflows. Roving tabindex: the row is ONE tab stop (the
 * last-focused card); arrow keys move between cards via the app-wide spatial nav (App.tsx).
 * Children must accept a `tabIndex` prop (PosterCard, ContinueCard).
 */
export default function Row({ title, kind = "poster", seeAll, className = "", children }:
  { title: string; kind?: Kind; seeAll?: string; className?: string; children: ReactElement<{ tabIndex?: number }>[] }) {
  const [active, setActive] = useState(0);
  const [edge, setEdge] = useState({ start: true, end: true });
  const track = useRef<HTMLDivElement | null>(null);
  const id = useId();
  const setTrack = useCallback((el: HTMLDivElement | null) => { track.current = el; return dragScroll(el); }, []);

  const measure = useCallback(() => {
    const t = track.current;
    if (t) setEdge({ start: t.scrollLeft < 4, end: t.scrollLeft + t.clientWidth >= t.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    const t = track.current;
    if (!t) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(t);
    t.addEventListener("scroll", measure, { passive: true });
    return () => { ro.disconnect(); t.removeEventListener("scroll", measure); };
  }, [measure, children.length]);

  if (!children.length) return null;
  const cur = Math.min(active, children.length - 1);
  const page = (dir: number) => { const t = track.current; t?.scrollBy({ left: dir * t.clientWidth * 0.85, behavior: "smooth" }); };

  return (
    <section className={`row row-${kind} ${className}`} aria-labelledby={id}>
      <div className="row-head">
        <h2 id={id}>{title}</h2>
        {seeAll && <Link to={seeAll} className="btn btn-ghost btn-sm row-all">See all</Link>}
      </div>
      <div className="row-viewport">
        {!edge.start && <button type="button" className="icon-btn icon-btn-media row-arrow row-prev" tabIndex={-1} aria-hidden="true" onClick={() => page(-1)}><ChevronLeft size={20} /></button>}
        <div className="row-track"
          ref={setTrack}
          onFocus={(e) => { const i = Array.prototype.indexOf.call(e.currentTarget.children, e.target.closest(".row-track > *")); if (i >= 0) setActive(i); }}>
          {Children.map(children, (c, i) => cloneElement(c, { tabIndex: i === cur ? 0 : -1 }))}
        </div>
        {!edge.end && <button type="button" className="icon-btn icon-btn-media row-arrow row-next" tabIndex={-1} aria-hidden="true" onClick={() => page(1)}><ChevronRight size={20} /></button>}
      </div>
    </section>
  );
}

/** Skeleton row: heading bar + cards in the final shape. */
export function RowSkeleton({ kind = "poster" }: { kind?: Kind }) {
  return (
    <section className={`row row-${kind}`} aria-hidden="true">
      <div className="row-head"><span className="skeleton skeleton-text" style={{ width: "10rem", height: "1.125rem" }} /></div>
      <div className="row-viewport">
        <div className="row-track">
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className="card">
              <span className="card-art skeleton" style={{ aspectRatio: kind === "wide" ? "16 / 9" : "2 / 3" }} />
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
