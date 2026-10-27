import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type SkipTimes } from "../lib/api";
import { useSeason, useTitle } from "../lib/queries";
import { EmbedFrame, VideoPlayer, type NextEpisode } from "../components/Player";
import EpisodesPanel, { EpisodeRows, SeasonPicker, type Ep } from "../components/player/EpisodesPanel";
import ChangeSourceView, { audioOf } from "../components/player/ChangeSourceView";
import Row from "../components/Row";
import PosterCard from "../components/PosterCard";
import { getHistoryEntry, isFav, putHistory, toggleFav, useStore } from "../lib/store";
import { updateSettings, useSettings } from "../lib/settings";
import { qualityLabel, useSources, type SourceLink } from "../lib/useSources";
import { useDocTitle } from "../lib/useDocTitle";
import { formatRuntime } from "../lib/format";
import { useAmbient } from "../lib/img";
import { Button, Panel, Skeleton, SkeletonText, SourceStatus, StateMessage, Toaster, toast, type SourceState } from "../components/ui";
import { Bookmark, Check, ChevronLeft, RotateCcw, SkipForward } from "../components/icons";
import "../styles/player.css";
import "../styles/watch.css";

const onlineSub = (f: () => void) => { addEventListener("online", f); addEventListener("offline", f); return () => { removeEventListener("online", f); removeEventListener("offline", f); }; };
const fmtDate = (d?: string) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
// Phone landscape: the player is the page, so ☰ opens the in-player panel there too.
const PHONE_LANDSCAPE = "(orientation: landscape) and (max-height: 500px)";
const langName = (code?: string) => { try { return code ? new Intl.DisplayNames(["en"], { type: "language" }).of(code) : undefined; } catch { return undefined; } };

