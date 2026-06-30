import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { Card } from "../lib/types";
import { getSettings, setSettings } from "../lib/settings";
import PosterCard from "../components/PosterCard";
import CategoryPicker, { ANIME_CATEGORIES, GENERIC_CATEGORIES } from "../components/CategoryPicker";
import { ChevronDown, ChevronLeft, ChevronRight, Film, Globe, Sparkles, Tv } from "../components/icons";

type Section = "anime" | "movies" | "series" | "asian";

const CFG: Record<Section, { title: string; icon: typeof Film; track?: boolean; typeToggle?: boolean; region?: boolean }> = {
  anime: { title: "Anime", icon: Sparkles, track: true, typeToggle: true },
  movies: { title: "Movies", icon: Film },
  series: { title: "Series", icon: Tv },
  asian: { title: "Asian Drama", icon: Globe, typeToggle: true, region: true },
};

const RANGES = [
  { key: "day", label: "Today" },
  { key: "week", label: "This Week" },
  { key: "month", label: "This Month" },
  { key: "year", label: "This Year" },
  { key: "all", label: "All Time" },
];
const REGIONS = [
  { key: "all", label: "All" },
  { key: "ko", label: "Korean" },
  { key: "zh", label: "Chinese" },
  { key: "ja", label: "Japanese" },
];

type Cat = "popular" | "trending" | "newest" | "toprated" | "random";

