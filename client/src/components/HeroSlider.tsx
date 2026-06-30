import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { Card } from "../lib/types";
import { ChevronLeft, ChevronRight, Play, Star } from "./icons";

/** Auto-rotating hero with multiple slides (top / recommended titles). */
export default function HeroSlider({ slides }: { slides: Card[] }) {
  const [i, setI] = useState(0);
  const n = slides.length;

  useEffect(() => {
    if (n <= 1) return;
    const t = setInterval(() => setI((x) => (x + 1) % n), 6500);
    return () => clearInterval(t);
  }, [n]);

  if (!n) return null;
  const go = (d: number) => setI((x) => (x + d + n) % n);

  return (
    <section className="hero-slider">
      {slides.map((s, idx) => (
        <div key={`${s.type}-${s.id}`} className={`hero-slide ${idx === i ? "active" : ""}`} aria-hidden={idx !== i}>
          <div className="bg" style={{ backgroundImage: `url(${s.backdropUrl})` }} />
          <div className="scrim" />
          <div className="content">
            <span className="eyebrow">Featured</span>
            <h1>{s.title}</h1>
            <div className="facts">
              {s.year && <span>{s.year}</span>}
              <span>{s.type === "tv" ? "Series" : "Movie"}</span>
              {s.voteAverage ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><Star size={13} /> {s.voteAverage.toFixed(1)}</span> : null}
            </div>
            <p className="plot">{s.overview}</p>
            <div className="actions">
              <Link className="btn btn-primary" to={`/title/${s.type}/${s.id}`}><Play size={16} /> View details</Link>
            </div>
          </div>
        </div>
      ))}

      {n > 1 && (
        <>
          <button className="hero-nav left" onClick={() => go(-1)} aria-label="Previous slide"><ChevronLeft size={20} /></button>
          <button className="hero-nav right" onClick={() => go(1)} aria-label="Next slide"><ChevronRight size={20} /></button>
          <div className="hero-dots">
            {slides.map((_, idx) => (
              <button key={idx} className={`hero-dot ${idx === i ? "active" : ""}`} onClick={() => setI(idx)} aria-label={`Go to slide ${idx + 1}`} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
