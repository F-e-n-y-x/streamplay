/**
 * Anime/multi-season entry matching.
 *
 * Most anime sites (AniZone, AnimePahe, …) don't have per-season episode numbering
 * under one entry — they split a show into a SEPARATE entry per season: "… Season 2",
 * "… The Final Season", plus OVA/movie specials. TMDB, by contrast, gives us a
 * season NUMBER + a per-season episode number. So matching by title alone lands on
 * episode-N of whichever entry ranked first (e.g. TMDB S1E2 → "The Final Season" E2).
 *
 * `seasonScore` rates how well a candidate entry title matches the requested season,
 * so providers can pick the correct season entry before applying the episode number.
 */
export function seasonScore(title: string, wanted: number, seasonYear?: number): number {
    const t = title.toLowerCase();
    const special = /\b(oad|ova|oav|special|recap|movie|junior high|picture drama)\b/i.test(t);
    let cs: number | 'final';
    if (/final\s+season/.test(t)) cs = 'final';
    else {
        const m = /season\s*(\d+)/.exec(t) || /\b(\d+)(?:st|nd|rd|th)\s+season/.exec(t) || /\bpart\s*(\d+)/.exec(t);
        cs = m ? Number(m[1]) : 1;   // no season marker → season 1
    }
    let score = cs === 'final'
        ? (wanted >= 4 ? 9 : wanted === 3 ? 4 : -2)
        : (cs === wanted ? 10 : -Math.abs(cs - wanted) * 2);
    if (special) score -= 5;
    // Year suffix tiebreak between parts, e.g. "The Final Season (2022)".
    const ym = /\((\d{4})\)/.exec(title);
    if (ym && seasonYear) score += Number(ym[1]) === seasonYear ? 2 : -1;
    return score;
}
