import { useEffect, useId, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import { useNavigate } from "react-router-dom";
import { useSuggest } from "../lib/queries";
import type { Card } from "../lib/types";
import { Clock, Search, X } from "./icons";
import "../styles/search.css";

// ── Recent searches: only queries that found something or led to a click ─────────────
const KEY = "sp.recentSearches";
const subs = new Set<() => void>();
let recent: string[] = (() => { try { const v = JSON.parse(localStorage.getItem(KEY) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } })();
const setRecent = (v: string[]) => { recent = v; try { localStorage.setItem(KEY, JSON.stringify(v)); } catch { /* private mode */ } subs.forEach((f) => f()); };
export const saveRecent = (q: string) => { const t = q.trim(); if (t.length >= 2) setRecent([t, ...recent.filter((x) => x.toLowerCase() !== t.toLowerCase())].slice(0, 8)); };
export const removeRecent = (q: string) => setRecent(recent.filter((x) => x !== q));
export const clearRecent = () => setRecent([]);
export const useRecent = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => recent);

/** Title with the typed part in 600 ("Break" in "Breaking Bad"). */
export function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<b>{text.slice(i, i + q.length)}</b>{text.slice(i + q.length)}</>;
}

export const cardMeta = (c: Card) => [c.year, c.type === "tv" ? "Series" : "Movie"].filter(Boolean).join(" · ");

type Opt = { id: string; kind: "recent"; q: string } | { id: string; kind: "title"; c: Card } | { id: string; kind: "all" };

/**
 * Search field + suggestions (§8.17, ARIA 1.2 combobox). Empty + focused: recent searches.
 * 2+ characters: "Did you mean", up to 8 titles (poster, year · type) and a pinned last row
 * that runs the full search. ↑/↓ move, Enter opens, Esc closes and keeps the text.
 * `inline` renders the list in the page flow (phone search page) instead of a popover.
 */
export default function SearchBox({ value, onChange, onSubmit, className, inputRef, autoFocus, inline, placeholder = "Search movies, series, anime", children }: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (q: string) => void;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  autoFocus?: boolean;
  inline?: boolean;
  placeholder?: string;
  children?: ReactNode;
}) {
  const nav = useNavigate();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [debounced, setDebounced] = useState(value.trim());
  const rec = useRecent();
  useEffect(() => { const t = setTimeout(() => setDebounced(value.trim()), 200); return () => clearTimeout(t); }, [value]);
  useEffect(() => setActive(-1), [debounced, open]);

  const q = value.trim();
  const typing = q.length >= 2;
  const { data, isFetching } = useSuggest(debounced);
  const fix = typing && data?.didYouMean && data.didYouMean.toLowerCase() !== q.toLowerCase() ? data.didYouMean : undefined;
  const opts: Opt[] = !open ? [] : typing
    ? [...(data?.items ?? []).filter((c) => c.posterUrl || c.year).slice(0, 8).map((c, i): Opt => ({ id: `${id}-t${i}`, kind: "title", c })), { id: `${id}-all`, kind: "all" }]
    : q || inline ? [] : rec.slice(0, 6).map((r, i): Opt => ({ id: `${id}-r${i}`, kind: "recent", q: r }));
  const loading = typing && !data && isFetching;
  const shown = open && (opts.length > 0 || loading);

  const pick = (o: Opt | undefined) => {
    if (!o || o.kind === "all") { setOpen(false); return onSubmit(value); }
    if (o.kind === "recent") { onChange(o.q); setOpen(false); return onSubmit(o.q); }
    saveRecent(q);
    setOpen(false);
    nav(`/title/${o.c.type}/${o.c.id}`);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      const n = opts.length + 1;   // -1 = the field itself
      const d = e.key === "ArrowDown" ? 1 : -1;
      setActive((a) => ((((a + 1 + d) % n) + n) % n) - 1);
    } else if (e.key === "Escape" && shown) {
      e.preventDefault(); e.stopPropagation(); setOpen(false);
    } else if (e.key === "Enter" && shown && active >= 0) {
      e.preventDefault(); pick(opts[active]);
    }
  };

  return (
    <form className={`search-box ${inline ? "search-box-inline" : ""} ${className ?? ""}`} role="search" action="/search"
      onSubmit={(e) => { e.preventDefault(); setOpen(false); if (q) onSubmit(value); }}>
      <div className="search-field">
        <Search size={20} aria-hidden="true" />
        <input
          ref={inputRef} className="search-input" type="search" name="q" enterKeyHint="search" inputMode="search"
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          autoFocus={autoFocus} value={value} placeholder={placeholder} aria-label="Search movies, series and anime"
          role="combobox" aria-expanded={shown} aria-controls={`${id}-lb`} aria-autocomplete="list"
          aria-activedescendant={shown && active >= 0 ? opts[active]?.id : undefined}
          onChange={(e) => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKey}
        />
        {value && (
          <button type="button" className="icon-btn icon-btn-sm search-clear" aria-label="Clear search" title="Clear search"
            onMouseDown={(e) => e.preventDefault()} onClick={() => { onChange(""); setOpen(true); }}>
            <X size={16} />
          </button>
        )}
      </div>
      {children}
      <div className="suggest" hidden={!shown} onMouseDown={(e) => e.preventDefault() /* keep focus in the field */}>
        {fix && (
          <p className="suggest-fix">Did you mean <button type="button" tabIndex={-1} onClick={() => onChange(fix)}>{fix}</button>?</p>
        )}
        {!typing && opts.length > 0 && <p className="suggest-label">Recent searches</p>}
        <ul id={`${id}-lb`} role="listbox" aria-label={typing ? "Suggestions" : "Recent searches"} aria-busy={loading || undefined}>
          {loading && Array.from({ length: 3 }, (_, i) => (
            <li key={`s${i}`} className="suggest-row" aria-hidden="true"><span className="suggest-thumb skeleton" /><span className="skeleton skeleton-text" style={{ width: "60%" }} /></li>
          ))}
          {opts.map((o, i) => o.kind === "title" ? (
            <li key={o.id} id={o.id} role="option" aria-selected={active === i} className="suggest-row" onClick={() => pick(o)} onMouseEnter={() => setActive(i)}>
              {o.c.posterUrl
                ? <img className="suggest-thumb" src={o.c.posterUrl.replace(/\/w\d+\//, "/w92/")} alt="" width={40} height={60} loading="lazy" />
                : <span className="suggest-thumb" />}
              <span className="suggest-text">
                <span className="suggest-title"><Highlight text={o.c.title} q={q} /></span>
                <span className="suggest-meta">{cardMeta(o.c)}</span>
              </span>
            </li>
          ) : o.kind === "recent" ? (
            <li key={o.id} id={o.id} role="option" aria-selected={active === i} className="suggest-row suggest-recent" onClick={() => pick(o)} onMouseEnter={() => setActive(i)}>
              <Clock size={18} aria-hidden="true" />
              <span className="suggest-title">{o.q}</span>
              <button type="button" className="icon-btn icon-btn-sm" tabIndex={-1} aria-label={`Remove ${o.q} from recent searches`} title="Remove"
                onClick={(e) => { e.stopPropagation(); removeRecent(o.q); }}><X size={14} /></button>
            </li>
          ) : (
            <li key={o.id} id={o.id} role="option" aria-selected={active === i} className="suggest-row suggest-all" onClick={() => pick(o)} onMouseEnter={() => setActive(i)}>
              <Search size={18} aria-hidden="true" />
              <span className="suggest-title">Search for “{q}”</span>
              <kbd className="suggest-kbd">Enter</kbd>
            </li>
          ))}
        </ul>
      </div>
    </form>
  );
}
