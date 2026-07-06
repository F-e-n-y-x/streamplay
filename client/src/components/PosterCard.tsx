import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Card } from "../lib/types";
import { api } from "../lib/api";
import { Film, Star, Tv } from "./icons";

/** badge: optional audio indicator (e.g. "SUB" / "DUB") shown for anime cards. */
export default function PosterCard({ card, badge }: { card: Card; badge?: string }) {
  const [broken, setBroken] = useState(false);
  const [resolving, setResolving] = useState(false);
  const navigate = useNavigate();

  // Anime cards from AniList have no TMDB id yet — resolve it on click, then deep-link
  // to the exact cour that was clicked (?al=) so the title page pre-selects that season.
  const onResolve = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (resolving) return;
    setResolving(true);
    try {
      const r = await api.resolveAnime(card);
      navigate(`/title/${r.type}/${r.id}${r.anilistId ? `?al=${r.anilistId}` : ""}`);
    } catch {
      // No TMDB match — fall back to a search so the title is still reachable.
      navigate(`/search?q=${encodeURIComponent(card.title)}`);
    } finally {
      setResolving(false);
    }
  };

  const inner = (
    <>
      {resolving ? <span className="audio-badge" style={{ background: "var(--accent)" }}>…</span> : null}
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
    </>
  );

  if (card.needsResolve) {
    return (
      <a
        className="poster"
        href={`/title/${card.type}/${card.id}`}
        role="button"
        aria-busy={resolving}
        onClick={onResolve}
      >
        {inner}
      </a>
    );
  }

  return (
    <Link className="poster" to={`/title/${card.type}/${card.id}`}>
      {inner}
    </Link>
  );
}
