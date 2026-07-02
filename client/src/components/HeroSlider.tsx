import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Card } from "../lib/types";
import { Play, Star } from "./icons";

/** Auto-rotating hero. Swipe (or drag) to change slides; dots to jump. */
export default function HeroSlider({ slides }: { slides: Card[] }) {
  const [i, setI] = useState(0);
  const n = slides.length;
  const downX = useRef<number | null>(null);

  useEffect(() => {
    if (n <= 1) return;
    const t = setInterval(() => setI((x) => (x + 1) % n), 6500);
    return () => clearInterval(t);
  }, [n]);

  if (!n) return null;
  const go = (d: number) => setI((x) => (x + d + n) % n);

  // Swipe / drag to change slide (works for touch + mouse; a real click doesn't move far enough to trigger).
  const onDown = (x: number) => { downX.current = x; };
  const onUp = (x: number) => {
    if (downX.current == null) return;
    const dx = x - downX.current;
    downX.current = null;
    if (Math.abs(dx) > 45) go(dx < 0 ? 1 : -1);
  };

  return (
    <section
      className="hero-slider"
      onPointerDown={(e) => { try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* */ } onDown(e.clientX); }}
      onPointerUp={(e) => onUp(e.clientX)}
      onPointerCancel={() => { downX.current = null; }}
      onTouchStart={(e) => onDown(e.touches[0].clientX)}
      onTouchEnd={(e) => onUp(e.changedTouches[0].clientX)}
    >
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
        <div className="hero-dots">
          {slides.map((_, idx) => (
            <button key={idx} className={`hero-dot ${idx === i ? "active" : ""}`} onClick={() => setI(idx)} aria-label={`Go to slide ${idx + 1}`} />
          ))}
        </div>
      )}
    </section>
  );
}
