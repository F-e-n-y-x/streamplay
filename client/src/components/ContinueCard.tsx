import { Link } from "react-router-dom";
import { putHistory, recentHistory, removeHistory, watchHref, type HistoryEntry } from "../lib/store";
import { tmdbSrcSet } from "../lib/img";
import { useTitle } from "../lib/queries";
import { Menu } from "./ui";
import { MoreVertical, Play } from "./icons";
import { epLabel, remaining } from "./playAction";
import "../styles/home.css";

/**
 * Continue watching card (§8.6 LandscapeCard): 16:9 art with a 4px progress bar, title,
 * "S1 · E3 · 32 min left". Tapping plays directly. ⋯ (hover, or always on touch) offers
 * Remove / Mark as watched.
 */
export default function ContinueCard({ h, tabIndex }: { h: HistoryEntry; tabIndex?: number }) {
  const pct = h.upNext || h.duration <= 0 ? 0 : Math.min(100, (h.position / (h.duration || 1)) * 100);
  const ep = epLabel(h);
  // entries from older builds have no backdrop: borrow the title's (same cache as the title page)
  const t = useTitle(h.type, h.backdropUrl ? 0 : h.id);
  const backdrop = h.backdropUrl || t.data?.backdropUrl;
  const art = backdrop || h.posterUrl;
  const left = remaining(h);
  const verb = h.upNext ? "Play" : "Resume";

  const removeTitle = () => recentHistory().filter((x) => x.type === h.type && x.id === h.id).forEach((x) => removeHistory(x.key));
  // embeds never report a duration: mark the entry complete with a nominal 1s
  const markWatched = () => putHistory({ ...h, upNext: undefined, position: Math.max(h.duration, 1), duration: Math.max(h.duration, 1) });

  return (
    <div className="cw">
      <Link className="card card-wide" to={watchHref(h)} tabIndex={tabIndex} draggable={false}
        aria-label={`${verb} ${h.title}${ep ? `, ${ep.replace(" · ", " ")}` : ""}, ${left}`}>
        <span className="card-art">
          {art
            ? <img src={art} srcSet={backdrop ? tmdbSrcSet(backdrop, [300, 780]) : undefined} sizes="(max-width: 767px) 80vw, 360px"
                width={320} height={180} alt="" loading="lazy" decoding="async" draggable={false} />
            : <span className="card-ph" aria-hidden="true">{h.title}</span>}
          <span className="cw-play" aria-hidden="true"><Play size={16} fill="currentColor" /></span>
          {!h.upNext && <span className={`cw-bar${h.duration <= 0 ? " cw-bar-started" : ""}`} aria-hidden="true"><span style={{ transform: `scaleX(${pct / 100})` }} /></span>}
        </span>
        <span className="card-text">
          <span className="card-title">{h.title}</span>
          <span className="meta-line">
            {ep && <span>{ep}</span>}
            <span>{left}</span>
          </span>
        </span>
      </Link>
      <div className="cw-more">
        <Menu label={`${h.title} options`} align="end" items={[
          { label: "Remove from Continue watching", onSelect: removeTitle },
          ...(h.upNext ? [] : [{ label: "Mark as watched", onSelect: markWatched }]),
        ]} trigger={(p) => (
          <button {...p} type="button" className="icon-btn icon-btn-media icon-btn-sm" aria-label={`More options for ${h.title}`} title="More options" tabIndex={tabIndex}>
            <MoreVertical size={16} />
          </button>
        )} />
      </div>
    </div>
  );
}
