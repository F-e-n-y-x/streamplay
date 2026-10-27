import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useHome, useSearch } from "../lib/queries";
import { useDocTitle } from "../lib/useDocTitle";
import type { Card } from "../lib/types";
import PosterCard, { PosterSkeleton } from "../components/PosterCard";
import SearchBox, { clearRecent, removeRecent, saveRecent, useRecent } from "../components/SearchBox";
import { Button, IconButton, StateMessage, Tabs } from "../components/ui";
import { Clock, X } from "../components/icons";
import "../styles/search.css";

type Kind = "all" | "tv" | "movie";
const BROWSE = [{ to: "/movies", label: "Movies" }, { to: "/series", label: "Series" }, { to: "/anime", label: "Anime" }, { to: "/asian", label: "Asian" }];

/**
 * /search. On desktop the header field is THE field (none on the page); below 1100px the page
 * has its own field with inline suggestions. Empty: recent searches, trending, browse links.
 */
export default function Search() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const q = (params.get("q") ?? "").trim();
  const kind = (["tv", "movie"].includes(params.get("type") ?? "") ? params.get("type") : "all") as Kind;
  const [draft, setDraft] = useState(q);
  const input = useRef<HTMLInputElement>(null);
  const res = useSearch(q);
  useDocTitle(q ? `“${q}”` : "Search");

  useEffect(() => { setDraft(q); }, [q]);
  // phones/tablets: the field is the page; focus it when there's nothing to show yet
  useEffect(() => { if (!q && matchMedia("(max-width: 1099px)").matches) input.current?.focus(); }, [q]);

  // Pages can overlap; dedupe across them.
  const seen = new Set<string>();
  const items: Card[] = [];
  for (const c of res.data?.pages.flatMap((p) => p.items) ?? []) {
    const k = `${c.type}-${c.id}`;
    if (!seen.has(k)) { seen.add(k); items.push(c); }
  }
  // Remember the query only once it found something (junk never reaches Recent).
  useEffect(() => { if (q && items.length) saveRecent(q); }, [q, items.length > 0]);   // eslint-disable-line react-hooks/exhaustive-deps

  const fix = res.data?.pages[0]?.didYouMean;
  const showFix = fix && fix.toLowerCase() !== q.toLowerCase();
  const counts = { all: items.length, tv: items.filter((c) => c.type === "tv").length, movie: items.filter((c) => c.type === "movie").length };
  const shown = kind === "all" ? items : items.filter((c) => c.type === kind);
  const setKind = (k: Kind) => { const p = new URLSearchParams(params); if (k === "all") p.delete("type"); else p.set("type", k); setParams(p, { replace: true }); };
  const submit = (v: string) => { const t = v.trim(); if (t) nav(`/search?q=${encodeURIComponent(t)}`); };

  return (
    <div className="container search-page">
      <div className="search-page-field">
        <SearchBox inline value={draft} onChange={setDraft} onSubmit={submit} inputRef={input} />
      </div>

      {!q ? (
        <>
          <h1 className="sr-only">Search</h1>
          <SearchStart />
        </>
      ) : (
        <>
          <header className="search-head">
            <h1 className={!res.isPending && !items.length ? "sr-only" : undefined}>Results for “{q}”</h1>
            {showFix && <p className="search-fix">Did you mean <Link to={`/search?q=${encodeURIComponent(fix)}`}>{fix}</Link>?</p>}
          </header>
          {res.isError && !items.length ? (
            <StateMessage kind="error" title="Search isn't working right now." body="Check your connection and try again." details={String(res.error)}
              actions={<Button variant="solid" onClick={() => res.refetch()} loading={res.isFetching}>Try again</Button>} />
          ) : res.isPending ? (
            <div className="grid" aria-busy="true">{Array.from({ length: 12 }, (_, i) => <PosterSkeleton key={i} />)}</div>
          ) : items.length === 0 ? (
            <StateMessage kind="empty" title={`No results for “${q}”`} body="Check the spelling, or try the original or English title."
              actions={<>
                {showFix && <Button variant="solid" to={`/search?q=${encodeURIComponent(fix)}`}>Search for “{fix}”</Button>}
                <Button to="/anime">Browse anime</Button>
                <Button to="/movies">Browse movies</Button>
              </>} />
          ) : (
            <>
              {/* one count: the tabs carry it when shown, else the status line */}
              {counts.tv > 0 && counts.movie > 0 ? (
                <Tabs id="search-kind" label="Filter results" value={kind} onChange={setKind} className="search-tabs" items={[
                  { value: "all", label: <>All <span className="tab-count">{counts.all}</span></> },
                  { value: "tv", label: <>Series <span className="tab-count">{counts.tv}</span></> },
                  { value: "movie", label: <>Movies <span className="tab-count">{counts.movie}</span></> },
                ]} />
              ) : <p className="search-count" role="status">{res.hasNextPage ? `Top ${items.length} results` : `${items.length} result${items.length === 1 ? "" : "s"}`}</p>}
              <div className="grid">{shown.map((c) => <PosterCard key={`${c.type}-${c.id}`} card={c} showType />)}</div>
              {res.hasNextPage && (
                <div className="search-more">
                  <Button onClick={() => res.fetchNextPage()} loading={res.isFetchingNextPage}>Show more results</Button>
                </div>
              )}
              {res.isFetchNextPageError && <p className="search-count" role="alert">Couldn't load more results. Try again.</p>}
            </>
          )}
        </>
      )}
    </div>
  );
}

function SearchStart() {
  const recent = useRecent();
  const { data: rows } = useHome();
  const trending = rows?.find((r) => r.items.length)?.items.slice(0, 12) ?? [];
  return (
    <div className="search-start">
      {recent.length > 0 && (
        <section className="search-recent" aria-labelledby="recent-h">
          <div className="search-start-head">
            <h2 id="recent-h">Recent</h2>
            <Button variant="ghost" size="sm" onClick={clearRecent}>Clear</Button>
          </div>
          <ul className="search-list">
            {recent.map((r) => (
              <li key={r} className="search-list-row">
                <Link to={`/search?q=${encodeURIComponent(r)}`}><Clock size={18} aria-hidden="true" /><span>{r}</span></Link>
                <IconButton size="sm" label={`Remove ${r} from recent searches`} onClick={() => removeRecent(r)}><X size={16} /></IconButton>
              </li>
            ))}
          </ul>
        </section>
      )}
      {trending.length > 0 && (
        <section aria-labelledby="trend-h">
          <div className="search-start-head"><h2 id="trend-h">Trending this week</h2></div>
          <div className="grid">{trending.map((c) => <PosterCard key={`${c.type}-${c.id}`} card={c} showType />)}</div>
        </section>
      )}
      <nav className="search-browse" aria-label="Browse">
        <span>Browse</span>
        {BROWSE.map((b) => <Link key={b.to} to={b.to}>{b.label}</Link>)}
      </nav>
    </div>
  );
}