/** Number of columns the auto-fill grid currently shows (min 160px col + 16px gap). */
function useColumns(ref: React.RefObject<HTMLElement>) {
  const [cols, setCols] = useState(6);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const n = Math.max(1, Math.floor((w + 16) / (160 + 16)));
      setCols(n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return cols;
}

export default function Browse({ section }: { section: Section }) {
  const cfg = CFG[section];
  const Icon = cfg.icon;

  const [cat, setCat] = useState<Cat>("popular");
  const [range, setRange] = useState("week");
  const [type, setType] = useState<"all" | "tv" | "movie">("all");
  const [region, setRegion] = useState("all");
  const [audio, setAudio] = useState<"all" | "sub" | "dub">("all");
  const [genres, setGenres] = useState<string[]>([]);
  const [items, setItems] = useState<Card[] | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [nonce, setNonce] = useState(0);
  const [rangeOpen, setRangeOpen] = useState(false);

  const gridRef = useRef<HTMLDivElement>(null);
  const cols = useColumns(gridRef);

  // reset state when the section changes
  useEffect(() => { setCat("popular"); setType("all"); setRegion("all"); setAudio("all"); setGenres([]); setPage(1); }, [section]);

  useEffect(() => {
    let alive = true;
    setItems(null);
    api.browse(section, { cat, type: cfg.typeToggle ? type : undefined, range, region: cfg.region ? region : undefined, audio: cfg.track ? audio : undefined, genres, page })
      .then((r) => { if (!alive) return; setItems(r.items); setTotalPages(r.totalPages); })
      .catch(() => alive && setItems([]));
    return () => { alive = false; };
  }, [section, cat, type, region, range, audio, genres, page, nonce, cfg.typeToggle, cfg.region, cfg.track]);

  // Sub/Dub: filter the catalog AND persist as the playback track preference
  function pickAudio(a: "sub" | "dub") {
    setAudio((prev) => (prev === a ? "all" : a));
    setSettings({ ...(getSettings() as object), anime: a } as never);
    setPage(1);
  }
  function pickCat(c: Cat) {
    setCat(c); setPage(1);
    if (c === "random") setNonce((n) => n + 1);
    // sensible default time-range per category (Reddit-style)
    if (c === "trending") setRange("week");
    else if (c === "toprated") setRange("all");
  }

  const showRange = cat === "trending" || cat === "toprated";
  // trim to whole rows for uniformity
  const shown = items ? items.slice(0, Math.max(cols, Math.floor(items.length / cols) * cols)) : null;

  return (
    <div className="container">
      <div className="anime-head">
        <h1 className="page-title"><Icon size={22} style={{ verticalAlign: -4, marginRight: 8, color: "var(--accent)" }} />{cfg.title}</h1>
        <div className="anime-tabs">
          <button className={`atab ${cat === "popular" && audio === "all" ? "active" : ""}`} onClick={() => { pickCat("popular"); setAudio("all"); }}>All</button>
          {cfg.track && <>
            <button className={`atab ${audio === "sub" ? "active" : ""}`} onClick={() => pickAudio("sub")}>Sub</button>
            <button className={`atab ${audio === "dub" ? "active" : ""}`} onClick={() => pickAudio("dub")}>Dub</button>
          </>}
          <button className={`atab ${cat === "trending" ? "active" : ""}`} onClick={() => pickCat("trending")}>Trending</button>
          <button className={`atab ${cat === "newest" ? "active" : ""}`} onClick={() => pickCat("newest")}>Newest</button>
          <button className={`atab ${cat === "toprated" ? "active" : ""}`} onClick={() => pickCat("toprated")}>Top Rated</button>
          <button className={`atab ${cat === "random" ? "active" : ""}`} onClick={() => pickCat("random")}>Random</button>

          {showRange && (
            <div className="menu-wrap" style={{ marginLeft: "var(--space-1)" }}>
              <button className="btn btn-sm" onClick={() => setRangeOpen((v) => !v)} onBlur={() => setTimeout(() => setRangeOpen(false), 150)}>
                {RANGES.find((r) => r.key === range)?.label} <ChevronDown size={14} />
              </button>
              {rangeOpen && (
                <div className="menu below right">
                  <div className="menu-label">Time range</div>
                  {RANGES.map((r) => (
                    <button key={r.key} className={`menu-item ${range === r.key ? "active" : ""}`} onMouseDown={() => { setRange(r.key); setPage(1); setRangeOpen(false); }}>{r.label}</button>
                  ))}
                </div>
              )}
            </div>
          )}

          <span className="atab-sep" />
          <button className="btn btn-icon btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page"><ChevronLeft size={16} /></button>
          <span className="mono subtle" style={{ fontSize: "var(--text-xs)", minWidth: 28, textAlign: "center" }}>{page}</span>
          <button className="btn btn-icon btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
        </div>
      </div>

      {(cfg.typeToggle || cfg.region || cfg.track) && (
        <div className="anime-toolbar">
          {cfg.typeToggle && (
            <div className="segmented">
              <button className={`seg-opt ${type === "all" ? "active" : ""}`} onClick={() => { setType("all"); setPage(1); }}>All</button>
              <button className={`seg-opt ${type === "tv" ? "active" : ""}`} onClick={() => { setType("tv"); setPage(1); }}>Series</button>
              <button className={`seg-opt ${type === "movie" ? "active" : ""}`} onClick={() => { setType("movie"); setPage(1); }}>Movies</button>
            </div>
          )}
          {cfg.region && (
            <div className="segmented">
              {REGIONS.map((r) => (
                <button key={r.key} className={`seg-opt ${region === r.key ? "active" : ""}`} onClick={() => { setRegion(r.key); setPage(1); }}>{r.label}</button>
              ))}
            </div>
          )}
          {cfg.track && <span className="subtle" style={{ fontSize: "var(--text-sm)" }}>Sub / Dub filters the catalog and sets your playback track. Availability is estimated by popularity.</span>}
        </div>
      )}

      <div style={{ marginBottom: "var(--space-5)" }}>
        <CategoryPicker selected={genres} onChange={(g) => { setGenres(g); setPage(1); }} categories={section === "anime" ? ANIME_CATEGORIES : GENERIC_CATEGORIES} />
      </div>

      <div className="grid" ref={gridRef}>
        {!shown
          ? Array.from({ length: cols * 3 }).map((_, i) => <div className="skeleton" key={i} style={{ aspectRatio: "2/3" }} />)
          : shown.length === 0
            ? <div className="empty" style={{ gridColumn: "1 / -1" }}>Nothing found for this filter.</div>
            : shown.map((c) => (
              <PosterCard
                key={`${c.type}-${c.id}`}
                card={c}
                badge={cfg.track ? ((c.voteCount ?? 0) >= 500 ? "DUB" : "SUB") : undefined}
              />
            ))}
      </div>
    </div>
  );
}