export default function Watch() {
  const fromStart = useSearchParams()[0].get("from") === "start";
  const { type, id, season, episode } = useParams();
  const nav = useNavigate();
  const ttype = (type as "movie" | "tv") ?? "movie";
  const isTv = ttype === "tv";
  const seasonN = season ? Number(season) : isTv ? 1 : undefined;
  const episodeN = episode ? Number(episode) : isTv ? 1 : undefined;

  const urlId = Number(id);
  const badId = !Number.isFinite(urlId) || urlId === 0;   // negative = AniList id, valid
  const { data, isPending, isError, error, refetch } = useTitle(ttype, urlId);
  // Anime cards link with a negative AniList id; /title answers with the real TMDB id. Every
  // key from here on (season, sources, history, URLs) uses that.
  const tid = data?.id ?? urlId;
  useStore();
  const settings = useSettings();
  const online = useSyncExternalStore(onlineSub, () => navigator.onLine);
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const [panel, setPanel] = useState<null | "episodes" | "source">(null);
  const [skips, setSkips] = useState<SkipTimes | null>(null);
  const [playH, setPlayH] = useState(0);          // what the player actually shows (ABR)
  const [videoPlaying, setVideoPlaying] = useState(false);
  const timeRef = useRef(0);

  const seasons = useMemo(() => data?.seasons ?? [], [data]);
  const isAnime = !!data?.classification?.isAnime;
  const kind = isAnime ? "anime" : data?.classification?.isAsian ? "asian" : isTv ? "series" : "movie";
  const src = data?.metaSource;
  const { data: seasonData } = useSeason(tid, isTv ? seasonN ?? null : null, !!data && isTv, src);
  const eps = (seasonData?.episodes ?? []) as Ep[];
  const ep = eps.find((e) => e.episodeNumber === episodeN);
  const unaired = !!ep?.airDate && new Date(`${ep.airDate}T00:00:00`).getTime() > Date.now();

  const sources = useSources({
    type: ttype, id: tid, season: seasonN, episode: episodeN, src, kind, enabled: !!data && !unaired,
    // unset = the title's original language + English (anime: Sub/Dub decides instead)
    audio: settings.audioLanguages.length ? settings.audioLanguages
      : isAnime ? [] : [...new Set([langName(data?.originalLanguage), "English"].filter((x): x is string => !!x))],
    onSwitched: (from, played, to) => toast(`${sources.name(from)} ${played ? "stopped working" : "didn’t start"}. Switched to ${label(to)}.`, { action: { label: "Change", onClick: () => setPanel("source") } }),
  });
  const label = (l: SourceLink) => [sources.name(l), qualityLabel(l.quality)].filter(Boolean).join(" · ");
  const { phase, current } = sources;

  const epCode = isTv ? `S${seasonN} · E${episodeN}` : "";
  const epLine = isTv ? [epCode, ep?.name].filter(Boolean).join(" · ") : "";
  useAmbient(data?.backdropUrl, 0.5);
  useDocTitle(data ? `${data.title}${isTv ? ` S${seasonN}E${episodeN}` : ""}` : null);

  // fresh stage per episode
  useEffect(() => { timeRef.current = 0; setPanel(null); }, [tid, seasonN, episodeN]);
  useEffect(() => { setPlayH(0); setVideoPlaying(false); }, [current?.url]);
  // Page chrome (header, tab bar) hides off this, not :has() (Firefox ESR drops those rules).
  useEffect(() => {
    document.documentElement.dataset.page = "watch";
    return () => { delete document.documentElement.dataset.page; };
  }, []);

  // "Still looking: checked 14 of 36 servers" only after 4 s of looking
  const [slow, setSlow] = useState(false);
  useEffect(() => { setSlow(false); if (phase !== "finding") return; const t = window.setTimeout(() => setSlow(true), 4000); return () => window.clearTimeout(t); }, [phase, tid, seasonN, episodeN]);
  // the "Switching…" pill shows for at most 3 s
  const [pill, setPill] = useState(false);
  useEffect(() => { setPill(phase === "switching"); if (phase !== "switching") return; const t = window.setTimeout(() => setPill(false), 3000); return () => window.clearTimeout(t); }, [phase, current?.url]);

  // AniSkip OP/ED intervals for the current anime episode.
  useEffect(() => {
    setSkips(null);
    if (!isAnime || !isTv || !episodeN) return;
    let alive = true;
    api.skipTimes(ttype, tid, episodeN, seasonN, 0, src).then((s) => alive && setSkips(s)).catch(() => {});
    return () => { alive = false; };
  }, [isAnime, isTv, ttype, tid, seasonN, episodeN, src]);

  // Next episode (rolls into the next season).
  const nextEp = useMemo<NextEpisode | null | undefined>(() => {
    if (!isTv || seasonN == null || episodeN == null) return undefined;
    const idx = seasons.findIndex((s) => s.seasonNumber === seasonN);
    const count = seasons[idx]?.episodeCount ?? 0;
    const go = (s: number, e: number) => () => nav(`/watch/tv/${tid}/${s}/${e}`);
    if (count && episodeN < count) {
      const n = eps.find((e) => e.episodeNumber === episodeN + 1);
      return { label: [`E${episodeN + 1}`, n?.name].filter(Boolean).join(" · "), still: n?.stillUrl, go: go(seasonN, episodeN + 1) };
    }
    const ns = seasons[idx + 1];
    return ns ? { label: `S${ns.seasonNumber} · E1`, go: go(ns.seasonNumber, 1) } : null;
  }, [isTv, seasons, seasonN, episodeN, eps, tid, nav]);

  // Record "started" as soon as a source is picked, so even a few seconds (or an embed,
  // which can't report progress) shows in history; real progress overwrites it.
  useEffect(() => {
    if (!data || !current || getHistoryEntry(ttype, tid, seasonN, episodeN)) return;
    putHistory({ id: tid, type: ttype, title: data.title, posterUrl: data.posterUrl, backdropUrl: data.backdropUrl, season: seasonN, episode: episodeN, position: 0, duration: 0, provider: sources.name(current), sourceType: current.type });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, data, ttype, tid, seasonN, episodeN]);

  // Esc / TV Back: open panels close first (they handle it), then fullscreen, then leave.
  const back = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (((window.history.state as { idx?: number } | null)?.idx ?? 0) > 0) nav(-1);
    else nav(`/title/${ttype}/${tid}`);
  };
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isBack = e.key === "Escape" || e.key === "BrowserBack" || e.key === "GoBack" || e.keyCode === 461 || e.keyCode === 10009 || e.key === "Backspace";
      if (!isBack || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || document.fullscreenElement) return;
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (document.querySelector(".panel-root, .menu, [role='dialog'], dialog[open], .upnext")) return;
      e.preventDefault();
      backRef.current();
    };
    window.addEventListener("keydown", onKey, true);   // capture: before app-level handlers
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Rail = player height (desktop): the stage drives --stage-h.
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!stage) return;
    const ro = new ResizeObserver(() => grid.current?.style.setProperty("--stage-h", `${stage.offsetHeight}px`));
    ro.observe(stage);
    return () => ro.disconnect();
  }, [stage]);

  const [railSeason, setRailSeason] = useState(seasonN ?? 1);
  useEffect(() => { if (seasonN != null) setRailSeason(seasonN); }, [seasonN]);

  if (badId) {
    return (
      <div className="watch-page container">
        <StateMessage kind="notFound" title="This title doesn’t exist." body="The link may be broken."
          actions={<Button variant="solid" onClick={() => nav("/")}>Go home</Button>} />
      </div>
    );
  }
  if (isPending) {
    return (
      <div className="watch-page" aria-busy="true">
        <div className="watch-grid">
          <div className="watch-main"><div className="watch-stage-slot"><Skeleton className="watch-stage" radius="var(--radius-xl)" /></div><div className="watch-info"><SkeletonText lines={3} width="60%" /></div></div>
        </div>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="watch-page container">
        <StateMessage kind={(error as { status?: number })?.status === 404 ? "notFound" : "error"}
          title={(error as Error)?.message || "Couldn’t load this title."}
          body="Check your connection and try again."
          actions={<><Button variant="solid" icon={<RotateCcw size={18} />} onClick={() => refetch()}>Try again</Button><Button variant="ghost" onClick={() => nav(-1)}>Go back</Button></>} />
      </div>
    );
  }

  const record = (position: number, duration: number) => {
    if (!current) return;
    putHistory({ id: tid, type: ttype, title: data.title, posterUrl: data.posterUrl, backdropUrl: data.backdropUrl, season: seasonN, episode: episodeN, position, duration, provider: sources.name(current), sourceType: current.type });
  };
  const resumeAt = timeRef.current > 5 ? timeRef.current : fromStart ? 0 : getHistoryEntry(ttype, tid, seasonN, episodeN)?.position || 0;
  const still = ep?.stillUrl || data.backdropUrl;
  const anime = isAnime;
  const audioFact = current ? audioOf(current, undefined, anime) : "";
  const srcLang = current ? (current.audio && !/multi|dual/i.test(current.audio) ? current.audio : current.audioTracks?.length === 1 ? current.audioTracks[0].label : "") : "";
  const curLabel = current ? label(current) : "";
  const changeSource = () => setPanel("source");
  // ☰: windowed, the page already lists the episodes; only fullscreen / phone landscape
  // (where the player is the whole screen) gets the in-player panel.
  const showEpisodes = () => {
    if (document.fullscreenElement || matchMedia(PHONE_LANDSCAPE).matches) { setPanel("episodes"); return; }
    if (seasonN != null) setRailSeason(seasonN);
    const rail = document.querySelector<HTMLElement>(".watch-rail");
    const row = rail?.querySelector<HTMLElement>(".epi[data-current] .epi-hit") ?? rail?.querySelector<HTMLElement>(".epi-hit");
    (row ?? rail)?.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    row?.focus({ preventScroll: true });
  };
  const what = isTv ? epCode : "this movie";

  // ── the stage ──
  let stageBody: ReactNode;
  if (current && current.type === "iframe") {
    stageBody = <EmbedFrame source={{ title: data.title, url: current.url, type: "iframe" }} onLoad={sources.onFirstFrame} />;
  } else if (current && online) {
    stageBody = (
      <VideoPlayer
        key={current.url}
        source={{ title: data.title, url: current.url, type: current.type, provider: sources.name(current), subtitles: sources.playing?.subtitles }}
        title={data.title} subtitle={epLine || undefined} poster={still}
        startingLabel={phase === "switching" ? undefined : `Starting ${curLabel}`}
        resumeAt={resumeAt} timeRef={timeRef} onProgress={record}
        onFirstFrame={sources.onFirstFrame}
        onFail={(reason) => sources.onBroken("failed", reason)}
        onStall={() => sources.onBroken("stalled", "stall > 12s")}
        skips={isAnime ? skips : null} next={nextEp}
        onEpisodes={isTv && seasons.length ? showEpisodes : undefined}
        onHeight={setPlayH} onPlayingChange={setVideoPlaying} audioLang={srcLang || "Original"}
        onBack={back} stage={stage} hold={panel != null}
        sourceLabel={curLabel}
        renderSource={(close) => <ChangeSourceView sources={sources} anime={anime} onPicked={close} />}
      />
    );
  } else {
    let msg: ReactNode = null;
    if (!online) {
      msg = <StateMessage kind="offline" align="center" title="You’re offline." body="Playback will resume when you’re back online." actions={<Button variant="media" onClick={() => location.reload()}>Try again</Button>} />;
    } else if (unaired) {
      msg = <StateMessage kind="empty" align="center" title={`This episode airs ${fmtDate(ep?.airDate)}.`} actions={<Button variant="media" onClick={showEpisodes}>Back to episodes</Button>} />;
    } else if (phase === "failed") {
      msg = <StateMessage kind="error" align="center" title={`Couldn’t play ${what}`} body="The streams we tried didn’t start. Others may still work."
        actions={<><Button variant="solid" onClick={changeSource}>Choose a source</Button><Button variant="media" onClick={sources.rescan}>Try again</Button></>} />;
    } else if (phase === "none") {
      const total = sources.progress.total;
      msg = <StateMessage kind="empty" align="center" title={`No streams found for ${what}`}
        body={total ? `None of the ${total} servers have it right now.` : "No server has it right now."}
        actions={<>
          <Button variant="solid" icon={<RotateCcw size={18} />} onClick={sources.rescan}>Search again</Button>
          {!settings.torrentMode && <Button variant="media" onClick={() => updateSettings({ torrentMode: true })}>Use torrent sources</Button>}
        </>} />;
    } else {
      msg = (
        <div className="stage-finding" role="status">
          <span className="vp-spinner" aria-hidden="true" />
          <p>{slow && sources.progress.total ? `Still looking: checked ${sources.progress.settled} of ${sources.progress.total} servers` : "Finding a stream…"}</p>
        </div>
      );
    }
    stageBody = (
      <div className="stage-idle">
        {still && <img src={still} alt="" />}
        <div className="stage-top">
          <button className="vp-btn" aria-label="Back" title="Back" onClick={back}><ChevronLeft size={24} /></button>
          <div className="vp-title"><span className="vp-title-1">{data.title}</span>{epLine && <span className="vp-title-2">{epLine}</span>}</div>
        </div>
        <div className="stage-msg">{msg}</div>
      </div>
    );
  }

  // a site's web player can't report frames: once chosen, it is what's playing
  const ssState: SourceState = !online ? "offline"
    : current?.type === "iframe" ? "web"
    : phase === "playing" ? "playing"
    : phase === "failed" || phase === "none" ? "failed"
    : phase === "switching" ? "switching" : phase === "starting" ? "starting" : "finding";

  const saved = isFav(ttype, tid);
  const card = { id: tid, type: ttype, title: data.title, posterUrl: data.posterUrl, backdropUrl: data.backdropUrl, year: data.year, voteAverage: data.voteAverage, overview: data.overview };
  const recs = data.recommendations ?? [];
  const meta = isTv ? [formatRuntime(ep?.runtime), ep?.airDate && `Aired ${fmtDate(ep.airDate)}`] : [data.year, formatRuntime(data.runtime)];

  return (
    <div className="watch-page">
      <div className="watch-grid" ref={grid}>
        <div className="watch-main">
          <div className="watch-stage-slot">
            <div ref={setStage} className="watch-stage media-dark">
              {stageBody}
              {pill && <div className="stage-pill" role="status">Switching to a working stream…</div>}
              <Toaster placement="top" />
            </div>
          </div>

          <div className="watch-info">
            {!unaired && (
              <SourceStatus state={ssState} provider={current ? sources.name(current) : undefined}
                quality={current ? qualityLabel(playH || current.quality) || undefined : undefined} audio={audioFact || undefined}
                checked={slow ? sources.progress.settled : undefined} total={slow ? sources.progress.total : undefined}
                onChangeSource={changeSource} />
            )}
            <div className="watch-head">
              <h1 className="watch-title"><Link to={`/title/${ttype}/${tid}`}>{data.title}</Link></h1>
              {isTv && <h2 className="watch-ep">{epLine}</h2>}
              <div className="meta-line">{meta.filter(Boolean).map((m) => <span key={String(m)}>{m}</span>)}</div>
              {(isTv ? ep?.overview : data.overview) && <p className="watch-synopsis">{isTv ? ep?.overview : data.overview}</p>}
            </div>
            <div className="watch-actions">
              {nextEp && <Button variant="secondary" className="watch-next" icon={<SkipForward size={18} />} onClick={nextEp.go}>Next: {nextEp.label}</Button>}
              <Button variant="ghost" icon={saved ? <Check size={18} /> : <Bookmark size={18} />} aria-pressed={saved} onClick={() => toggleFav(card)}>{saved ? "In My List" : "My List"}</Button>
            </div>
          </div>
        </div>

        <aside className="watch-rail" aria-label={isTv ? "Episodes" : "More like this"}>
          {isTv && seasons.length > 0 ? (
            <>
              <div className="rail-head">
                <h2>Episodes</h2>
                <SeasonPicker seasons={seasons} value={railSeason} onChange={setRailSeason} />
              </div>
              <div className="rail-scroll" data-episodes-scroll="">
                <EpisodeRows showId={tid} season={railSeason} src={src} current={{ season: seasonN!, episode: episodeN! }} playing={videoPlaying} />
              </div>
            </>
          ) : recs.length > 0 && (
            <>
              <div className="rail-head"><h2>More like this</h2></div>
              <ul className="rail-scroll rail-recs" data-episodes-scroll="">
                {recs.slice(0, 12).map((c) => (
                  <li key={`${c.type}-${c.id}`}>
                    <Link to={`/title/${c.type}/${c.id}`} className="rec">
                      <span className="rec-art">{c.backdropUrl ? <img src={c.backdropUrl} alt="" loading="lazy" /> : null}</span>
                      <span className="rec-text"><span className="rec-title">{c.title}</span>{c.year && <span className="rec-year">{c.year}</span>}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>

      {isTv && recs.length > 0 && (
        <div className="watch-more">
          <Row title="More like this" className="wide">{recs.map((c) => <PosterCard key={`${c.type}-${c.id}`} card={c} wide />)}</Row>
        </div>
      )}

      {isTv && seasonN != null && episodeN != null && (
        <EpisodesPanel open={panel === "episodes"} onClose={() => setPanel(null)} container={stage}
          showId={tid} showTitle={data.title} seasons={seasons} src={src} season={seasonN} episode={episodeN} playing={videoPlaying} />
      )}
      <Panel open={panel === "source"} onClose={() => setPanel(null)} container={stage} scrim={false} title="Change source">
        <ChangeSourceView sources={sources} anime={anime} onPicked={() => setPanel(null)} />
      </Panel>
    </div>
  );
}
