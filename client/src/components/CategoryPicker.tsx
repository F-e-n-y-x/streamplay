// Genre lists for Browse › Filters (shown as FilterChips; keys are what /api/browse?genres= takes).
export interface CategoryDef { key: string; label: string }

const list = (pairs: [string, string][]): CategoryDef[] => pairs.map(([key, label]) => ({ key, label }));

/** Movies / Series / Asian (TMDB genres). */
export const GENERIC_CATEGORIES = list([
  ["action", "Action"], ["adventure", "Adventure"], ["comedy", "Comedy"], ["drama", "Drama"], ["romance", "Romance"],
  ["scifi", "Sci-fi"], ["fantasy", "Fantasy"], ["horror", "Horror"], ["thriller", "Thriller"], ["mystery", "Mystery"],
  ["crime", "Crime"], ["family", "Family"], ["music", "Music"], ["documentary", "Documentary"],
]);

/** Anime (MAL/AniList-style genres and demographics). */
export const ANIME_CATEGORIES = list([
  ["action", "Action"], ["adventure", "Adventure"], ["cars", "Cars"], ["comedy", "Comedy"],
  ["dementia", "Dementia"], ["demons", "Demons"], ["drama", "Drama"], ["ecchi", "Ecchi"],
  ["fantasy", "Fantasy"], ["game", "Game"], ["harem", "Harem"], ["historical", "Historical"],
  ["horror", "Horror"], ["isekai", "Isekai"], ["josei", "Josei"], ["kids", "Kids"],
  ["magic", "Magic"], ["mahoushoujo", "Mahou shoujo"], ["martialarts", "Martial arts"], ["mecha", "Mecha"],
  ["military", "Military"], ["music", "Music"], ["mystery", "Mystery"], ["parody", "Parody"],
  ["police", "Police"], ["psychological", "Psychological"], ["romance", "Romance"], ["samurai", "Samurai"],
  ["school", "School"], ["scifi", "Sci-fi"], ["seinen", "Seinen"], ["shoujo", "Shoujo"],
  ["shoujoai", "Shoujo ai"], ["shounen", "Shounen"], ["shounenai", "Shounen ai"], ["sliceoflife", "Slice of life"],
  ["space", "Space"], ["sports", "Sports"], ["superpower", "Super power"], ["supernatural", "Supernatural"],
  ["suspense", "Suspense"], ["thriller", "Thriller"], ["vampire", "Vampire"],
]);
