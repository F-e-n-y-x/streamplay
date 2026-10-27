import Row, { RowSkeleton } from "../components/Row";
import HeroSlider, { type HeroSlide } from "../components/HeroSlider";
import ContinueCard from "../components/ContinueCard";
import PosterCard from "../components/PosterCard";
import { useStore, continueWatching } from "../lib/store";
import { useHealth, useHome } from "../lib/queries";
import { useDocTitle } from "../lib/useDocTitle";
import { Button, Skeleton, StateMessage } from "../components/ui";
import { Info } from "../components/icons";
import "../styles/home.css";

/** Row copy in sentence case + where "See all" goes (rows without a Browse twin get none). */
const ROWS: Record<string, { title: string; seeAll?: string }> = {
  pop_movies: { title: "Popular movies", seeAll: "/movies" },
  pop_tv: { title: "Popular series", seeAll: "/series" },
  top_movies: { title: "Top rated movies", seeAll: "/movies?cat=toprated" },
  now_playing: { title: "In theaters" },
  airing: { title: "On TV today" },
};

export default function Home() {
  useStore();
  useDocTitle(null);
  const cw = continueWatching();
  const { data: rows, error, refetch, isFetching } = useHome();
  const { data: health } = useHealth();

  if (error && !rows) {   // a failed background refetch keeps the cached rows
    return (
      <div className="container">
        <h1 className="sr-only">Home</h1>
        <StateMessage kind="error" title="Can't reach the StreamPlay server." body="Check that it's running, then try again." details={String(error)}
          actions={<Button variant="solid" onClick={() => refetch()} loading={isFetching}>Try again</Button>} />
      </div>
    );
  }
  if (!rows) return <HomeSkeleton />;

  const filled = rows.filter((r) => r.items.length > 0);
  // The first row (trending) is the Top 10 and feeds the hero; its rank becomes the label.
  const [top, ...rest] = filled;
  const slides: HeroSlide[] = [];
  const seen = new Set<string>();
  for (const r of filled) {
    r.items.forEach((c, i) => {
      const k = `${c.type}-${c.id}`;
      if (slides.length < 6 && c.backdropUrl && c.overview && !seen.has(k)) {
        seen.add(k);
        slides.push({ ...c, label: r === top && i < 10 ? `#${i + 1} this week` : undefined });
      }
    });
    if (slides.length >= 6) break;
  }

  return (
    <div className="home-page">
      <h1 className="sr-only">Home</h1>
      <HeroSlider slides={slides} />
      <div className="container home-rows">
        {health?.tmdb === "fallback" && (
          <div className="home-banner" role="status">
            <Info size={20} aria-hidden="true" />
            <p>Posters and most rows are missing because the server has no TMDB API key. Set <code>TMDB_API_KEY</code> on the server, then restart it.</p>
          </div>
        )}
        {cw.length > 0 && <Row title="Continue watching" kind="wide">{cw.map((h) => <ContinueCard key={h.key} h={h} />)}</Row>}
        {top && (
          <Row title="Top 10 this week" kind="top10">
            {top.items.slice(0, 10).map((c, i) => <PosterCard key={`${c.type}-${c.id}`} card={c} rank={i + 1} />)}
          </Row>
        )}
        {rest.map((r) => (
          <Row key={r.key} title={ROWS[r.key]?.title ?? r.name} seeAll={ROWS[r.key]?.seeAll}>
            {r.items.map((c) => <PosterCard key={`${c.type}-${c.id}`} card={c} />)}
          </Row>
        ))}
      </div>
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="home-page" aria-busy="true">
      <h1 className="sr-only">Home</h1>
      <div className="hero hero-skeleton media-dark">
        <div className="hero-body">
          <Skeleton width="min(28rem, 80%)" height="3rem" />
          <Skeleton width="10rem" height="1rem" />
          <div className="hero-actions"><Skeleton width="9rem" height="3rem" /><Skeleton width="8rem" height="3rem" /></div>
        </div>
      </div>
      <div className="container home-rows">
        <RowSkeleton kind="wide" />
        <RowSkeleton />
        <RowSkeleton />
      </div>
    </div>
  );
}
