import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import type { TitleDetail } from "../lib/types";
import { EmbedFrame, VideoPlayer, type PlayerSource } from "../components/Player";
import SourcesPanel from "../components/SourcesPanel";
import { getHistoryEntry, putHistory } from "../lib/store";
import { ChevronLeft, Film, Play } from "../components/icons";

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

  useEffect(() => {
    let alive = true;
    setData(undefined); setCurrent(null); setFailedUrl(null);
    api.title(ttype, tid).then((d) => alive && setData(d)).catch(() => alive && setData(null));
    return () => { alive = false; };
  }, [ttype, tid]);

  // reset the player when the episode changes
  useEffect(() => { setCurrent(null); setFailedUrl(null); }, [seasonN, episodeN]);

  const seasons = data?.seasons ?? [];
  const epContext = ttype === "tv" ? ` · S${seasonN}E${episodeN}` : "";

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
      : <VideoPlayer key={current.url} source={current} embedded onFail={() => setFailedUrl(current.url)} resumeAt={resumeAt} onProgress={record} />;
  }, [current, data, ttype, tid, seasonN, episodeN]);

  if (data === undefined) return <div className="container"><div className="empty">Loading…</div></div>;
  if (data === null) return <div className="container"><div className="empty">Couldn't load this title.</div></div>;

  return (
    <div className="container watch-page">
      <Link className="back-link" to={`/title/${ttype}/${tid}`}><ChevronLeft size={16} /> Back to details</Link>

      <div className="watch-grid">
        <div className="watch-main">
          <div className="watch-stage">{stage}</div>

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

        <aside className="watch-rail">
          <SourcesPanel
            key={`${ttype}-${tid}-${seasonN ?? "m"}-${episodeN ?? "m"}`}
            type={ttype}
            id={tid}
            season={seasonN}
            episode={episodeN}
            onPlay={(s) => setCurrent(s)}
            currentUrl={current?.url ?? null}
            failedUrl={failedUrl}
          />
        </aside>
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
  return (
    <div className="episode-bar">
      <div className="section-head"><h2><Film size={16} style={{ verticalAlign: -2, marginRight: 6 }} />Episodes</h2></div>
      <div className="tabs">
        {seasons.map((s) => (
          <button key={s.seasonNumber} className={`tab ${s.seasonNumber === season ? "active" : ""}`} onClick={() => onPick(s.seasonNumber, 1)}>{s.name}</button>
        ))}
      </div>
      <div className="ep-grid">
        {Array.from({ length: count }, (_, i) => i + 1).map((e) => (
          <button key={e} className={`ep ${e === episode ? "active" : ""}`} onClick={() => onPick(season, e)}>{e}</button>
        ))}
      </div>
    </div>
  );
}
