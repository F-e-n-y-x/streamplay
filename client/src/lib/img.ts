import { useEffect } from "react";

// TMDB serves fixed widths at /t/p/w{N}/; rewriting that segment gives a srcset.
// Non-TMDB URLs (AniList, etc.) return undefined → the plain src is used.
const TMDB = /^(https:\/\/image\.tmdb\.org\/t\/p\/)(?:w\d+|original)(\/.+)$/;

export function tmdbSrcSet(url: string | undefined, widths: number[]): string | undefined {
  const m = url ? TMDB.exec(url) : null;
  return m ? widths.map((w) => `${m[1]}w${w}${m[2]} ${w}w`).join(", ") : undefined;
}

/** Same TMDB image at another width (non-TMDB URLs unchanged). */
export const tmdbSize = (url: string, w: number) => url.replace(TMDB, `$1w${w}$2`);

/**
 * Ambient tint (title / watch pages): the backdrop's average colour pushed down to a
 * dark, low-chroma ground (and a pale one for the light theme), written to <body> as
 * --tint-dark / --tint-light + `.tinted` (app.css swaps --background, which cross-fades
 * via @property). image.tmdb.org sends `Access-Control-Allow-Origin: *`, so a
 * crossOrigin load keeps the canvas readable; a host that doesn't makes getImageData
 * throw → no tint, the page keeps its neutral ground. strength < 1 = subtler (Watch).
 */
export function useAmbient(url: string | undefined, strength = 1): void {
  useEffect(() => {
    if (!url) return;
    let alive = true;
    const body = document.body;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      if (!alive) return;
      try {
        const c = document.createElement("canvas");
        c.width = 24; c.height = 14;
        const g = c.getContext("2d", { willReadFrequently: true });
        if (!g) return;
        g.drawImage(img, 0, 0, 24, 14);
        const d = g.getImageData(0, 0, 24, 14).data;
        let r = 0, gr = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        const t = ambientOf(r / n, gr / n, b / n, strength);
        body.style.setProperty("--tint-dark", t.dark);
        body.style.setProperty("--tint-light", t.light);
        body.classList.add("tinted");
      } catch { /* tainted canvas: keep the neutral ground */ }
    };
    img.src = tmdbSize(url, 300);
    return () => {
      alive = false; img.onload = null;
      body.classList.remove("tinted");
      body.style.removeProperty("--tint-dark"); body.style.removeProperty("--tint-light");
    };
  }, [url, strength]);
}

/** Average rgb (0–255) → the hue kept, chroma capped, lightness pinned: dark + light grounds. */
export function ambientOf(r: number, g: number, b: number, strength = 1): { dark: string; light: string } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const hue = Math.round((h * 60 + 360) % 360);
  const sat = Math.min((d ? d / (1 - Math.abs(2 * l - 1)) : 0) * 2.2, 1) * strength;   // averages are greyish: lift, then cap
  return {
    dark: `hsl(${hue} ${Math.round(sat * 32)}% ${(4 + (5 + l * 6) * strength).toFixed(1)}%)`,
    light: `hsl(${hue} ${Math.round(sat * 28)}% ${(97 - 4 * strength).toFixed(1)}%)`,
  };
}
