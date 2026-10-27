import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTitle, useSeason } from "../lib/queries";
import { useSettings } from "../lib/settings";
import type { Card, Episode, TitleDetail } from "../lib/types";
import { getHistoryEntry, isFav, useStore, watchHref } from "../lib/store";
import { tmdbSrcSet, useAmbient } from "../lib/img";
import { useDocTitle } from "../lib/useDocTitle";
import PosterCard from "../components/PosterCard";
import Row from "../components/Row";
import TrailerModal from "../components/TrailerModal";
import { playAction, toggleMyList, type PlayAction } from "../components/playAction";
import { formatRuntime } from "../lib/format";
import { Button, EpisodeList, EpisodeListItem, EpisodeListSkeleton, IconButton, Menu, Skeleton, SkeletonText, StateMessage, Tabs } from "../components/ui";
import { Check, ChevronDown, ChevronLeft, Film, Play, Plus, RotateCcw, Star } from "../components/icons";
import "../styles/title.css";

const RANGE = 50;   // long (anime) seasons are paged in blocks of 50 episodes
/** Anime plans can carry raw cour labels ("restart"): sentence-case them. */
const seasonName = (n: string) => n.charAt(0).toUpperCase() + n.slice(1);

/** Season to open: deep-linked cour (?al=) → last viewed this session → the one being watched → first real season. */
function defaultSeason(data: TitleDetail, al: number, watching?: number): number | null {
  const s = data.seasons;
  const remembered = Number(sessionStorage.getItem(`sp.season.${data.id}`) ?? NaN);
  return (s.find((x) => al && x.anilistId === al)
    ?? s.find((x) => x.seasonNumber === remembered)
    ?? s.find((x) => x.seasonNumber === watching)
    ?? s.find((x) => x.seasonNumber > 0) ?? s[0])?.seasonNumber ?? null;
}

