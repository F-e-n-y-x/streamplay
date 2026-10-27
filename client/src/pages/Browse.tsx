import { useEffect, useRef, useState } from "react";
import { NavLink, useSearchParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { api, type BrowseOpts } from "../lib/api";
import type { Card } from "../lib/types";
import { updateSettings, useSettings } from "../lib/settings";
import { useDocTitle } from "../lib/useDocTitle";
import PosterCard, { PosterSkeleton } from "../components/PosterCard";
import { ANIME_CATEGORIES, GENERIC_CATEGORIES } from "../components/CategoryPicker";
import { Button, FilterChip, InputChip, ListGroup, ListRow, Menu, Panel, SegmentedControl, StateMessage, Tabs } from "../components/ui";
import { ChevronDown, Filter } from "../components/icons";
import "../styles/browse.css";

type Section = "anime" | "movies" | "series" | "asian";
type Opt = { value: string; label: string };

const SECTIONS: Opt[] = [{ value: "movies", label: "Movies" }, { value: "series", label: "Series" }, { value: "anime", label: "Anime" }, { value: "asian", label: "Asian" }];
const SORT_TMDB: Opt[] = [{ value: "popular", label: "Popular" }, { value: "trending", label: "Trending" }, { value: "newest", label: "New releases" }, { value: "toprated", label: "Top rated" }];
const SORT_ANIME: Opt[] = [{ value: "popular", label: "Popular" }, { value: "trending", label: "Trending" }, { value: "airing", label: "Airing now" }, { value: "latest", label: "New releases" }, { value: "toprated", label: "Top rated" }];
const CFG: Record<Section, { title: string; sort: Opt[]; type?: boolean; region?: boolean; industry?: boolean; audio?: boolean }> = {
  movies: { title: "Movies", sort: SORT_TMDB, industry: true },
  series: { title: "Series", sort: SORT_TMDB, industry: true },
  anime: { title: "Anime", sort: SORT_ANIME, type: true, audio: true },
  asian: { title: "Asian", sort: SORT_TMDB, type: true, region: true },
};
// Film industries → TMDB original-language code (an axis TMDB genres don't cover).
const INDUSTRIES: Opt[] = [{ value: "all", label: "All industries" }, { value: "en", label: "Hollywood" }, { value: "hi", label: "Bollywood" }, { value: "te", label: "Tollywood" }, { value: "ta", label: "Kollywood" }, { value: "ml", label: "Mollywood" }, { value: "kn", label: "Sandalwood" }];
const REGIONS: Opt[] = [{ value: "all", label: "All regions" }, { value: "ko", label: "Korean" }, { value: "zh", label: "Chinese" }, { value: "ja", label: "Japanese" }];
const RANGES: Opt[] = [{ value: "day", label: "Today" }, { value: "week", label: "This week" }, { value: "month", label: "This month" }, { value: "year", label: "This year" }, { value: "all", label: "All time" }];
const TYPES = [{ value: "all", label: "All" }, { value: "tv", label: "Series" }, { value: "movie", label: "Movies" }] as const;
// 18+ anime categories: hidden (and dropped from the URL) while Show 18+ is off.
const ADULT_ANIME_CATS = new Set(["ecchi", "harem", "shoujoai", "shounenai"]);
const label = (opts: Opt[], v: string) => opts.find((o) => o.value === v)?.label ?? opts[0].label;

/** Pages of a browse view, appended by infinite scroll. Keyed like useBrowse (+ lang/adult). */
function useBrowsePages(section: string, opts: BrowseOpts) {
  const { lang, adult } = useSettings();
  return useInfiniteQuery({
    queryKey: ["browse-pages", section, opts, lang, adult],
    queryFn: ({ signal, pageParam }) => api.browse(section, { ...opts, page: pageParam }, signal),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
    placeholderData: (prev) => prev,
  });
}

/**
 * Browse (pages.md §2): one toolbar row (sort · type · audio · Filters), everything else in
 * the Filters panel. All state lives in the URL (?cat=&range=&type=&region=&ol=&genres=),
 * so Back/refresh/share restore the view. Routes are keyed per section (App.tsx).
 */
export default function Browse({ section }: { section: Section }) {
  const cfg = CFG[section];
  const [params, setParams] = useSearchParams();
  const { adult, anime } = useSettings();
  const [panel, setPanel] = useState(false);
  useDocTitle(cfg.title);

  const cat = params.get("cat") ?? "popular";
  const ranged = cat === "trending" || cat === "toprated" || cat === "newest";
  const range = params.get("range") ?? (cat === "toprated" ? "all" : "week");
  const type = params.get("type") ?? "all";
  const region = params.get("region") ?? "all";
  const industry = params.get("ol") ?? "all";
  const genres = (params.get("genres") ?? "").split(",").filter((g) => g && (adult || !ADULT_ANIME_CATS.has(g)));
  const nonce = Number(params.get("r")) || 0;
  const categories = section === "anime" ? ANIME_CATEGORIES.filter((c) => adult || !ADULT_ANIME_CATS.has(c.key)) : GENERIC_CATEGORIES;
  const catLabel = Object.fromEntries(categories.map((c) => [c.key, c.label]));

  /** Patch the URL. Default values are dropped so shared links stay short. */
  const set = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) (v == null || v === "" || (v === "all" && k !== "range") ? p.delete(k) : p.set(k, v));
    p.delete("page");
    setParams(p);
  };
  const pickSort = (c: string) => set({ cat: c === "popular" ? null : c, range: null, r: null });
  const surprise = () => { set({ cat: "random", range: null, r: String(nonce + 1) }); setPanel(false); };
  const toggleGenre = (g: string) => set({ genres: (genres.includes(g) ? genres.filter((x) => x !== g) : [...genres, g]).join(",") || null });
  const setAudio = (v: "sub" | "dub") => updateSettings({ anime: v });
  const clearFilters = () => set({ genres: null, type: null, region: null, ol: null });

  // Anime "Dub" also narrows the grid to titles with a known dub and is the playback default.
  const audio = cfg.audio && anime === "dub" ? "dub" : undefined;
  const q = useBrowsePages(section, {
    cat, range: ranged ? range : undefined, type: cfg.type ? type : undefined, region: cfg.region ? region : undefined,
    ol: cfg.industry ? industry : undefined, audio, genres, nonce,
  });
  const seen = new Set<string>();
  const items: Card[] = [];
  for (const c of q.data?.pages.flatMap((p) => p.items) ?? []) { const k = `${c.type}-${c.id}`; if (!seen.has(k)) { seen.add(k); items.push(c); } }

  // infinite scroll: fetch the next page when the sentinel nears the viewport
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = q;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage || isFetchNextPageError) return;   // after a failed page, only the button retries
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && !isFetchingNextPage) fetchNextPage(); }, { rootMargin: "800px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage, items.length]);

  const activeCount = genres.length + (type !== "all" && cfg.type ? 1 : 0) + (region !== "all" && cfg.region ? 1 : 0) + (industry !== "all" && cfg.industry ? 1 : 0);
  const typeLabel = TYPES.find((t) => t.value === type)?.label;
  const sortOpts = cfg.sort;
  const sortLabel = cat === "random" ? "Surprise" : label(sortOpts, cat);
  const mixed = cfg.type && type === "all";

  const filtersBtn = (
    <Button variant="secondary" className="browse-filters-btn" icon={<Filter size={18} />} onClick={() => setPanel(true)} aria-haspopup="dialog" aria-label={`Filters${activeCount ? `, ${activeCount} applied` : ""}`}>
      <span className="browse-xs-hide">Filters</span>{activeCount > 0 && <span className="badge">{activeCount}</span>}
    </Button>
  );
  const typeSeg = cfg.type && <SegmentedControl label="Type" value={type} onChange={(v) => set({ type: v })} options={TYPES.map((t) => ({ ...t }))} />;
  const audioSeg = cfg.audio && <SegmentedControl label="Audio" value={anime} onChange={setAudio} options={[{ value: "sub", label: "Sub" }, { value: "dub", label: "Dub" }]} />;
  const rangeMenu = ranged && (
    <Menu label="Time range" items={RANGES.map((o) => ({ label: o.label, checked: o.value === range, onSelect: () => set({ range: o.value }) }))}
      trigger={(p) => <Button {...p} variant="ghost">{label(RANGES, range)} <ChevronDown size={16} aria-hidden="true" /></Button>} />
  );

  return (
    <div className="container browse">
      <h1 className="sr-only">{cfg.title}</h1>
      {/* phones: section switch (the header has no section nav there) */}
      <nav className="browse-sections" aria-label="Sections">
        {SECTIONS.map((s) => <NavLink key={s.value} to={`/${s.value}`} className="browse-section">{s.label}</NavLink>)}
      </nav>

      <div className="browse-toolbar">
        <Tabs id="sort" label="Sort" className="browse-sort-tabs" value={cat} onChange={pickSort}
          items={sortOpts.map((o) => ({ value: o.value, label: o.label }))} />
        <Menu label="Sort" items={sortOpts.map((o) => ({ label: o.label, checked: o.value === cat, onSelect: () => pickSort(o.value) }))}
          trigger={(p) => <Button {...p} variant="secondary" className="browse-sort-menu"><span className="browse-xs-hide">Sort: </span>{sortLabel} <ChevronDown size={16} aria-hidden="true" /></Button>} />
        {rangeMenu && <span className="browse-wide-only">{rangeMenu}</span>}
        <div className="browse-tools">
          {cfg.industry && (
            <Menu label="Film industry" align="end" items={INDUSTRIES.map((o) => ({ label: o.label, checked: o.value === industry, onSelect: () => set({ ol: o.value }) }))}
              trigger={(p) => <Button {...p} variant="secondary" className="browse-wide-only">{label(INDUSTRIES, industry)} <ChevronDown size={16} aria-hidden="true" /></Button>} />
          )}
          {typeSeg && <span className="browse-wide-only">{typeSeg}</span>}
          {audioSeg}
          {filtersBtn}
          <Button variant="secondary" className="browse-wide-only" onClick={surprise}>Surprise me</Button>
        </div>
      </div>

      {activeCount > 0 && (
        <div className="browse-applied" aria-label="Applied filters">
          {cfg.type && type !== "all" && <InputChip onRemove={() => set({ type: null })} removeLabel={`Remove ${typeLabel}`}>{typeLabel}</InputChip>}
          {cfg.industry && industry !== "all" && <InputChip onRemove={() => set({ ol: null })} removeLabel={`Remove ${label(INDUSTRIES, industry)}`}>{label(INDUSTRIES, industry)}</InputChip>}
          {cfg.region && region !== "all" && <InputChip onRemove={() => set({ region: null })} removeLabel={`Remove ${label(REGIONS, region)}`}>{label(REGIONS, region)}</InputChip>}
          {genres.map((g) => <InputChip key={g} onRemove={() => toggleGenre(g)} removeLabel={`Remove ${catLabel[g] ?? g}`}>{catLabel[g] ?? g}</InputChip>)}
          <Button variant="ghost" size="sm" onClick={clearFilters}>Clear all</Button>
        </div>
      )}

      {q.isError && !items.length ? (
        <StateMessage kind="error" title={`Couldn't load ${cfg.title.toLowerCase()}.`} body="Check your connection and try again." details={String(q.error)}
          actions={<Button variant="solid" onClick={() => q.refetch()} loading={q.isFetching}>Try again</Button>} />
      ) : q.isPending ? (
        <div className="grid" aria-busy="true">{Array.from({ length: 18 }, (_, i) => <PosterSkeleton key={i} />)}</div>
      ) : items.length === 0 ? (
        <StateMessage kind="empty" title="No titles match these filters." body="Remove a filter or two to see more."
          actions={activeCount > 0 ? <Button variant="solid" onClick={clearFilters}>Clear filters</Button> : undefined} />
      ) : (
        <>
          <div className={`grid${q.isPlaceholderData ? " is-stale" : ""}`} aria-busy={q.isPlaceholderData || undefined}>
            {items.map((c) => <PosterCard key={`${c.type}-${c.id}`} card={c} showType={mixed} />)}
            {isFetchingNextPage && Array.from({ length: 6 }, (_, i) => <PosterSkeleton key={`s${i}`} />)}
          </div>
          <div ref={sentinel} className="browse-end">
            {q.isFetchNextPageError
              ? <Button onClick={() => fetchNextPage()}>Couldn't load more. Try again</Button>
              : !hasNextPage && <p>That's everything for these filters.</p>}
          </div>
        </>
      )}

      <Panel open={panel} onClose={() => setPanel(false)} title="Filters"
        footer={<>
          <Button variant="ghost" onClick={clearFilters} disabled={activeCount === 0}>Clear</Button>
          <Button variant="solid" onClick={() => setPanel(false)}>Show results</Button>
        </>}>
        <div className="browse-panel">
          {cfg.type && (
            <section className="browse-panel-sec browse-narrow-only">
              <h3>Type</h3>
              <SegmentedControl label="Type" value={type} onChange={(v) => set({ type: v })} options={TYPES.map((t) => ({ ...t }))} />
            </section>
          )}
          {ranged && (
            <section className="browse-panel-sec browse-narrow-only">
              <h3>Time range</h3>
              <ListGroup role="radiogroup" label="Time range">
                {RANGES.map((o) => <ListRow key={o.value} kind="choice" title={o.label} checked={o.value === range} onClick={() => set({ range: o.value })} />)}
              </ListGroup>
            </section>
          )}
          {cfg.region && (
            <section className="browse-panel-sec">
              <h3>Region</h3>
              <ListGroup role="radiogroup" label="Region">
                {REGIONS.map((o) => <ListRow key={o.value} kind="choice" title={o.label} checked={o.value === region} onClick={() => set({ region: o.value })} />)}
              </ListGroup>
            </section>
          )}
          {cfg.industry && (
            <section className="browse-panel-sec">
              <h3>Industry</h3>
              <ListGroup role="radiogroup" label="Film industry">
                {INDUSTRIES.map((o) => <ListRow key={o.value} kind="choice" title={o.label} checked={o.value === industry} onClick={() => set({ ol: o.value })} />)}
              </ListGroup>
            </section>
          )}
          <section className="browse-panel-sec">
            <h3>Genres</h3>
            <div className="browse-chips">
              {categories.map((c) => <FilterChip key={c.key} selected={genres.includes(c.key)} onClick={() => toggleGenre(c.key)}>{c.label}</FilterChip>)}
            </div>
          </section>
          <section className="browse-panel-sec browse-narrow-only">
            <Button variant="secondary" onClick={surprise}>Surprise me</Button>
          </section>
        </div>
      </Panel>
    </div>
  );
}
