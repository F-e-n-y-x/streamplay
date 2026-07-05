import { useQuery } from "@tanstack/react-query";
import { api, type BrowseOpts } from "./api";
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

export function useSearch(q: string, page = 1) {
  const scope = useScope();
  return useQuery({
    queryKey: ["search", q, page, ...scope],
    queryFn: ({ signal }) => api.search(q, page, signal),
    enabled: !!q.trim(),
    placeholderData: (prev) => prev,   // keep old results visible while the next query loads
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

export function useSeason(id: number | string, n: number | null, enabled = true) {
  const scope = useScope();
  return useQuery({
    queryKey: ["season", id, n, ...scope],
    queryFn: ({ signal }) => api.season(id, n as number, signal),
    enabled: enabled && n != null,
  });
}

export function useProviders() {
  return useQuery({ queryKey: ["providers"], queryFn: ({ signal }) => api.providers(signal) });
}

export function useProvidersHealth() {
  return useQuery({ queryKey: ["providersHealth"], queryFn: ({ signal }) => api.providersHealth(signal), staleTime: 30_000 });
}
