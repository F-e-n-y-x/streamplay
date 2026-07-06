import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBrowse } from "../lib/queries";
import { updateSettings, useSettings } from "../lib/settings";
import PosterCard from "../components/PosterCard";
import CategoryPicker, { ANIME_CATEGORIES, GENERIC_CATEGORIES } from "../components/CategoryPicker";
import { ChevronDown, ChevronLeft, ChevronRight, Film, Globe, Sparkles, Tv } from "../components/icons";

type Section = "anime" | "movies" | "series" | "asian";

const CFG: Record<Section, { title: string; icon: typeof Film; track?: boolean; typeToggle?: boolean; region?: boolean; industry?: boolean }> = {
  anime: { title: "Anime", icon: Sparkles, track: true, typeToggle: true },
  movies: { title: "Movies", icon: Film, industry: true },
  series: { title: "Series", icon: Tv, industry: true },
  asian: { title: "Asian Drama", icon: Globe, typeToggle: true, region: true },
};

// Film industries → TMDB original-language code. Lets Movies/Series be filtered by
// Bollywood/Tollywood/etc. (an axis TMDB genres don't cover).
const INDUSTRIES = [
  { key: "all", label: "All" },
  { key: "en", label: "Hollywood" },
  { key: "hi", label: "Bollywood" },
  { key: "te", label: "Tollywood" },
  { key: "ta", label: "Kollywood" },
  { key: "ml", label: "Mollywood" },
  { key: "kn", label: "Sandalwood" },
];

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

type Cat = "popular" | "trending" | "newest" | "toprated" | "random" | "airing" | "latest";

// Anime categories that are inherently 18+/suggestive — hidden from the picker and
// stripped from the query when the Show 18+ setting is off.
const ADULT_ANIME_CATS = new Set(["ecchi", "harem", "shoujoai", "shounenai"]);

