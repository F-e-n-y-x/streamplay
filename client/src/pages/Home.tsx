import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Card, HomeRow } from "../lib/types";
import Row from "../components/Row";
import HeroSlider from "../components/HeroSlider";
import ContinueCard from "../components/ContinueCard";
import { useStore, continueWatching } from "../lib/store";

export default function Home() {
  const [rows, setRows] = useState<HomeRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useStore();
  const cw = continueWatching();

  useEffect(() => {
    api.home().then(setRows).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div className="container"><div className="empty">Couldn't reach the backend.<br /><span className="subtle">{err}</span></div></div>;
  if (!rows) return <HomeSkeleton />;

  // top backdrops across rows for the slider (deduped)
  const seen = new Set<string>();
  const slides: Card[] = [];
  for (const r of rows) {
    for (const c of r.items) {
      const k = `${c.type}-${c.id}`;
      if (c.backdropUrl && c.overview && !seen.has(k)) { seen.add(k); slides.push(c); }
      if (slides.length >= 7) break;
    }
    if (slides.length >= 7) break;
  }

  return (
    <div className="container">
      <HeroSlider slides={slides} />

      {cw.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Continue Watching</h2></div>
          <div className="row-track">{cw.map((h) => <ContinueCard key={h.key} h={h} />)}</div>
        </section>
      )}

      {rows.map((r) => <Row key={r.key} title={r.name} items={r.items} />)}
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="container">
      <div className="skeleton" style={{ height: 480, marginBottom: "var(--space-8)", borderRadius: "var(--radius-2xl)" }} />
      {Array.from({ length: 3 }).map((_, i) => (
        <section className="section" key={i}>
          <div className="skeleton" style={{ height: 22, width: 180, marginBottom: "var(--space-3)" }} />
          <div className="row-track">
            {Array.from({ length: 7 }).map((_, j) => (
              <div className="skeleton" key={j} style={{ aspectRatio: "2/3" }} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
