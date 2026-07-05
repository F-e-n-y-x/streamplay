import { useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type MouseEvent as RMouseEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type SkipTimes } from "../lib/api";
import type { TitleDetail } from "../lib/types";
import { EmbedFrame, VideoPlayer, type PlayerSource } from "../components/Player";
import SourcesPanel from "../components/SourcesPanel";
import { getHistoryEntry, putHistory } from "../lib/store";
import { useSettings, updateSettings } from "../lib/settings";
import { ChevronLeft, ChevronRight, Film, Play, Maximize, Sun, Zap, MonitorPlay, X } from "../components/icons";

export default function Watch() {
  const { type, id, season, episode } = useParams();
  const nav = useNavigate();
  const tid = Number(id);
  const ttype = (type as "movie" | "tv") ?? "movie";
  const seasonN = season ? Number(season) : ttype === "tv" ? 1 : undefined;
  const episodeN = episode ? Number(episode) : ttype === "tv" ? 1 : undefined;

  const [data, setData] = useState<TitleDetail | null | undefined>(undefined);
  const [current, setCurrent] = useState<PlayerSource | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // Bumped on every playback failure so re-selecting the SAME dead source still
  // re-triggers the "advance to next source" effect (a plain string wouldn't change).
  const [failSeq, setFailSeq] = useState(0);
  const [skips, setSkips] = useState<SkipTimes | null>(null);
  const [lightsOff, setLightsOff] = useState(false);
  const [theater, setTheater] = useState(false);
  // Floating mini-player: when a source is playing and the player scrolls out of view,
  // it shrinks into a corner so you can keep watching while browsing episodes/sources.
  const [mini, setMini] = useState(false);
  // The user can CLOSE the floating mini-player; it stays closed until the main player
  // scrolls back into view (then re-arms), so it doesn't immediately pop back.
  const [miniClosed, setMiniClosed] = useState(false);
  const showMini = mini && !miniClosed;
  const stageRef = useRef<HTMLDivElement>(null);       // the slot (observed for scroll)
  const stageInnerRef = useRef<HTMLDivElement>(null);  // the stage box (moved when mini)
  const [miniPos, setMiniPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const settings = useSettings();

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !current) { setMini(false); return; }
    const io = new IntersectionObserver(([e]) => setMini(!e.isIntersecting), { threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, [current]);
  // reset the mini position + re-arm the close each time the player re-docks (scrolls back in)
  useEffect(() => { if (!mini) { setMiniPos(null); setMiniClosed(false); } }, [mini]);

  // ── Drag the mini-player around (pointer = mouse + touch). A move past a small
  // threshold flags `moved` so the trailing click doesn't toggle play/pause. ──
  const onMiniDown = (e: RPointerEvent) => {
    if (!showMini || (e.target as HTMLElement).closest(".mini-restore, .mini-close")) return;
    const el = stageInnerRef.current; if (!el) return;
    const r = el.getBoundingClientRect();
    drag.current = { sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
    el.setPointerCapture?.(e.pointerId);
  };
  const onMiniMove = (e: RPointerEvent) => {
    const d = drag.current, el = stageInnerRef.current; if (!d || !el) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) d.moved = true;
    if (!d.moved) return;
    const w = el.offsetWidth, h = el.offsetHeight, pad = 6;
    const x = Math.max(pad, Math.min(d.ox + dx, window.innerWidth - w - pad));
    const y = Math.max(pad, Math.min(d.oy + dy, window.innerHeight - h - pad));
    setMiniPos({ x, y });
  };
  const onMiniUp = (e: RPointerEvent) => {
    stageInnerRef.current?.releasePointerCapture?.(e.pointerId);
    justDragged.current = !!drag.current?.moved;   // remember for the trailing click
    drag.current = null;
  };
  const onMiniClickCapture = (e: RMouseEvent) => {
    if (justDragged.current) { e.stopPropagation(); justDragged.current = false; }  // swallow post-drag click
  };

  useEffect(() => {
    let alive = true;
    setData(undefined); setCurrent(null); setFailedUrl(null);
    api.title(ttype, tid).then((d) => alive && setData(d)).catch(() => alive && setData(null));
    return () => { alive = false; };
  }, [ttype, tid]);

  // reset the player when the episode changes
  useEffect(() => { setCurrent(null); setFailedUrl(null); }, [seasonN, episodeN]);

  const seasons = data?.seasons ?? [];
  const isAnime = !!data?.classification?.isAnime;
  // Content kind for per-kind provider prefs + sticky provider.
  const kind = isAnime ? "anime" : data?.classification?.isAsian ? "asian" : ttype === "movie" ? "movie" : "series";
  const epContext = ttype === "tv" ? ` · S${seasonN}E${episodeN}` : "";

  // AniSkip OP/ED intervals for the current anime episode.
  useEffect(() => {
    setSkips(null);
    if (!isAnime || ttype !== "tv" || !episodeN) return;
    let alive = true;
    api.skipTimes(ttype, tid, episodeN, seasonN).then((s) => alive && setSkips(s)).catch(() => {});
    return () => { alive = false; };
  }, [isAnime, ttype, tid, seasonN, episodeN]);

  // Previous / next episode targets (roll across season boundaries).
  const epNav = useMemo(() => {
    if (ttype !== "tv" || seasonN == null || episodeN == null) return { prev: null as null | [number, number], next: null as null | [number, number] };
    const idx = seasons.findIndex((s) => s.seasonNumber === seasonN);
    const cur = seasons[idx];
    const count = cur?.episodeCount ?? 0;
    let next: [number, number] | null = null;
    if (count && episodeN < count) next = [seasonN, episodeN + 1];
    else if (seasons[idx + 1]) next = [seasons[idx + 1].seasonNumber, 1];
    let prev: [number, number] | null = null;
    if (episodeN > 1) prev = [seasonN, episodeN - 1];
    else if (seasons[idx - 1]) prev = [seasons[idx - 1].seasonNumber, Math.max(seasons[idx - 1].episodeCount || 1, 1)];
    return { prev, next };
  }, [ttype, seasons, seasonN, episodeN]);

  const goEp = (t: [number, number] | null) => { if (t) nav(`/watch/tv/${tid}/${t[0]}/${t[1]}`); };

  const stage = useMemo(() => {
    if (!current) {
      return (
        <div className="stage-idle">
          {data?.backdropUrl && <img src={data.backdropUrl} alt="" />}
          <div className="stage-idle-inner">
            <Play size={30} />
            <p>Select a source to start playing</p>
            <span className="subtle">Working providers appear with a green dot →</span>
          </div>
        </div>
      );
    }
    const resumeAt = data ? getHistoryEntry(ttype, tid, seasonN, episodeN)?.position || 0 : 0;
    const record = (position: number, duration: number) => {
      if (!data) return;
      putHistory({ id: tid, type: ttype, title: data.title, posterUrl: data.posterUrl, season: seasonN, episode: episodeN, position, duration, provider: current.provider, sourceType: current.type });
    };
    return current.type === "iframe"
      ? <EmbedFrame source={current} />
      : <VideoPlayer
          key={current.url}
          source={current}
          embedded
          onFail={() => { setFailedUrl(current.url); setFailSeq((s) => s + 1); }}
          resumeAt={resumeAt}
          onProgress={record}
          skips={isAnime ? skips : null}
          autoSkip={settings.autoSkip}
          onEndedNext={settings.autoNext ? () => goEp(epNav.next) : undefined}
        />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, data, ttype, tid, seasonN, episodeN, skips, isAnime, settings.autoSkip, settings.autoNext, epNav]);

  if (data === undefined) return <div className="container"><div className="empty">Loading…</div></div>;
  if (data === null) return <div className="container"><div className="empty">Couldn't load this title.</div></div>;

  return (
    <div className="container watch-page">
      <Link className="back-link" to={`/title/${ttype}/${tid}`}><ChevronLeft size={16} /> Back to details</Link>

      {lightsOff && <div className="lights-scrim" onClick={() => setLightsOff(false)} />}

      <div className={`watch-grid ${theater ? "theater" : ""} ${lightsOff ? "lit" : ""}`}>
        <div className="watch-main">
          {/* stage-slot reserves the 16:9 space so the page doesn't jump when the player
              detaches into the floating mini-player. */}
          <div className="watch-stage-slot" ref={stageRef}>
            <div
              ref={stageInnerRef}
              className={`watch-stage ${showMini ? "mini" : ""} ${showMini && miniPos ? "moved" : ""}`}
              style={showMini && miniPos ? { left: miniPos.x, top: miniPos.y, right: "auto", bottom: "auto" } : undefined}
              onPointerDown={onMiniDown}
              onPointerMove={onMiniMove}
              onPointerUp={onMiniUp}
              onClickCapture={onMiniClickCapture}
            >
              {stage}
              {showMini && (
                <>
                  {/* expand: jump back to the docked player at the top */}
                  <button className="mini-restore" aria-label="Back to player" title="Back to player" onClick={() => stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}><Maximize size={15} /></button>
                  {/* close: dismiss the floating mini-player (re-arms when you scroll back up) */}
                  <button className="mini-close" aria-label="Close mini player" title="Close" onClick={() => { setMiniClosed(true); setMiniPos(null); }}><X size={15} /></button>
                </>
              )}
            </div>
            {showMini && <div className="watch-stage-ph" aria-hidden />}
          </div>

          {/* Player control bar — episode nav + playback toggles (AniSkip for anime). */}
          <div className="player-bar">
            <button className="pbar-btn pbar-desktop" onClick={() => setTheater((v) => !v)} aria-pressed={theater} title="Theater mode"><Maximize size={15} /> <span>Theater</span></button>
            <button className={`pbar-btn ${settings.autoplay ? "on" : ""}`} onClick={() => updateSettings({ autoplay: !settings.autoplay })} aria-pressed={settings.autoplay} title="Autoplay the first source"><Play size={15} /> <span>Auto Play</span></button>
            {ttype === "tv" && (
              <button className={`pbar-btn ${settings.autoNext ? "on" : ""}`} onClick={() => updateSettings({ autoNext: !settings.autoNext })} aria-pressed={settings.autoNext} title="Play the next episode automatically"><MonitorPlay size={15} /> <span>Auto Next</span></button>
            )}
            {isAnime && (skips?.opening || skips?.ending) && (
              <button className={`pbar-btn ${settings.autoSkip ? "on" : ""}`} onClick={() => updateSettings({ autoSkip: !settings.autoSkip })} aria-pressed={settings.autoSkip} title="Skip openings/endings automatically (AniSkip)"><Zap size={15} /> <span>Auto Skip</span></button>
            )}
            <button className={`pbar-btn pbar-desktop ${lightsOff ? "on" : ""}`} onClick={() => setLightsOff((v) => !v)} aria-pressed={lightsOff} title="Dim the page"><Sun size={15} /> <span>Lights</span></button>
            <span className="pbar-grow" />
            {ttype === "tv" && (
              <>
                <button className="pbar-btn" disabled={!epNav.prev} onClick={() => goEp(epNav.prev)} title="Previous episode"><ChevronLeft size={15} /> <span>Prev</span></button>
                <button className="pbar-btn" disabled={!epNav.next} onClick={() => goEp(epNav.next)} title="Next episode"><span>Next</span> <ChevronRight size={15} /></button>
              </>
            )}
          </div>

        </div>

        <aside className="watch-rail">
          <SourcesPanel
            key={`${ttype}-${tid}-${seasonN ?? "m"}-${episodeN ?? "m"}`}
            type={ttype}
            id={tid}
            season={seasonN}
            episode={episodeN}
            isAnime={!!data.classification?.isAnime}
            kind={kind}
            onPlay={(s) => setCurrent(s)}
            currentUrl={current?.url ?? null}
            failedUrl={failedUrl}
            failSeq={failSeq}
          />
        </aside>

        {/* Title/description + episodes. On mobile this sits BELOW the sources panel
            (grid-area order) so picking a source doesn't require scrolling past it. */}
        <div className="watch-info">
          <div className="watch-meta">
            <h1>{data.title}<span className="subtle ep-ctx">{epContext}</span></h1>
            <div className="facts">
              {data.year && <span>{data.year}</span>}
              <span>{data.type === "tv" ? "Series" : "Movie"}</span>
              {data.voteAverage ? <span>★ {data.voteAverage.toFixed(1)}</span> : null}
              {data.imdbId && <span className="mono subtle">{data.imdbId}</span>}
            </div>
            {data.overview && <p className="plot">{data.overview}</p>}
          </div>

          {ttype === "tv" && seasons.length > 0 && (
            <EpisodeBar id={tid} seasons={seasons} season={seasonN!} episode={episodeN!} onPick={(s, e) => nav(`/watch/tv/${tid}/${s}/${e}`)} />
          )}
        </div>
      </div>
    </div>
  );
}

function EpisodeBar({ id, seasons, season, episode, onPick }: {
  id: number;
  seasons: { seasonNumber: number; name: string; episodeCount: number }[];
  season: number;
  episode: number;
  onPick: (s: number, e: number) => void;
}) {
  const cur = seasons.find((s) => s.seasonNumber === season) || seasons[0];
  const count = Math.max(cur?.episodeCount ?? 0, 1);
  const RANGE = 50;

  // Split long seasons into 1-50 / 51-100 … ranges.
  const ranges = useMemo(() => {
    if (count <= RANGE) return [] as { start: number; end: number }[];
    const out: { start: number; end: number }[] = [];
    for (let start = 1; start <= count; start += RANGE) out.push({ start, end: Math.min(start + RANGE - 1, count) });
    return out;
  }, [count]);

  // Default the visible range to the one holding the current episode.
  const [rangeStart, setRangeStart] = useState(() => Math.floor((episode - 1) / RANGE) * RANGE + 1);
  useEffect(() => { setRangeStart(Math.floor((episode - 1) / RANGE) * RANGE + 1); }, [episode, season]);

  const from = ranges.length ? rangeStart : 1;
  const to = ranges.length ? Math.min(rangeStart + RANGE - 1, count) : count;

  return (
    <div className="episode-bar">
      <div className="section-head"><h2><Film size={16} style={{ verticalAlign: -2, marginRight: 6 }} />Episodes</h2></div>
      <div className="tabs">
        {seasons.map((s) => (
          <button key={s.seasonNumber} className={`tab ${s.seasonNumber === season ? "active" : ""}`} onClick={() => onPick(s.seasonNumber, 1)}>{s.name}</button>
        ))}
      </div>
      {ranges.length > 1 && (
        <div className="ep-ranges">
          {ranges.map((r) => (
            <button key={r.start} className={`ep-range ${r.start === rangeStart ? "active" : ""}`} onClick={() => setRangeStart(r.start)}>{r.start}–{r.end}</button>
          ))}
        </div>
      )}
      <div className="ep-grid">
        {Array.from({ length: to - from + 1 }, (_, i) => from + i).map((e) => (
          <button key={e} className={`ep ${e === episode ? "active" : ""}`} onClick={() => onPick(season, e)}>{e}</button>
        ))}
      </div>
    </div>
  );
}