/** Number of columns the auto-fill grid currently shows (min 160px col + 16px gap). */
function useColumns(ref: React.RefObject<HTMLElement | null>) {
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

  // Anime defaults to "Latest" (recently-aired episodes, like anikoto's home); other
  // sections default to Popular.
  const [cat, setCat] = useState<Cat>(cfg.track ? "latest" : "popular");
  const [range, setRange] = useState("week");
  const [type, setType] = useState<"all" | "tv" | "movie">("all");
  const [region, setRegion] = useState("all");
  const [industry, setIndustry] = useState("all");
  const [genres, setGenres] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [nonce, setNonce] = useState(0);
  const [rangeOpen, setRangeOpen] = useState(false);
  const { adult, anime } = useSettings();

  const gridRef = useRef<HTMLDivElement>(null);
  const cols = useColumns(gridRef);

  // Data via TanStack Query — cancels the in-flight request on any filter change,
  // caches results, and keys on lang/adult (inside the hook). `nonce` re-rolls Random.
  // Anime: "Dub" also filters the grid to titles with a known dub (best-effort);
  // "Sub" shows everything (all anime are subbed). It doubles as the playback pref.
  const audio = cfg.track && anime === "dub" ? "dub" : undefined;
  const browseQ = useBrowse(section, { cat, type: cfg.typeToggle ? type : undefined, range, region: cfg.region ? region : undefined, ol: cfg.industry ? industry : undefined, audio, genres, page, nonce });
  const items = browseQ.isError ? [] : browseQ.data?.items ?? null;
  const totalPages = browseQ.data?.totalPages ?? 1;

  // reset state when the section changes
  useEffect(() => { setCat(cfg.track ? "latest" : "popular"); setType("all"); setRegion("all"); setIndustry("all"); setGenres([]); setPage(1); }, [section, cfg.track]);

  // When 18+ is off, drop any explicitly-adult anime category the user had selected
  // (and they're hidden from the picker below) so ecchi/harem aren't requested.
  useEffect(() => { if (!adult) setGenres((g) => g.filter((k) => !ADULT_ANIME_CATS.has(k))); }, [adult]);

  function pickCat(c: Cat) {
    setCat(c); setPage(1);
    if (c === "random") setNonce((n) => n + 1);
    // sensible default time-range per category (Reddit-style)
    if (c === "trending") setRange("week");
    else if (c === "toprated") setRange("all");
  }

  const showRange = cat === "trending" || cat === "toprated";
  // Render every result. (Previously trimmed to whole rows for a tidy grid, but on
  // the last page that permanently hid the trailing 1..cols-1 items with no way to
  // reach them.) A short final row is fine; nothing gets dropped.
  const shown = items;

  return (
    <div className="container">
      <div className="anime-head">
        <h1 className="page-title"><Icon size={22} style={{ verticalAlign: -4, marginRight: 8, color: "var(--accent)" }} />{cfg.title}</h1>
        <div className="anime-tabs">
          {cfg.track && <button className={`atab ${cat === "latest" ? "active" : ""}`} onClick={() => pickCat("latest")}>Latest</button>}
          <button className={`atab ${cat === "popular" ? "active" : ""}`} onClick={() => pickCat("popular")}>{cfg.track ? "Popular" : "All"}</button>
          <button className={`atab ${cat === "trending" ? "active" : ""}`} onClick={() => pickCat("trending")}>Trending</button>
          {cfg.track && <button className={`atab ${cat === "airing" ? "active" : ""}`} onClick={() => pickCat("airing")}>Airing</button>}
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
        </div>
        {/* Pagination lives OUTSIDE the scrollable tab row so the next-page button is
            always visible on mobile (previously it scrolled off the right edge). */}
        <div className="anime-pager">
          <button className="btn btn-icon btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} aria-label="Previous page"><ChevronLeft size={16} /></button>
          <span className="mono subtle" style={{ fontSize: "var(--text-xs)", minWidth: 28, textAlign: "center" }}>{page}</span>
          <button className="btn btn-icon btn-ghost btn-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
        </div>
      </div>

      {(cfg.typeToggle || cfg.region || cfg.industry || cfg.track) && (
        <div className="anime-toolbar">
          {cfg.industry && (
            <div className="segmented">
              {INDUSTRIES.map((i) => (
                <button key={i.key} className={`seg-opt ${industry === i.key ? "active" : ""}`} onClick={() => { setIndustry(i.key); setPage(1); }}>{i.label}</button>
              ))}
            </div>
          )}
          {cfg.typeToggle && (
            <div className="segmented">
              <button className={`seg-opt ${type === "all" ? "active" : ""}`} onClick={() => { setType("all"); setPage(1); }}>All</button>
              <button className={`seg-opt ${type === "tv" ? "active" : ""}`} onClick={() => { setType("tv"); setPage(1); }}>Series</button>
              <button className={`seg-opt ${type === "movie" ? "active" : ""}`} onClick={() => { setType("movie"); setPage(1); }}>Movies</button>
            </div>
          )}
          {/* Audio: filters the grid AND sets the default playback track. "Dub" shows
              only titles with a known dub (best-effort — MyDubList, since AniList has no
              dub data) and makes the player prefer the dubbed source/track; "Sub" shows
              all anime (everything is subbed). */}
          {cfg.track && (
            <div className="seg-labeled" title="Sub shows all anime; Dub shows only titles with a known dub and defaults playback to the dubbed source">
              <span className="seg-cap">Audio</span>
              <div className="segmented">
                <button className={`seg-opt ${anime === "sub" ? "active" : ""}`} onClick={() => { updateSettings({ anime: "sub" }); setPage(1); }}>Sub</button>
                <button className={`seg-opt ${anime === "dub" ? "active" : ""}`} onClick={() => { updateSettings({ anime: "dub" }); setPage(1); }}>Dub</button>
              </div>
            </div>
          )}
          {cfg.region && (
            <div className="segmented">
              {REGIONS.map((r) => (
                <button key={r.key} className={`seg-opt ${region === r.key ? "active" : ""}`} onClick={() => { setRegion(r.key); setPage(1); }}>{r.label}</button>
              ))}
            </div>
          )}
        </div>
      )}

      <div style={{ marginBottom: "var(--space-5)" }}>
        <CategoryPicker selected={genres} onChange={(g) => { setGenres(g); setPage(1); }} categories={section === "anime" ? (adult ? ANIME_CATEGORIES : ANIME_CATEGORIES.filter((c) => !ADULT_ANIME_CATS.has(c.key))) : GENERIC_CATEGORIES} />
      </div>

      <div className="grid" ref={gridRef}>
        {!shown
          ? Array.from({ length: cols * 3 }).map((_, i) => <div className="skeleton" key={i} style={{ aspectRatio: "2/3" }} />)
          : shown.length === 0
            ? <div className="empty" style={{ gridColumn: "1 / -1" }}>Nothing found for this filter.</div>
            : shown.map((c) => (
              <PosterCard key={`${c.type}-${c.id}`} card={c} />
            ))}
      </div>
    </div>
  );
}
