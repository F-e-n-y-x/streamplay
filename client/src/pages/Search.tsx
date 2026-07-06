import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useSearch } from "../lib/queries";
import type { Card } from "../lib/types";
import PosterCard from "../components/PosterCard";

export default function Search() {
  const [params] = useSearchParams();
  const q = params.get("q") ?? "";
  // Page 1 comes from TanStack Query (cached, cancels on query change). Extra pages
  // from "Load more" are appended locally and reset whenever the base query changes.
  const { data: first } = useSearch(q, 1);
  const [more, setMore] = useState<Card[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loadingMore, setLoadingMore] = useState(false);

  // Reset appended pages ONLY when the query changes. Keying this on `first` too meant
  // any background refetch of page 1 (new object identity) silently wiped the pages the
  // user had loaded and snapped back to page 1.
  useEffect(() => { setMore([]); setPage(1); }, [q]);
  useEffect(() => { if (first) setTotalPages(first.totalPages || 1); }, [first]);

  const items: Card[] | null = q.trim() ? (first ? [...first.items, ...more] : null) : [];

  const loadMore = async () => {
    const next = page + 1;
    const forQuery = q;
    setLoadingMore(true);
    try {
      const r = await api.search(q, next);
      if (forQuery !== q) return;   // query changed mid-fetch → drop stale results
      setMore((prev) => {
        const seen = new Set([...(first?.items || []), ...prev].map((c) => `${c.type}-${c.id}`));
        return [...prev, ...r.items.filter((c) => !seen.has(`${c.type}-${c.id}`))];
      });
      setPage(next);
      setTotalPages(r.totalPages || totalPages);
    } catch { /* ignore */ }
    finally { setLoadingMore(false); }
  };

  return (
    <div className="container">
      <h1 className="page-title">Results for “{q}”</h1>
      {!items ? (
        <div className="grid">{Array.from({ length: 12 }).map((_, i) => <div className="skeleton" key={i} style={{ aspectRatio: "2/3" }} />)}</div>
      ) : items.length === 0 ? (
        <div className="empty">No results found.</div>
      ) : (
        <>
          <div className="grid">{items.map((c) => <PosterCard key={`${c.type}-${c.id}`} card={c} />)}</div>
          {page < totalPages && (
            <div style={{ display: "flex", justifyContent: "center", marginTop: "var(--space-6)" }}>
              <button className="btn btn-primary" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Load more"}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
