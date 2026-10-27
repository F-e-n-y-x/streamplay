import { useState } from "react";
import { Link } from "react-router-dom";
import type { Card } from "../lib/types";
import { tmdbSrcSet } from "../lib/img";
import "../styles/home.css";

const SIZES = "(max-width: 767px) 40vw, (max-width: 1099px) 22vw, 200px";
const WIDE = "(max-width: 767px) 80vw, (max-width: 1099px) 40vw, 360px";

/**
 * PosterCard (§8.6): art first, title (2 lines) + one meta line. Anime cards may carry a
 * negative id (-anilistId); /title resolves those server-side, so every card is a plain link.
 *   rank  → Top 10 card with the outlined numeral
 *   wide  → 16:9 backdrop card ("More like this"); falls back to the poster without a backdrop
 *   showType → meta "2008 · Series" (mixed lists: search, My List). Default: year only.
 */
export default function PosterCard({ card, rank, wide, showType, tabIndex }: { card: Card; rank?: number; wide?: boolean; showType?: boolean; tabIndex?: number }) {
  const [broken, setBroken] = useState(false);
  const landscape = wide && !!card.backdropUrl && !broken;
  const kind = card.type === "tv" ? "Series" : "Movie";

  return (
    <Link className={`card${rank ? " card-ranked" : ""}${landscape ? " card-wide" : ""}`} to={`/title/${card.type}/${card.id}`}
      draggable={false} tabIndex={tabIndex} aria-label={rank ? `${rank}. ${card.title}` : undefined}>
      {rank ? <span className="card-rank" aria-hidden="true">{rank}</span> : null}
      <span className="card-art">
        {landscape ? (
          <img src={card.backdropUrl} srcSet={tmdbSrcSet(card.backdropUrl, [300, 780])} sizes={WIDE}
            width={320} height={180} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />
        ) : card.posterUrl && !broken ? (
          <img src={card.posterUrl} srcSet={tmdbSrcSet(card.posterUrl, [185, 342, 500])} sizes={SIZES}
            width={342} height={513} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />
        ) : (
          <span className="card-ph" aria-hidden="true">{card.title}</span>
        )}
      </span>
      {!rank && (
        <span className="card-text">
          <span className="card-title">{card.title}</span>
          {(card.year || showType) && (
            <span className="meta-line">
              {card.year && <span>{card.year}</span>}
              {showType && <span>{kind}</span>}
            </span>
          )}
        </span>
      )}
    </Link>
  );
}

/** Loading placeholder in the card's exact shape. */
export function PosterSkeleton({ wide }: { wide?: boolean }) {
  return (
    <span className="card" aria-hidden="true">
      <span className="card-art skeleton" style={{ aspectRatio: wide ? "16 / 9" : "2 / 3" }} />
      <span className="card-text">
        <span className="skeleton skeleton-text" style={{ width: "80%" }} />
        <span className="skeleton skeleton-text" style={{ width: "30%" }} />
      </span>
    </span>
  );
}
