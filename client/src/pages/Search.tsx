import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import type { Card } from "../lib/types";
import PosterCard from "../components/PosterCard";

export default function Search() {
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";
  const [items, setItems] = useState<Card[] | null>(null);

  useEffect(() => {
    let alive = true;
    setItems(null);
    api.search(q).then((r) => alive && setItems(r.items)).catch(() => alive && setItems([]));
    return () => { alive = false; };
  }, [q]);

  return (
    <div className="container">
      <h1 className="page-title">Results for “{q}”</h1>
      {!items ? (
        <div className="grid">{Array.from({ length: 12 }).map((_, i) => <div className="skeleton" key={i} style={{ aspectRatio: "2/3" }} />)}</div>
      ) : items.length === 0 ? (
        <div className="empty">No results found.</div>
      ) : (
        <div className="grid">{items.map((c) => <PosterCard key={`${c.type}-${c.id}`} card={c} />)}</div>
      )}
    </div>
  );
}