export default function Title() {
  const { type, id } = useParams<{ type: "movie" | "tv"; id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { lang, adult } = useSettings();
  const [params] = useSearchParams();
  const urlId = Number(id);
  const ttype = type === "tv" ? "tv" : "movie";
  useStore();   // re-render on history / My List changes (incl. other synced devices)

  const { data, isPending, isError, error, refetch, isFetching } = useTitle(ttype, urlId);
  useDocTitle(data?.title);
  useAmbient(data?.backdropUrl);

  // Anime cards link by AniList id (negative). The server resolved it: move to the canonical
  // TMDB URL (keeping the cour) without refetching, so history/watch links all use data.id.
  useEffect(() => {
    if (!data || data.id === urlId) return;
    qc.setQueryData(["title", data.type, data.id, lang, adult], data);   // = useTitle's key
    nav(`/title/${data.type}/${data.id}${data.anilistId ? `?al=${data.anilistId}` : ""}`, { replace: true });
  }, [data, urlId, qc, nav, lang, adult]);

  const al = Number(params.get("al")) || data?.anilistId || 0;
  const [season, setSeason] = useState<number | null>(null);
  // Nothing watched yet: Play starts the season the page shows (e.g. the mapped anime cour), not season 1.
  const act = data ? playAction(data.type, data.id, data.seasons, season ?? defaultSeason(data, al)) : null;
  useEffect(() => {
    if (data) setSeason(defaultSeason(data, al, act?.season));
    // only when the title changes, not on every history tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.id, data?.seasons.length, al]);
  const pickSeason = (n: number) => { setSeason(n); if (data) sessionStorage.setItem(`sp.season.${data.id}`, String(n)); };

  const isTv = data?.type === "tv" && data.seasons.length > 0;
  const seasonQ = useSeason(data?.id ?? 0, season, !!isTv && !!data, data?.metaSource);

  const badId = !Number.isInteger(urlId) || urlId === 0;   // negative ids are valid (anime)
  if (!badId && (isPending || (data && data.id !== urlId))) return <TitleSkeleton />;
  if (badId || isError || !data || !act) {
    const gone = badId || /\b404\b|not.?found|isn't available/i.test(String(error)) || (error as { status?: number } | null)?.status === 404;
    return (
      <div className="container title-state">
        {gone
          ? <StateMessage kind="notFound" title="This title isn't available anymore." body="It may have been removed from the catalogue."
              actions={<><Button variant="solid" onClick={() => nav(-1)}>Go back</Button><Button variant="ghost" to="/search">Search</Button></>} />
          : <StateMessage kind="error" title="Couldn't load this title." body="Check your connection and try again." details={error ? String(error) : undefined}
              actions={<><Button variant="solid" onClick={() => refetch()} loading={isFetching}>Try again</Button><Button variant="ghost" onClick={() => nav(-1)}>Go back</Button></>} />}
      </div>
    );
  }

  const episodes = isTv && seasonQ.data?.seasonNumber === season ? seasonQ.data.episodes : null;
  return <TitleView data={data} act={act} season={season} pickSeason={pickSeason} episodes={episodes}
    seasonError={seasonQ.isError} retrySeason={() => seasonQ.refetch()} />;
}

function TitleView({ data, act, season, pickSeason, episodes, seasonError, retrySeason }: {
  data: TitleDetail; act: PlayAction; season: number | null; pickSeason: (n: number) => void;
  episodes: Episode[] | null; seasonError: boolean; retrySeason: () => void;
}) {
  const nav = useNavigate();
  const [trailer, setTrailer] = useState(false);
  const [more, setMore] = useState(false);
  const [ctaShown, setCtaShown] = useState(false);
  const primaryRef = useRef<HTMLDivElement>(null);
  const isTv = data.type === "tv" && data.seasons.length > 0;
  const saved = isFav(data.type, data.id);
  const card: Card = { id: data.id, type: data.type, title: data.title, posterUrl: data.posterUrl, backdropUrl: data.backdropUrl, year: data.year, voteAverage: data.voteAverage, overview: data.overview };
  const realSeasons = data.seasons.filter((s) => s.seasonNumber > 0).length || data.seasons.length;
  const kind = data.classification.isAnime ? "Anime" : data.type === "tv" ? "Series" : "Movie";
  const hasTrailer = data.trailerKeys.length > 0;
  const resuming = !!act.restart;

  // Phones: once the primary button scrolls away, a Play bar stays above the tab bar.
  useEffect(() => {
    const el = primaryRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setCtaShown(!e.isIntersecting && e.boundingClientRect.top < 0));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const primary = (
    <Button variant="primary" size="lg" to={act.to} icon={<Play size={20} fill="currentColor" />} meta={act.meta} className="title-play">{act.label}</Button>
  );
  const listBtn = (
    <Button variant="media" size="lg" aria-pressed={saved} icon={saved ? <Check size={20} /> : <Plus size={20} />} onClick={() => toggleMyList(card)}>My List</Button>
  );
  const trailerBtn = hasTrailer && <Button variant="media" size="lg" icon={<Film size={20} />} onClick={() => setTrailer(true)}>Trailer</Button>;
  const back = () => (history.state?.idx > 0 ? nav(-1) : nav("/"));

  return (
    <div className="title-page" data-kind={data.type}>
      <section className="title-hero media-dark" aria-labelledby="title-h">
        {data.backdropUrl
          ? <img className="title-bg" src={data.backdropUrl} srcSet={tmdbSrcSet(data.backdropUrl, [780, 1280])} sizes="100vw" alt="" fetchPriority="high" />
          : <div className="title-bg" />}
        <div className="title-scrim" />
        <IconButton variant="media" label="Back" className="title-back" onClick={back}><ChevronLeft size={22} /></IconButton>

        <div className="title-hero-inner">
          <div className="title-main">
            <p className="title-kind">{kind}</p>
            <h1 id="title-h" className="title-name">{data.title}</h1>
            <p className="meta-line title-meta">
              {data.year && <span>{data.year}</span>}
              {data.type === "tv"
                ? <span>{realSeasons} season{realSeasons === 1 ? "" : "s"}</span>
                : data.runtime ? <span>{formatRuntime(data.runtime)}</span> : null}
              {data.voteAverage ? <span className="rating"><Star size={14} fill="currentColor" aria-hidden="true" /><span className="sr-only">Rated </span>{data.voteAverage.toFixed(1)}</span> : null}
              {data.genres.length > 0 && <span className="title-genres">{data.genres.slice(0, 2).join(", ")}</span>}
            </p>

            <div className="title-actions" data-count={1 + (hasTrailer ? 1 : 0) + (resuming ? 1 : 0)}>
              <div ref={primaryRef} className="title-primary">{primary}</div>
              <div className="title-secondary">
                {listBtn}
                {trailerBtn}
                {resuming && <Button variant="media" size="lg" icon={<RotateCcw size={20} />} to={act.restart} className="title-restart-tile">Start over</Button>}
              </div>
            </div>
            {resuming && <Link to={act.restart!} className="btn btn-link title-restart">Start over</Link>}

            {data.overview && (
              <div className="title-plot-wrap">
                <p id="title-plot" className="title-plot" data-open={more ? "" : undefined}>{data.overview}</p>
                {data.overview.length > 180 && (
                  <button type="button" className="btn btn-link title-more" aria-expanded={more} aria-controls="title-plot" onClick={() => setMore((v) => !v)}>
                    {more ? "Show less" : "Read more"}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Cast only: an "Up next" column here repeated the Episodes list right below */}
          {data.cast.length > 0 && <aside className="title-side"><Cast data={data} max={8} /></aside>}
        </div>
      </section>

      <div className="container title-below">
        {data.cast.length > 0 && <div className="title-cast-stacked"><Cast data={data} /></div>}

        {isTv && (
          <Episodes data={data} season={season} pickSeason={pickSeason} episodes={episodes} act={act} error={seasonError} retry={retrySeason} />
        )}

        {data.recommendations.length > 0 && (
          <Row title="More like this" kind="wide">
            {data.recommendations.map((c) => <PosterCard key={`${c.type}-${c.id}`} card={c} wide />)}
          </Row>
        )}

        <About data={data} kind={kind} />
      </div>

      <div className="title-cta" data-shown={ctaShown ? "" : undefined} inert={!ctaShown} aria-hidden={!ctaShown || undefined}>{primary}</div>
      {trailer && <TrailerModal title={`${data.title}: trailer`} youtubeKey={data.trailerKeys[0]} onClose={() => setTrailer(false)} />}
    </div>
  );
}

function Cast({ data, max }: { data: TitleDetail; max?: number }) {
  return (
    <section className="title-cast" aria-label="Cast">
      <h2 className="title-side-h">Cast</h2>
      <ul className="cast-track">
        {data.cast.slice(0, max).map((c, i) => (
          <li className="cast-card" key={i}>
            {c.profileUrl
              ? <img src={c.profileUrl} width={64} height={64} alt="" loading="lazy" decoding="async" />
              : <span className="cast-ph" aria-hidden="true">{c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("")}</span>}
            <span className="cast-name" title={c.name}>{c.name}</span>
            {c.character && <span className="cast-role" title={c.character}>{c.character}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Episodes({ data, season, pickSeason, episodes, act, error, retry }: {
  data: TitleDetail; season: number | null; pickSeason: (n: number) => void; episodes: Episode[] | null;
  act: PlayAction; error: boolean; retry: () => void;
}) {
  const cur = data.seasons.find((s) => s.seasonNumber === season);
  const [range, setRange] = useState(0);
  // open the block of 50 that holds the resume episode
  useEffect(() => {
    setRange(act.season === season && act.episode ? Math.floor((act.episode - 1) / RANGE) : 0);
  }, [season, act.season, act.episode]);
  const blocks = episodes && episodes.length > RANGE ? Math.ceil(episodes.length / RANGE) : 0;
  const shown = episodes && blocks ? episodes.slice(range * RANGE, range * RANGE + RANGE) : episodes;
  const rangeLabel = (b: number) => episodes ? `Episodes ${episodes[b * RANGE]?.episodeNumber}–${episodes[Math.min(episodes.length, (b + 1) * RANGE) - 1]?.episodeNumber}` : "";

  return (
    <section className="title-episodes" aria-labelledby="eps-h">
      <div className="title-section-head">
        <h2 id="eps-h">Episodes</h2>
        {data.seasons.length > 6 && (
          <Menu label="Season" items={data.seasons.map((s) => ({ label: seasonName(s.name), checked: s.seasonNumber === season, meta: s.episodeCount ? `${s.episodeCount}` : undefined, onSelect: () => pickSeason(s.seasonNumber) }))}
            trigger={(p) => <Button {...p} variant="secondary">{cur ? seasonName(cur.name) : "Season"} <ChevronDown size={16} aria-hidden="true" /></Button>} />
        )}
        {blocks > 0 && (
          <Menu label="Episode range" items={Array.from({ length: blocks }, (_, b) => ({ label: rangeLabel(b), checked: b === range, onSelect: () => setRange(b) }))}
            trigger={(p) => <Button {...p} variant="ghost">{rangeLabel(range)} <ChevronDown size={16} aria-hidden="true" /></Button>} />
        )}
      </div>
      {data.seasons.length > 1 && data.seasons.length <= 6 && (
        <Tabs id="season" label="Season" value={String(season ?? "")} onChange={(v) => pickSeason(Number(v))}
          items={data.seasons.map((s) => ({ value: String(s.seasonNumber), label: seasonName(s.name) }))} className="title-season-tabs" />
      )}
      <div role={data.seasons.length > 1 && data.seasons.length <= 6 ? "tabpanel" : undefined} aria-labelledby={data.seasons.length > 1 && data.seasons.length <= 6 ? `season-tab-${season}` : undefined}>
        {error ? (
          <StateMessage kind="error" title="Couldn't load this season's episodes." body="Check your connection and try again."
            actions={<Button variant="solid" onClick={retry}>Try again</Button>} />
        ) : !shown ? (
          <EpisodeListSkeleton rows={6} size="page" />
        ) : shown.length === 0 ? (
          <StateMessage kind="empty" title="Episode list isn't available for this season." />
        ) : (
          <EpisodeList label={cur ? seasonName(cur.name) : "Episodes"}>
            {shown.map((e) => {
              const h = getHistoryEntry("tv", data.id, e.seasonNumber, e.episodeNumber);
              const progress = h && h.duration > 0 ? h.position / h.duration : 0;
              const isCur = act.from !== "start" && act.season === e.seasonNumber && act.episode === e.episodeNumber;
              return (
                <EpisodeListItem key={e.id} size="page" number={e.episodeNumber} title={e.name} still={e.stillUrl} runtime={e.runtime}
                  overview={e.overview} airDate={e.airDate} progress={progress} watched={progress >= 0.97}
                  current={isCur} currentLabel={isCur ? (act.from === "resume" ? "Continue" : "Up next") : undefined}
                  to={watchHref({ type: "tv", id: data.id, season: e.seasonNumber, episode: e.episodeNumber })} />
              );
            })}
          </EpisodeList>
        )}
      </div>
    </section>
  );
}

function About({ data, kind }: { data: TitleDetail; kind: string }) {
  const eps = data.seasons.filter((s) => s.seasonNumber > 0).reduce((n, s) => n + (s.episodeCount || 0), 0);
  const rows: [string, ReactNode][] = [
    ["Genres", data.genres.join(", ")],
    ["Starring", data.cast.slice(0, 3).map((c) => c.name).join(", ")],
    ["Type", kind],
    [data.type === "tv" ? "Episodes" : "Runtime", data.type === "tv" ? (eps ? `${eps}` : "") : formatRuntime(data.runtime)],
    ["Released", data.year ?? ""],
    ["Rating", data.voteAverage ? `${data.voteAverage.toFixed(1)} out of 10 on TMDB` : ""],
    ["IMDb", data.imdbId ? <a href={`https://www.imdb.com/title/${data.imdbId}/`} target="_blank" rel="noreferrer">View on IMDb</a> : ""],
  ];
  return (
    <section className="title-about" aria-labelledby="about-h">
      <h2 id="about-h">About</h2>
      <dl>
        {rows.filter(([, v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </section>
  );
}

function TitleSkeleton() {
  return (
    <div className="title-page" aria-busy="true">
      <section className="title-hero media-dark">
        <div className="title-bg skeleton" />
        <div className="title-hero-inner">
          <div className="title-main">
            <Skeleton width="5rem" height="0.875rem" />
            <Skeleton width="min(26rem, 80%)" height="2.75rem" />
            <Skeleton width="14rem" height="1rem" />
            <div className="title-actions"><Skeleton width="13rem" height="3rem" /><Skeleton width="8rem" height="3rem" /></div>
            <SkeletonText lines={3} width="min(36rem, 100%)" />
          </div>
        </div>
      </section>
      <div className="container title-below"><EpisodeListSkeleton rows={6} size="page" /></div>
    </div>
  );
}
