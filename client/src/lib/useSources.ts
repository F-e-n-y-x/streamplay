import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, sourcesStreamUrl } from "./api";
import { useSettings } from "./settings";
import type { MetaSource, ProviderRun, StreamLink, SubtitleTrack } from "./types";

/** A streamed candidate with the scoring fields from ux/sources-contract.md (all optional:
 *  an older server, a cached replay or a torrent link may omit any of them). */
export interface SourceLink extends StreamLink {
  id?: string;
  providerName?: string;
  /** Raw server/release name: tooltip only */
  variant?: string;
  verified?: boolean | "unknown";
  verifiedAt?: number;
  verifyError?: string;
  latencyMs?: number;
  startupMs?: number;
  /** Language detected in the label ("Hindi", "Dual", "Multi") */
  audio?: string;
  audioTracks?: { lang: string; label: string; dub?: boolean }[];
  webReady?: boolean;
  browserPlayable?: boolean;
  external?: boolean;
  hidden?: boolean;
  score?: number;
  recommended?: boolean;
  /** Source-list facts (server-parsed): site behind an addon, release specs, size, audio languages, container */
  origin?: string;
  specs?: string[];
  size?: string;
  languages?: string[];
  container?: string;
  failures?: { count24h: number; lastAt?: number; lastReason?: "timeout" | "http" | "decode" | "geo" };
}

export type SourcePhase =
  | "finding"    // scanning, nothing picked yet
  | "starting"   // picked, waiting for the first frame
  | "switching"  // the last one broke; starting the next one
  | "playing"
  | "failed"     // the automatic switches ran out
  | "none";      // the scan finished with nothing we could play

export interface PlayingSource { link: SourceLink; subtitles: { lang: string; url: string }[] }

const AUTO_SWITCHES = 5;
export const isDirect = (l: StreamLink) => l.type === "m3u8" || l.type === "mp4";
export const browserOk = (l: SourceLink) => l.browserPlayable !== false && l.webReady !== false && !l.external;
export const qualityLabel = (q?: number) => (!q ? "" : q >= 2160 ? "4K" : `${q}p`);
/** Decoded frame → nominal quality: a 1920×800 scope picture is "1080p", not "800p". */
export const nominalHeight = (w: number, h: number) => Math.max(h, Math.round((w * 9) / 16));

/** What we know about a link's audio language: true = one of `want`, false = known and
 *  different, null = unknown / multi-audio (never held against it). */
export function audioMatches(l: SourceLink, want: string[]): boolean | null {
  if (!want.length) return null;
  const known = [l.audio, ...(l.audioTracks ?? []).map((t) => t.label || t.lang)].filter(Boolean) as string[];
  if (!known.length || known.some((a) => /multi|dual/i.test(a))) return null;
  return known.some((a) => want.some((w) => a.toLowerCase().includes(w.toLowerCase())));
}

/**
 * Sources for one title/episode: one SSE scan, automatic pick (server `best`, `upgrade`
 * only before the first frame), silent failover capped at AUTO_SWITCHES, and playback
 * reports back to the server so its scoring learns.
 */
