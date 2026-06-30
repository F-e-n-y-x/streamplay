import { Link, useNavigate } from "react-router-dom";
import { useStore, continueWatching, recentHistory, listFavs, removeHistory, clearHistory, type HistoryEntry } from "../lib/store";
import PosterCard from "../components/PosterCard";
import ContinueCard from "../components/ContinueCard";
import { Bookmark, Play, Trash2, X } from "../components/icons";

function fmtAgo(ts: number) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
const resumeHref = (h: HistoryEntry) => (h.type === "tv" ? `/watch/tv/${h.id}/${h.season}/${h.episode}` : `/watch/movie/${h.id}`);

export default function Watchlist() {
  useStore();
  const nav = useNavigate();
  const cont = continueWatching();
  const hist = recentHistory();
  const favs = listFavs();

  if (cont.length === 0 && favs.length === 0 && hist.length === 0) {
    return (
      <div className="container">
        <h1 className="page-title">Library</h1>
        <div className="empty">
          <Bookmark size={28} />
          <p>Your library is empty. Watched titles and favourites will show up here.</p>
          <Link className="btn btn-primary" to="/">Browse titles</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container">
      <h1 className="page-title">Library</h1>

      {cont.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Continue Watching</h2></div>
          <div className="grid">{cont.map((h) => <ContinueCard key={h.key} h={h} />)}</div>
        </section>
      )}

      {favs.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Favourites</h2><span className="subtle">{favs.length}</span></div>
          <div className="grid">{favs.map((c) => <PosterCard key={c.key} card={c} />)}</div>
        </section>
      )}

      {hist.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>History</h2><button className="btn btn-sm" onClick={clearHistory}><Trash2 size={14} /> Clear</button></div>
          <div className="hist-list">
            {hist.slice(0, 60).map((h) => (
              <div className="hist-row" key={h.key}>
                {h.posterUrl ? <img className="hist-thumb" src={h.posterUrl} alt="" /> : <div className="hist-thumb" />}
                <div className="hist-info">
                  <div className="t">{h.title} {h.type === "tv" && <span className="subtle">S{h.season}E{h.episode}</span>}</div>
                  <div className="sub">{h.provider ? `${h.provider} · ` : ""}{Math.round((h.position / (h.duration || 1)) * 100)}% watched · {fmtAgo(h.updatedAt)}</div>
                </div>
                <button className="btn btn-sm" onClick={() => nav(resumeHref(h))}><Play size={14} /> Resume</button>
                <button className="btn btn-icon btn-ghost btn-sm" onClick={() => removeHistory(h.key)} aria-label="Remove"><X size={14} /></button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
