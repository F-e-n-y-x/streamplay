import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api, type BrowseOpts } from "./api";
import type { MetaSource } from "./types";
import { useSettings } from "./settings";

/**
 * TanStack Query hooks for every backend read. These replace the hand-rolled
 * `mounted`/`alive` guards and manual `useEffect` fetches across the pages:
 *   - unmount / input change cancels the in-flight request (via the passed signal),
 *   - results are cached + deduped, so re-visiting a page is instant,
 *   - `lang`/`adult` are part of the key so changing settings refetches correctly.
 */

// lang + adult affect every response, so fold them into each key.
function useScope() { const { lang, adult } = useSettings(); return [lang, adult] as const; }

export function useHome() {
  const scope = useScope();
  return useQuery({ queryKey: ["home", ...scope], queryFn: ({ signal }) => api.home(signal) });
}

/** Search results, paged by "Load more". Each query string is its own cache entry, so a
 *  late page for an old query can never land in the new one. */
export function useSearch(q: string) {
  const scope = useScope();
  return useInfiniteQuery({
    queryKey: ["search", q, ...scope],
    queryFn: ({ signal, pageParam }) => api.search(q, pageParam, signal),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page < last.totalPages ? last.page + 1 : undefined),
    enabled: !!q.trim(),
  });
}

/** Live suggestions; the caller debounces `q`. Stale suggestions stay visible while typing. */
export function useSuggest(q: string) {
  const scope = useScope();
  return useQuery({
    queryKey: ["suggest", q, ...scope],
    queryFn: ({ signal }) => api.suggest(q, signal),
    enabled: q.trim().length >= 2,
    staleTime: 10 * 60_000,
    placeholderData: (prev) => prev,
  });
}

export function useBrowse(section: string, opts: BrowseOpts) {
  const scope = useScope();
  return useQuery({
    queryKey: ["browse", section, opts, ...scope],
    queryFn: ({ signal }) => api.browse(section, opts, signal),
    placeholderData: (prev) => prev,
  });
}

export function useTitle(type: "movie" | "tv", id: number | string) {
  const scope = useScope();
  return useQuery({ queryKey: ["title", type, id, ...scope], queryFn: ({ signal }) => api.title(type, id, signal), enabled: !!id });
}

/** `src` = TitleDetail.metaSource so the season is numbered the way /title numbered it. */
export function useSeason(id: number | string, n: number | null, enabled = true, src?: MetaSource) {
  const scope = useScope();
  return useQuery({
    queryKey: ["season", id, n, src, ...scope],
    queryFn: ({ signal }) => api.season(id, n as number, signal, src),
    enabled: enabled && n != null,
  });
}

export function useProviders() {
  return useQuery({ queryKey: ["providers"], queryFn: ({ signal }) => api.providers(signal) });
}

export function useProvidersHealth() {
  return useQuery({ queryKey: ["providersHealth"], queryFn: ({ signal }) => api.providersHealth(signal), staleTime: 30_000 });
}

/** Backend health (TMDB live vs fallback). Polled so the first-run banner clears once a key is set. */
export function useHealth() {
  return useQuery({ queryKey: ["health"], queryFn: ({ signal }) => api.health(signal), refetchInterval: 60_000, staleTime: 30_000 });
}

/** FlareSolverr / WARP diagnostics (Providers page). */
export function useDiag() {
  return useQuery({ queryKey: ["diag"], queryFn: ({ signal }) => api.diag(signal), staleTime: 0 });
}

/** Server-wide config (Torznab, addon lists). Invalidate ["config"] after a save. */
export function useConfig(token = "") {
  // full addon URLs come back only with the admin token (they can embed debrid keys)
  return useQuery({ queryKey: ["config", token], queryFn: ({ signal }) => api.config(signal, token || undefined), staleTime: 0 });
}

/** Curated addon catalog. `added` flips after a save, so invalidate ["addons"] then. */
export function useAddonCatalog() {
  return useQuery({ queryKey: ["addons", "catalog"], queryFn: ({ signal }) => api.addonCatalog(signal), staleTime: 0 });
}

/** Scrapers of every configured Nuvio repo (manifest URLs masked without the admin token). */
export function useScrapers(token = "") {
  return useQuery({ queryKey: ["addons", "scrapers", token], queryFn: ({ signal }) => api.scrapers(signal, token || undefined), staleTime: 0 });
}
