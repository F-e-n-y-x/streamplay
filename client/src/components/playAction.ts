import type { Card, SeasonStub } from "../lib/types";
import { latestFor, nextUp, toggleFav, watchHref, type HistoryEntry } from "../lib/store";
import { formatRuntime } from "../lib/format";
import { toast } from "./ui";

/** What a resume promises: "32 min left" / "Up next" / "Started". */
export function remaining(h: HistoryEntry): string {
  if (h.upNext) return "Up next";
  if (h.duration <= 0) return "Started";
  return `${formatRuntime(Math.max(1, Math.round((h.duration - h.position) / 60)))} left`;
}

/** "S1 · E3" for an episode, "" for a movie. */
export const epLabel = (h: { type: "movie" | "tv"; season?: number; episode?: number }) =>
  h.type === "tv" && h.season != null ? `S${h.season} · E${h.episode ?? 1}` : "";

export interface PlayAction {
  to: string;
  /** resume = in progress · next = the episode after a finished one · start = nothing watched yet */
  from: "resume" | "next" | "start";
  label: string;
  /** Trailing meta on the button: "32 min left" */
  meta?: string;
  /** Restart the resumed episode/movie (only when resuming) */
  restart?: string;
  /** The episode the button plays (series) */
  season?: number;
  episode?: number;
}

/**
 * THE primary action for a title (§ Title "Primary button logic"), the same everywhere:
 *   in progress → "Resume S1 · E3" + "32 min left" · finished an episode → "Play S1 · E4"
 *   nothing yet → "Play" (hero) / "Play S1 · E1" (Title page: the selected season, when seasons are known).
 */
export function playAction(type: "movie" | "tv", id: number, seasons?: SeasonStub[], season?: number | null): PlayAction {
  const h = latestFor(type, id);
  const next = h && nextUp(h, seasons);
  if (next) return { from: "next", to: watchHref(next), label: `Play ${epLabel(next)}`, season: next.season, episode: next.episode };
  if (h && (h.duration <= 0 || (h.position > 5 && h.position < h.duration * 0.97))) {
    const ep = epLabel(h);
    return { from: "resume", to: watchHref(h), label: ep ? `Resume ${ep}` : "Resume", meta: h.duration > 0 ? remaining(h) : undefined, restart: `${watchHref(h)}?from=start`, season: h.season, episode: h.episode };
  }
  if (type === "movie") return { from: "start", to: watchHref({ type, id }), label: "Play" };
  // nothing watched: the season the page shows (`season`), else the first real one
  const first = seasons && (seasons.find((s) => s.seasonNumber === season) ?? seasons.find((s) => s.seasonNumber > 0) ?? seasons[0]);
  return first
    ? { from: "start", to: watchHref({ type, id, season: first.seasonNumber, episode: 1 }), label: `Play ${epLabel({ type, season: first.seasonNumber, episode: 1 })}`, season: first.seasonNumber, episode: 1 }
    : { from: "start", to: watchHref({ type, id }), label: "Play" };
}

/** Add/remove from My List with a confirming toast (and Undo). */
export function toggleMyList(card: Card) {
  const added = toggleFav(card);
  toast(added ? `Added ${card.title} to My List` : `Removed ${card.title} from My List`, {
    tone: added ? "success" : "info",
    action: { label: "Undo", onClick: () => toggleFav(card) },
  });
}
