import { Link } from "react-router-dom";
import type { HistoryEntry } from "../lib/store";
import { Play } from "./icons";

const href = (h: HistoryEntry) => (h.type === "tv" ? `/watch/tv/${h.id}/${h.season}/${h.episode}` : `/watch/movie/${h.id}`);

/** A poster card with a resume overlay + progress bar (uses the base .poster styles). */
export default function ContinueCard({ h }: { h: HistoryEntry }) {
  const pct = Math.min(100, (h.position / (h.duration || 1)) * 100);
  return (
    <Link className="poster cw" to={href(h)} title={h.title}>
      <div className="cw-art">
        {h.posterUrl ? <img className="img" src={h.posterUrl} alt={h.title} loading="lazy" /> : <div className="ph">{h.title}</div>}
        <span className="cw-play"><Play size={22} /></span>
        <div className="cw-bar"><span style={{ width: `${pct}%` }} /></div>
      </div>
      <div className="body">
        <div className="t">{h.title}</div>
        <div className="sub">{h.type === "tv" ? `S${h.season} · E${h.episode}` : "Movie"}</div>
      </div>
    </Link>
  );
}
