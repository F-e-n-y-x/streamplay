import type { Card } from "./types";
import { isFav, listFavs, toggleFav } from "./store";

// Favourites are kept in the unified store (lib/store.ts) so they sync across
// devices. These thin wrappers preserve the original API used around the app.

export function getWatchlist(): Card[] { return listFavs(); }
export function inWatchlist(type: string, id: number): boolean { return isFav(type, id); }
export function toggleWatchlist(card: Card): boolean { return toggleFav(card); }
