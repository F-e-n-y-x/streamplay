import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import type { Card, Episode, TitleDetail } from "../lib/types";
import { inWatchlist, toggleWatchlist } from "../lib/watchlist";
import PosterCard from "../components/PosterCard";
import Player, { type PlayerSource } from "../components/Player";
import { Bookmark, Check, Clock, Layers, Play, Plus, Star } from "../components/icons";

export default function Title() {
  const { type, id } = useParams<{ type: "movie" | "tv"; id: string }>();
  const nav = useNavigate();
  const tid = Number(id);
  const ttype = (type as "movie" | "tv") ?? "movie";

  const [data, setData] = useState<TitleDetail | null | undefined>(undefined);
  const [season, setSeason] = useState<number | null>(null);
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [player, setPlayer] = useState<PlayerSource | null>(null);

  useEffect(() => {
    let alive = true;
    setData(undefined);
    setEpisodes(null);
    api.title(ttype, tid).then((d) => {
      if (!alive) return;
      setData(d);
      setSaved(inWatchlist(d.type, d.id));
      setSeason(d.seasons[0]?.seasonNumber ?? null);
    }).catch(() => alive && setData(null));
    return () => { alive = false; };
  }, [ttype, tid]);

  useEffect(() => {
    if (ttype !== "tv" || season == null) return;
    let alive = true;
    setEpisodes(null);
    api.season(tid, season).then((r) => alive && setEpisodes(r.episodes)).catch(() => alive && setEpisodes([]));
    return () => { alive = false; };
  }, [ttype, tid, season]);

  if (data === undefined) return <div className="container"><div className="empty">Loading…</div></div>;
  if (data === null) return <div className="container"><div className="empty">Couldn't load this title.</div></div>;

  const cls = data.classification;
  const card: Card = { id: data.id, type: data.type, title: data.title, posterUrl: data.posterUrl, year: data.year, voteAverage: data.voteAverage, overview: data.overview };

  return (
    <div>
      {data.backdropUrl && (
        <div style={{ position: "relative", height: 360, marginBottom: "calc(-1 * var(--space-16))" }}>
          <div className="bg" style={{ position: "absolute", inset: 0, backgroundImage: `url(${data.backdropUrl})`, backgroundSize: "cover", backgroundPosition: "center 20%" }} />
          <div className="scrim" style={{ position: "absolute", inset: 0, background: "linear-gradient(0deg, var(--background) 4%, transparent 60%), linear-gradient(90deg, color-mix(in srgb, var(--background) 70%, transparent), transparent 60%)" }} />
        </div>
      )}
      <div className="container" style={{ position: "relative" }}>
        <div className="detail-top">
          {data.posterUrl ? <img className="detail-poster" src={data.posterUrl} alt={data.title} /> : <div className="detail-poster" />}
          <div className="detail-info">
            <h1>{data.title}</h1>
            <div className="facts">
              {data.year && <span>{data.year}</span>}
              <span>{data.type === "tv" ? "Series" : "Movie"}</span>
              {data.runtime ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Clock size={14} /> {data.runtime} min</span> : null}
              {data.voteAverage ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Star size={14} /> {data.voteAverage.toFixed(1)}</span> : null}
              {data.imdbId && <span className="mono subtle">{data.imdbId}</span>}
            </div>
            <div className="chips">
              {data.genres.map((g) => <span className="badge" key={g}>{g}</span>)}
            </div>
            <p className="plot">{data.overview}</p>
            <div className="cls-grid" style={{ marginBottom: "var(--space-5)" }}>
              {(["isAnime", "isAsian", "isBollywood", "isCartoon"] as const).filter((k) => cls[k]).map((k) => (
                <span className="badge badge-accent" key={k}>{k.replace("is", "")}</span>
              ))}
            </div>
            <div className="actions">
              <button className="btn btn-primary" onClick={() => nav(ttype === "movie" ? `/watch/movie/${tid}` : `/watch/tv/${tid}/${season ?? 1}/1`)}>
                <Play size={16} /> Watch now
              </button>
              {data.trailerKeys.length > 0 && (
                <button className="btn" onClick={() => setPlayer({ title: `${data.title} — Trailer`, url: `https://www.youtube.com/watch?v=${data.trailerKeys[0]}`, type: "youtube" })}>
                  <Play size={16} /> Trailer
                </button>
              )}
              <button className="btn" onClick={() => setSaved(toggleWatchlist(card))}>
                {saved ? <><Check size={16} /> In Watchlist</> : <><Plus size={16} /> Watchlist</>}
              </button>
            </div>
          </div>
        </div>

        {data.cast.length > 0 && (
          <section className="section">
            <div className="section-head"><h2>Cast</h2></div>
            <div className="cast-track">
              {data.cast.map((c, i) => (
                <div className="cast" key={i}>
                  {c.profileUrl ? <img className="pfp" src={c.profileUrl} alt={c.name} /> : <div className="pfp">{c.name[0] ?? "?"}</div>}
                  <div className="nm">{c.name}</div>
                  {c.character && <div className="ch">{c.character}</div>}
                </div>
              ))}
            </div>
          </section>
        )}

        {data.type === "tv" && data.seasons.length > 0 && (
          <section className="section">
            <div className="section-head"><h2><Layers size={18} style={{ verticalAlign: "-3px", marginRight: 6 }} />Episodes</h2></div>
            <div className="tabs">
              {data.seasons.map((s) => (
                <button key={s.seasonNumber} className={`tab ${s.seasonNumber === season ? "active" : ""}`} onClick={() => setSeason(s.seasonNumber)}>{s.name}</button>
              ))}
            </div>
            {!episodes ? (
              Array.from({ length: 4 }).map((_, i) => <div className="skeleton" key={i} style={{ height: 112, marginBottom: "var(--space-3)" }} />)
            ) : (
              episodes.map((ep) => (
                <div
                  className="episode episode-clickable"
                  key={ep.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => nav(`/watch/tv/${tid}/${ep.seasonNumber}/${ep.episodeNumber}`)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nav(`/watch/tv/${tid}/${ep.seasonNumber}/${ep.episodeNumber}`); } }}
                >
                  {ep.stillUrl ? <img className="still" src={ep.stillUrl} alt={ep.name} /> : <div className="still" />}
                  <div className="ei">
                    <div className="et">{ep.episodeNumber}. {ep.name} {ep.voteAverage ? <span className="subtle" style={{ fontSize: "var(--text-xs)" }}>★ {ep.voteAverage.toFixed(1)}</span> : null}</div>
                    {ep.overview && <div className="eo">{ep.overview}</div>}
                  </div>
                  <span className="btn btn-sm episode-play"><Play size={15} /> Play</span>
                </div>
              ))
            )}
          </section>
        )}

        {data.recommendations.length > 0 && (
          <section className="section">
            <div className="section-head"><h2>More like this</h2></div>
            <div className="grid">{data.recommendations.map((c) => <PosterCard key={`${c.type}-${c.id}`} card={c} />)}</div>
          </section>
        )}
      </div>

      {player && <Player source={player} onClose={() => setPlayer(null)} />}
    </div>
  );
}
