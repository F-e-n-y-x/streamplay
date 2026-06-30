import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Compass, Drama, FileText, Filter, Flame, Ghost, Heart, Laugh, Music, Rocket, Search, Shield, Sparkles, Users, X, Zap } from "./icons";

type IconC = typeof Zap;
export interface CategoryDef { key: string; label: string; Icon?: IconC }

/** Generic genres (Movies / Series / Asian) — with icons. */
export const GENERIC_CATEGORIES: CategoryDef[] = [
  { key: "action", label: "Action", Icon: Zap },
  { key: "adventure", label: "Adventure", Icon: Compass },
  { key: "comedy", label: "Comedy", Icon: Laugh },
  { key: "drama", label: "Drama", Icon: Drama },
  { key: "romance", label: "Romance", Icon: Heart },
  { key: "scifi", label: "Sci-Fi", Icon: Rocket },
  { key: "fantasy", label: "Fantasy", Icon: Sparkles },
  { key: "horror", label: "Horror", Icon: Ghost },
  { key: "thriller", label: "Thriller", Icon: Flame },
  { key: "mystery", label: "Mystery", Icon: Search },
  { key: "crime", label: "Crime", Icon: Shield },
  { key: "family", label: "Family", Icon: Users },
  { key: "music", label: "Music", Icon: Music },
  { key: "documentary", label: "Documentary", Icon: FileText },
];

/** Anime (MAL/AniList-style) categories. */
export const ANIME_CATEGORIES: CategoryDef[] = ([
  ["action", "Action"], ["adventure", "Adventure"], ["cars", "Cars"], ["comedy", "Comedy"],
  ["dementia", "Dementia"], ["demons", "Demons"], ["drama", "Drama"], ["ecchi", "Ecchi"],
  ["fantasy", "Fantasy"], ["game", "Game"], ["harem", "Harem"], ["historical", "Historical"],
  ["horror", "Horror"], ["isekai", "Isekai"], ["josei", "Josei"], ["kids", "Kids"],
  ["magic", "Magic"], ["mahoushoujo", "Mahou Shoujo"], ["martialarts", "Martial Arts"], ["mecha", "Mecha"],
  ["military", "Military"], ["music", "Music"], ["mystery", "Mystery"], ["parody", "Parody"],
  ["police", "Police"], ["psychological", "Psychological"], ["romance", "Romance"], ["samurai", "Samurai"],
  ["school", "School"], ["scifi", "Sci-Fi"], ["seinen", "Seinen"], ["shoujo", "Shoujo"],
  ["shoujoai", "Shoujo Ai"], ["shounen", "Shounen"], ["shounenai", "Shounen Ai"], ["sliceoflife", "Slice of Life"],
  ["space", "Space"], ["sports", "Sports"], ["superpower", "Super Power"], ["supernatural", "Supernatural"],
  ["suspense", "Suspense"], ["thriller", "Thriller"], ["vampire", "Vampire"],
] as [string, string][]).map(([key, label]) => ({ key, label }));

export default function CategoryPicker({ selected, onChange, categories = GENERIC_CATEGORIES }: { selected: string[]; onChange: (s: string[]) => void; categories?: CategoryDef[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const byKey = Object.fromEntries(categories.map((c) => [c.key, c]));

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const toggle = (k: string) => onChange(selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]);
  const wide = categories.length > 16;

  return (
    <div className="cat-picker">
      <div className="menu-wrap" ref={ref}>
        <button className="dropdown-trigger cat-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="listbox">
          <span className="cat-trigger-label"><Filter size={15} /> Categories{selected.length > 0 && <span className="count-badge">{selected.length}</span>}</span>
          <ChevronDown size={16} />
        </button>
        {open && (
          <div className={`menu below cat-menu ${wide ? "cat-menu-grid" : ""}`} role="listbox" aria-multiselectable="true">
            {categories.map(({ key, label, Icon }) => (
              <button key={key} role="option" aria-selected={selected.includes(key)} className={`menu-item ${selected.includes(key) ? "active" : ""}`} onClick={() => toggle(key)}>
                <span className="cat-opt">{Icon && <Icon size={15} />} {label}</span>
                {selected.includes(key) && <Check size={14} />}
              </button>
            ))}
          </div>
        )}
      </div>

      {selected.length > 0 && (
        <div className="cat-chips">
          {selected.map((k) => {
            const c = byKey[k];
            if (!c) return null;
            const Ic = c.Icon;
            return (
              <span key={k} className="rchip">
                {Ic && <Ic size={13} />} {c.label}
                <button className="x" aria-label={`Remove ${c.label}`} onClick={() => toggle(k)}><X size={12} /></button>
              </span>
            );
          })}
          <button className="btn btn-ghost btn-sm" onClick={() => onChange([])}>Clear all</button>
        </div>
      )}
    </div>
  );
}
