import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, ChevronDown } from "../icons";
import { Skeleton, SkeletonText } from "./Skeleton";
import { rove } from "./rove";

export interface EpisodeListItemProps {
  number: number;
  title: string;
  /** 16:9 still; without one the number is shown large */
  still?: string;
  /** minutes */
  runtime?: number;
  overview?: string;
  /** YYYY-MM-DD. Shown as "Aired Feb 10" only within 30 days; a future date = unaired ("Coming Mar 3") */
  airDate?: string;
  /** 0–1 from history; a bar shows between 2% and 90% */
  progress?: number;
  watched?: boolean;
  /** The episode playing now: accent tint + bar, "Playing", aria-current */
  current?: boolean;
  /** Label for the current row. Default "Playing" (with the equalizer). The Title page passes
   *  "Up next" / "Continue" for the resume episode (accent row, no equalizer). */
  currentLabel?: string;
  /** panel = Episodes panel / Watch rail (128px still), page = Title page (160px, synopsis open on desktop) */
  size?: "panel" | "page";
  to?: string;
  onSelect?: () => void;
}

const DAY = 86_400_000;

function airInfo(airDate?: string): { unaired: boolean; label?: string } {
  if (!airDate) return { unaired: false };
  const d = new Date(`${airDate}T00:00:00`);
  if (Number.isNaN(d.getTime())) return { unaired: false };
  const now = Date.now();
  const fmt = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...o });
  if (d.getTime() > now) return { unaired: true, label: `Coming ${fmt({})}` };
  if (now - d.getTime() < 30 * DAY) return { unaired: false, label: `Aired ${fmt({})}` };
  return { unaired: false };
}

/** One episode row: still, number + title, runtime, progress/watched, expandable synopsis.
 *  The whole row is the link/button. Use inside <EpisodeList>. */
export function EpisodeListItem({ number, title, still, runtime, overview, airDate, progress = 0, watched, current, currentLabel, size = "panel", to, onSelect }: EpisodeListItemProps) {
  const { unaired, label: air } = airInfo(airDate);
  const partial = !watched && progress > 0.02 && progress < 0.9;
  const left = partial && runtime ? Math.max(1, Math.round(runtime * (1 - progress))) : null;
  const [open, setOpen] = useState(false);
  const [clamped, setClamped] = useState(false);
  const syn = useRef<HTMLParagraphElement>(null);
  const synId = useId();

  // Offer "More" only when the synopsis is actually cut off.
  useLayoutEffect(() => {
    const el = syn.current;
    if (!el || open) return;
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [overview, open]);

  const head: ReactNode = <><span className="epi-num"><span className="sr-only">Episode </span>{number}</span>{title}{watched && <span className="sr-only">, watched</span>}</>;
  const hit = unaired
    ? <button type="button" className="epi-hit" aria-disabled="true">{head}</button>
    : to
      ? <Link to={to} className="epi-hit" aria-current={current || undefined} onClick={onSelect}>{head}</Link>
      : <button type="button" className="epi-hit" aria-current={current || undefined} onClick={onSelect}>{head}</button>;

  return (
    <li className="epi" data-size={size} data-current={current ? "" : undefined} data-unaired={unaired ? "" : undefined}>
      <div className="epi-thumb">
        {still ? <img src={still} alt="" loading="lazy" decoding="async" /> : <span className="epi-thumb-num" aria-hidden="true">{number}</span>}
        {current && !currentLabel && <span className="epi-eq" aria-hidden="true"><i /><i /><i /></span>}
        {(partial || current) && progress > 0.02 && progress < 0.9 && (
          <span className="epi-progress" aria-hidden="true"><span style={{ "--p": progress } as CSSProperties} /></span>
        )}
      </div>
      <div className="epi-text">
        {hit}
        <div className="meta-line">
          {current && <span className="epi-playing">{currentLabel ?? "Playing"}</span>}
          {current && left != null && <span>{left} min left</span>}
          {(!current || left == null) && runtime ? <span>{runtime} min</span> : null}
          {air && <span>{air}</span>}
        </div>
        {overview && (
          <>
            <p id={synId} ref={syn} className="epi-synopsis" data-open={open ? "" : undefined}>{overview}</p>
            {(clamped || open) && (
              <button type="button" className="epi-more btn-link" aria-expanded={open} aria-controls={synId} onClick={() => setOpen((v) => !v)}>
                {open ? "Less" : "More"} <ChevronDown size={14} aria-hidden="true" />
              </button>
            )}
          </>
        )}
      </div>
      <div className="epi-state">
        {watched ? <Check size={16} aria-hidden="true" /> : !current && left != null ? <span>{left} min left</span> : null}
      </div>
    </li>
  );
}

/** List wrapper: ↑/↓ move between episodes (Home/End too). */
export function EpisodeList({ children, label }: { children: ReactNode; label: string }) {
  return <ul className="epi-list" aria-label={label} onKeyDown={(e) => { rove(e, ".epi-hit:not([aria-disabled])", "y"); }}>{children}</ul>;
}

/** Loading rows matching the final layout (Episodes panel season switch: 4 rows). */
export function EpisodeListSkeleton({ rows = 4, size = "panel" }: { rows?: number; size?: "panel" | "page" }) {
  return (
    <ul className="epi-list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="epi" data-size={size}>
          <Skeleton aspect="16 / 9" radius="var(--radius-sm)" />
          <SkeletonText lines={2} />
          <span />
        </li>
      ))}
    </ul>
  );
}
