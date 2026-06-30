import { useState } from "react";
import { Link } from "react-router-dom";
import type { Card } from "../lib/types";
import { Film, Star, Tv } from "./icons";

/** badge: optional audio indicator (e.g. "SUB" / "DUB") shown for anime cards. */
export default function PosterCard({ card, badge }: { card: Card; badge?: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <Link className="poster" to={`/title/${card.type}/${card.id}`}>
      {badge ? <span className={`audio-badge ${badge.toLowerCase()}`}>{badge}</span> : null}
      {card.voteAverage ? (
        <span className="rating"><Star size={11} /> {card.voteAverage.toFixed(1)}</span>
      ) : null}
      {card.posterUrl && !broken ? (
        <img className="img" src={card.posterUrl} alt={card.title} loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <div className="ph">{card.title}</div>
      )}
      <div className="body">
        <div className="t">{card.title}</div>
        <div className="sub">
          {card.type === "tv" ? <Tv size={12} /> : <Film size={12} />}
          <span>{card.type === "tv" ? "Series" : "Movie"}</span>
          {card.year ? <span>· {card.year}</span> : null}
        </div>
      </div>
    </Link>
  );
}