export function useSources(opts: {
  type: "movie" | "tv"; id: number; season?: number; episode?: number; src?: MetaSource;
  kind: string; enabled: boolean;
  /** Audio languages to prefer (settings, else original language + English). A best/upgrade
   *  in another known language is skipped while a matching or unknown-language one exists. */
  audio?: string[];
  /** Called after a silent switch reaches its first frame: "X stopped working. Switched to Y." */
  onSwitched?: (from: SourceLink, fromPlayed: boolean, to: SourceLink) => void;
}) {
  const { type, id, season, episode, src, kind, enabled } = opts;
  const settings = useSettings();
  const hiddenPids = settings.providerPrefs[kind]?.hidden ?? [];
  const want = opts.audio ?? [];
  const wantKey = want.join(",");

  const [runs, setRuns] = useState<Record<string, ProviderRun & { hidden?: boolean }>>({});
  const [links, setLinks] = useState<SourceLink[]>([]);
  const [subs, setSubs] = useState<SubtitleTrack[]>([]);
  const [progress, setProgress] = useState({ total: 0, settled: 0, done: false });
  const [ranked, setRanked] = useState<string[] | null>(null);
  const [current, setCurrent] = useState<SourceLink | null>(null);
  const [started, setStarted] = useState(false);
  const [failed, setFailed] = useState<Record<string, number>>({});   // url → when it failed here
  const [waiting, setWaiting] = useState(false);   // a failure left nothing to switch to (yet)
  const [exhausted, setExhausted] = useState(false);
  const [noneFound, setNoneFound] = useState(false);
  const [switchFrom, setSwitchFrom] = useState<{ link: SourceLink; played: boolean } | null>(null);
  const [scan, setScan] = useState(0);   // bump = rescan

  // Refs the SSE handlers and callbacks read (they outlive renders).
  const r = useRef({ current, started, auto: true, manual: false, switches: 0, failed, startedAt: 0, links, ranked, switchFrom, onSwitched: opts.onSwitched,
    want, candidates: (() => []) as (list: SourceLink[], f: Record<string, number>, rk: string[] | null) => SourceLink[] });
  Object.assign(r.current, { want, current, started, failed, links, ranked, switchFrom, onSwitched: opts.onSwitched });

  // An add-on can carry a provider we also have built in ("CastleTV" vs "Castle TV"): the
  // add-on copy says so, so Change source never shows two look-alike rows.
  const dupNames = useMemo(() => {
    const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
    const by = new Map<string, Set<string>>();
    for (const p of Object.values(runs)) by.set(norm(p.name), (by.get(norm(p.name)) ?? new Set()).add(p.id));
    return new Set([...by].filter(([, ids]) => ids.size > 1).map(([n]) => n));
  }, [runs]);
  const name = useCallback((l: SourceLink) => {
    const n = l.providerName || runs[l.providerId]?.name || l.providerId;
    return l.providerId.includes(":") && dupNames.has(n.toLowerCase().replace(/[^a-z0-9]/g, "")) ? `${n} · add-on` : n;
  }, [runs, dupNames]);

  const start = useCallback((link: SourceLink, auto: boolean) => {
    r.current.auto = auto;
    r.current.startedAt = performance.now();
    setStarted(false);
    setWaiting(false);
    setExhausted(false);
    setNoneFound(false);
    setCurrent(link);
  }, []);

  /** Auto-pick order: wrong known audio language last, then ranked (server) order if we
   *  have it, else score; equal scores → the faster starter. */
  const candidates = useCallback((list: SourceLink[], f: Record<string, number>, rk: string[] | null) => {
    const ok = list.filter((l) => isDirect(l) && browserOk(l) && !l.hidden && l.verified !== false && !f[l.url] && !hiddenPids.includes(l.providerId));
    const pos = (l: SourceLink) => { const i = rk ? rk.indexOf(l.url) : -1; return i < 0 ? Infinity : i; };
    const wrong = (l: SourceLink) => Number(audioMatches(l, want) === false);
    const ms = (l: SourceLink) => l.startupMs ?? l.latencyMs ?? 9e9;
    return ok.sort((a, b) => wrong(a) - wrong(b) || pos(a) - pos(b) || (b.score ?? -999) - (a.score ?? -999) || ms(a) - ms(b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hiddenPids.join(","), wantKey]);
  r.current.candidates = candidates;

  // ── the scan ──
  useEffect(() => {
    if (!enabled) return;
    setRuns({}); setLinks([]); setSubs([]); setProgress({ total: 0, settled: 0, done: false }); setRanked(null);
    setCurrent(null); setStarted(false); setFailed({}); setWaiting(false); setExhausted(false); setNoneFound(false); setSwitchFrom(null);
    Object.assign(r.current, { auto: true, manual: false, switches: 0 });
    const es = new EventSource(sourcesStreamUrl({ type, id, season, episode, src, fresh: scan > 0 }));
    const data = (e: Event) => JSON.parse((e as MessageEvent).data);
    const add = (l: SourceLink) => setLinks((ls) => (ls.some((x) => x.url === l.url) ? ls : [...ls, l]));
    es.addEventListener("provider", (e) => { const p = data(e); setRuns((m) => ({ ...m, [p.id]: p })); });
    es.addEventListener("link", (e) => add(data(e)));
    es.addEventListener("subtitle", (e) => { const s = data(e) as SubtitleTrack; setSubs((l) => (l.some((x) => x.url === s.url) ? l : [...l, s])); });
    es.addEventListener("progress", (e) => setProgress(data(e)));
    es.addEventListener("ranked", (e) => setRanked((data(e).sources as { url: string }[]).map((s) => s.url)));
    // A server pick in a known wrong language loses to any matching/unknown-language candidate.
    // (handlers outlive renders: read the live list/prefs from the ref)
    const better = (l: SourceLink) => {
      const c = r.current;
      if (audioMatches(l, c.want) !== false) return undefined;
      const alt = c.candidates([...c.links, l], c.failed, c.ranked)[0];
      return alt && audioMatches(alt, c.want) !== false ? alt : undefined;
    };
    es.addEventListener("best", (e) => {
      let l = data(e).source as SourceLink;
      add(l);
      l = better(l) ?? l;
      if (!r.current.current && !r.current.manual && !hiddenPids.includes(l.providerId)) start(l, true);
    });
    es.addEventListener("upgrade", (e) => {
      const l = data(e).source as SourceLink;
      add(l);
      const c = r.current;
      if (better(l)) return;
      // only before the first frame, only over our own automatic pick, never mid-failover
      if (c.current && c.auto && !c.started && !c.switches && !hiddenPids.includes(l.providerId)) start(l, true);
    });
    const end = () => { es.close(); setProgress((p) => ({ ...p, done: true })); };
    es.addEventListener("done", end);
    // EventSource reconnects by itself after a blip; only a closed stream ends the scan.
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) end(); };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, type, id, season, episode, src, settings.torrentMode, scan]);

  // No server pick (old server / nothing qualified) or a failure left us waiting: choose here
  // once something playable arrives, or when the scan ends.
  useEffect(() => {
    if (!enabled || current || exhausted || noneFound) return;
    if (!waiting && !progress.done) return;
    const next = candidates(links, failed, ranked)[0];
    if (next && waiting && r.current.switches >= AUTO_SWITCHES) { setExhausted(true); return; }
    if (next) {
      if (waiting) r.current.switches++;
      start(next, true);
      return;
    }
    if (!progress.done) return;
    // Last resort: a site's own web player (iframe) beats a dead end.
    const web = links.filter((l) => l.type === "iframe" && !failed[l.url] && !l.hidden).sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    if (web && !waiting) { start(web, true); return; }
    if (waiting) setExhausted(true); else setNoneFound(true);
  }, [enabled, current, exhausted, noneFound, waiting, progress.done, links, failed, ranked, candidates, start]);

  const report = (l: SourceLink, outcome: "played" | "failed" | "stalled", extra: { ttffMs?: number; error?: string } = {}) => {
    if (!isDirect(l)) return;
    api.reportSource({ provider: l.providerId, outcome, url: l.url, ...extra });
  };

  /** The player reached its first frame. */
  const onFirstFrame = useCallback(() => {
    const c = r.current;
    if (!c.current || c.started) return;
    const ttffMs = Math.round(performance.now() - c.startedAt);
    report(c.current, "played", { ttffMs });
    setStarted(true);
    if (c.switchFrom) c.onSwitched?.(c.switchFrom.link, c.switchFrom.played, c.current);
    setSwitchFrom(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Fatal error or long stall: report it, then switch silently to the next best one. */
  const onBroken = useCallback((outcome: "failed" | "stalled", error: string) => {
    const c = r.current, cur = c.current;
    if (!cur) return;
    report(cur, outcome, { error });
    const f = { ...c.failed, [cur.url]: Date.now() };
    c.failed = f;
    setFailed(f);
    setSwitchFrom((sf) => sf ?? { link: cur, played: c.started });
    setCurrent(null);
    setStarted(false);
    if (c.switches >= AUTO_SWITCHES) { setExhausted(true); return; }
    const next = candidates(c.links, f, c.ranked)[0];
    if (next) { c.switches++; start(next, true); } else setWaiting(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, start]);

  /** The user chose a row in Change source. */
  const pick = useCallback((l: SourceLink) => {
    Object.assign(r.current, { manual: true, switches: 0 });
    setSwitchFrom(null);
    start(l, false);
  }, [start]);

  const rescan = useCallback(() => setScan((n) => n + 1), []);

  const playing = useMemo<PlayingSource | null>(() => {
    if (!current) return null;
    // the source's own provider's subtitles first, then the rest, preferred languages first
    const pref = settings.audioLanguages.map((l) => l.toLowerCase());
    const rank = (s: SubtitleTrack) => (s.providerId === current.providerId ? 0 : 100) + (() => { const i = pref.findIndex((p) => s.lang?.toLowerCase().includes(p)); return i < 0 ? 99 : i; })();
    return { link: current, subtitles: [...subs].sort((a, b) => rank(a) - rank(b)).map(({ lang, url }) => ({ lang, url })) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, subs.length, settings.audioLanguages.join(",")]);

  const phase: SourcePhase = current
    ? (started ? "playing" : switchFrom ? "switching" : "starting")
    : exhausted ? "failed" : noneFound ? "none" : "finding";

  return {
    phase, playing, current, links, runs, progress, failed, name, hiddenPids,
    onFirstFrame, onBroken, pick, rescan,
  };
}

export type Sources = ReturnType<typeof useSources>;
