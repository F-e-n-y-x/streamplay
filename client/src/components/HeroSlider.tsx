import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Card } from "../lib/types";
import { isFav } from "../lib/store";
import { tmdbSrcSet } from "../lib/img";
import { Button, IconButton } from "./ui";
import { playAction, toggleMyList } from "./playAction";
import { Check, Info, Pause, Play, Plus, Star } from "./icons";
import "../styles/home.css";

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A slide; `label` = e.g. "#1 this week" (only for slides taken from the trending row). */
export type HeroSlide = Card & { label?: string };

/**
 * Home hero (§8.8, ref d82): full-bleed art, content bottom-left, ONE red action that is
 * resume-aware, then My List and More info as tonal buttons. Auto-advances every 7s,
 * pauses on hover/focus and has a pause button (WCAG 2.2.2); off under reduced motion.
 * Swipe on touch. Inactive slides are `inert`.
 */
export default function HeroSlider({ slides }: { slides: HeroSlide[] }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);          // hover / focus
  const [stopped, setStopped] = useState(reducedMotion); // explicit pause
  const n = slides.length;
  const downX = useRef<number | null>(null);

  useEffect(() => {
    if (n <= 1 || paused || stopped) return;
    const t = setInterval(() => setI((x) => (x + 1) % n), 7000);
    return () => clearInterval(t);
  }, [n, paused, stopped]);

  if (!n) return null;
  const cur = i % n;   // clamp when the slide set shrinks after a refetch
  const go = (d: number) => setI((x) => (x + d + n) % n);

  return (
    <section className="hero media-dark" aria-roledescription="carousel" aria-label="Featured"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setPaused(false); }}
      onKeyDown={(e) => { if ((e.target as HTMLElement).closest(".hero-pager") && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); go(e.key === "ArrowLeft" ? -1 : 1); } }}
      // No pointer capture: it would retarget the click and swallow taps on links.
      onPointerDown={(e) => { if (e.pointerType !== "mouse") downX.current = e.clientX; }}
      onPointerUp={(e) => {
        if (downX.current == null) return;
        const dx = e.clientX - downX.current;
        downX.current = null;
        if (Math.abs(dx) > 45) go(dx < 0 ? 1 : -1);
      }}
      onPointerCancel={() => { downX.current = null; }}>
      {slides.map((s, idx) => <Slide key={`${s.type}-${s.id}`} s={s} on={idx === cur} idx={idx} n={n} />)}

      {n > 1 && (
        <div className="hero-pager">
          <IconButton size="sm" variant="media" label={stopped ? "Play slideshow" : "Pause slideshow"} onClick={() => setStopped((v) => !v)}>
            {stopped ? <Play size={14} fill="currentColor" /> : <Pause size={14} fill="currentColor" />}
          </IconButton>
          {slides.map((s, idx) => (
            <button key={idx} type="button" className="hero-bar" aria-label={`Show ${s.title}`} aria-current={idx === cur ? "true" : undefined} onClick={() => setI(idx)}>
              <span />
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Slide({ s, on, idx, n }: { s: HeroSlide; on: boolean; idx: number; n: number }) {
  const act = playAction(s.type, s.id);
  const saved = isFav(s.type, s.id);
  const info = `/title/${s.type}/${s.id}`;
  return (
    <div className="hero-slide" data-active={on ? "" : undefined} inert={!on} aria-hidden={!on} aria-roledescription="slide" aria-label={`${idx + 1} of ${n}`}>
      {s.backdropUrl && (
        <img className="hero-bg" src={s.backdropUrl} srcSet={tmdbSrcSet(s.backdropUrl, [780, 1280])} sizes="100vw" alt=""
          draggable={false} decoding="async" loading={idx === 0 ? "eager" : "lazy"} fetchPriority={idx === 0 ? "high" : "low"} />
      )}
      <div className="hero-scrim" />
      <div className="hero-body">
        {s.label && <p className="hero-label">{s.label}</p>}
        <h2 className="hero-title"><Link to={info} draggable={false}>{s.title}</Link></h2>
        <p className="meta-line hero-meta">
          {s.voteAverage ? <span className="rating"><Star size={14} fill="currentColor" aria-hidden="true" /><span className="sr-only">Rated </span>{s.voteAverage.toFixed(1)}</span> : null}
          {s.year && <span>{s.year}</span>}
          <span>{s.type === "tv" ? "Series" : "Movie"}</span>
        </p>
        {s.overview && <p className="hero-plot">{s.overview}</p>}
        <div className="hero-actions">
          <Button variant="primary" size="lg" to={act.to} icon={<Play size={20} fill="currentColor" />} meta={act.meta} className="hero-play">{act.label}</Button>
          <Button variant="media" size="lg" icon={saved ? <Check size={20} /> : <Plus size={20} />} aria-pressed={saved} onClick={() => toggleMyList(s)} className="hide-phone">My List</Button>
          <Button variant="media" size="lg" to={info} icon={<Info size={20} />} className="hide-phone">More info</Button>
          <IconButton variant="media" size="lg" label={saved ? "Remove from My List" : "Add to My List"} pressed={saved} onClick={() => toggleMyList(s)} className="only-phone">
            {saved ? <Check size={20} /> : <Plus size={20} />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}
