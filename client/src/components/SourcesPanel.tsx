import { useEffect, useMemo, useRef, useState } from "react";
import { sourcesStreamUrl } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { getSettings, useSettings, updateSettings } from "../lib/settings";
import type { ProviderRun, StreamLink, SubtitleTrack } from "../lib/types";
import type { PlayerSource } from "./Player";
import ProviderPrefsEditor from "./ProviderPrefsEditor";
import { Check, ChevronRight, Copy, RotateCcw, SlidersHorizontal, Zap } from "./icons";

/** Decode the original stream URL from a /api/proxy?url=<b64url> link (for external/VLC use). */
function originalUrl(proxied: string): string {
  try {
    const b = new URL(proxied, location.origin).searchParams.get("url");
    if (!b) return proxied;
    return decodeURIComponent(escape(atob(b.replace(/-/g, "+").replace(/_/g, "/"))));
  } catch { return proxied; }
}

const LANGS = ["Hindi", "English", "Tamil", "Telugu", "Malayalam", "Kannada", "Bengali", "Punjabi", "Marathi", "Spanish", "French", "German", "Korean", "Japanese", "Chinese", "Arabic", "Russian", "Italian", "Portuguese", "Vietnamese"];
function detectAudio(name: string): string {
  if (/\bvietsub\b/i.test(name)) return "Vietnamese";
  if (/\bdual\b/i.test(name)) return "Dual";
  if (/\bmulti(-?audio)?\b/i.test(name)) return "Multi";
  return LANGS.find((l) => new RegExp("\\b" + l + "\\b", "i").test(name)) || "";
}
const bucketOf = (q: number) => (q >= 2160 ? "4K" : q >= 1080 ? "1080p" : q >= 720 ? "720p" : "SD");
const typeRank = (t: string) => (t === "m3u8" ? 0 : t === "mp4" ? 1 : 2);
const STATE_LABEL: Record<string, string> = { found: "online", running: "scanning…", pending: "queued", empty: "no sources", failed: "unreachable", "circuit-broken": "circuit-broken" };
const STATE_COLOR: Record<string, string> = { found: "var(--success)", running: "var(--warning)", pending: "var(--border-strong)", empty: "var(--gray-8)", failed: "var(--error)", "circuit-broken": "var(--error)" };

/** Status dot with inline sizing so no stylesheet (or stale cache) can ever stretch it. */
function StatusDot({ state }: { state: string }) {
  return (
    <span style={{
      width: 8, height: 8, minWidth: 8, maxWidth: 8, flex: "0 0 8px", alignSelf: "center",
      borderRadius: "50%", display: "inline-block", background: STATE_COLOR[state] || "var(--border-strong)",
      animation: state === "running" ? "blink 1s var(--ease-in-out) infinite" : undefined,
    }} />
  );
}

interface Parsed extends StreamLink { variant: string; audio: string; q: number; bucket: string; external: boolean; }
function parse(link: StreamLink, providerName: string): Parsed {
  const name = link.name || providerName;
  const token = (name.match(/^[^\s[\](\-]+/) || [name])[0];
  let variant = name.slice(token.length).replace(/^[\s\-[(]+/, "").replace(/[\])]+$/, "").trim();
  const q = link.quality || 0;
  if (!variant) variant = (link.type || "").toUpperCase();
  // sources tagged "(VLC)" are meant for external players — usually not browser-playable
  return { ...link, variant, audio: detectAudio(name), q, bucket: bucketOf(q), external: /\bvlc\b/i.test(name) };
}

// The dedicated anime providers. For anime we wait for these to resolve (and pick
// the one matching the Sub/Dub preference) before falling back to a generic source,
// so a fast movie provider can't grab the player ahead of the good anime sources.
const ANIME_PROVIDERS = new Set(["anizone", "anineko", "animeworld", "allanime", "animepahe", "consumet", "castle"]);
const isTerminal = (state?: string) => state === "found" || state === "empty" || state === "failed";

// Sub/Dub markers in a source's name (AniNeko "… DUB", CastleTV "· Hindi/English"
// = dub; "SUB"/"Original"/"Japanese" = sub). Used to auto-pick the source matching
// the viewer's anime audio preference.
const DUB_RE = /\b(dub|dubbed|hindi|english|tamil|telugu|malayalam|kannada|dual|multi)\b/i;
const SUB_RE = /\b(sub|subbed|subtitle|japanese|jpn|\bjp\b|original|raw)\b/i;

export default function SourcesPanel({
  type, id, season, episode, isAnime, kind, onPlay, currentUrl, failedUrl, failSeq,
}: {
  type: "movie" | "tv";
  id: number;
  season?: number;
  episode?: number;
  isAnime?: boolean;
  /** Content kind for provider prefs / sticky: anime | movie | series | asian. */
  kind: string;
  onPlay: (s: PlayerSource, subs: SubtitleTrack[]) => void;
  currentUrl: string | null;
  failedUrl?: string | null;
  /** Increments on every playback failure so re-failing the SAME url still advances. */
  failSeq?: number;
}) {
  const liveSettings = useSettings();
  const pref = liveSettings.providerPrefs[kind] || { order: [] as string[], hidden: [] as string[] };
  const sticky = liveSettings.stickyProvider[kind];
  const [editorOpen, setEditorOpen] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  const [runs, setRuns] = useState<Record<string, ProviderRun>>({});
  const [links, setLinks] = useState<StreamLink[]>([]);
  const [subs, setSubs] = useState<SubtitleTrack[]>([]);
  const [done, setDone] = useState(false);
  const [activeQ, setActiveQ] = useState<Set<string>>(new Set());
  const [activeA, setActiveA] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showEmpty, setShowEmpty] = useState(false);
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [linkMenu, setLinkMenu] = useState<{ url: string; top: number; right: number } | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!linkMenu) return;
    const close = () => setLinkMenu(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    document.addEventListener("click", close);
    return () => { window.removeEventListener("scroll", close, true); window.removeEventListener("resize", close); document.removeEventListener("click", close); };
  }, [linkMenu]);
  const settings = getSettings() as unknown as { audioLanguages: string[]; quality: string; autoplay: boolean };
  const autostarted = useRef(false);
  const didInitFilter = useRef(false);
  const playableRef = useRef<Parsed[]>([]);

  // Wire the SSE event handlers (shared by the initial scan and the refresh re-scans).
  function attachListeners(es: EventSource) {
    es.addEventListener("provider", (e) => {
      const r = JSON.parse((e as MessageEvent).data) as ProviderRun;
      setOrder((o) => (o.includes(r.id) ? o : [...o, r.id]));
      setRuns((m) => ({ ...m, [r.id]: r }));
    });
    es.addEventListener("link", (e) => {
      const link = JSON.parse((e as MessageEvent).data) as StreamLink;
      // dedupe by URL so identical streams aren't listed twice (and don't all highlight on select)
      setLinks((l) => (l.some((x) => x.url === link.url) ? l : [...l, link]));
    });
    es.addEventListener("subtitle", (e) => {
      const sub = JSON.parse((e as MessageEvent).data) as SubtitleTrack;
      setSubs((s) => (s.some((x) => x.url === sub.url) ? s : [...s, sub]));
    });
    es.addEventListener("done", () => { setDone(true); es.close(); });
    es.onerror = () => {
      // EventSource auto-reconnects on a transient blip (readyState === CONNECTING);
      // only end the scan when it's genuinely closed, so a momentary network hiccup
      // doesn't abandon every still-pending provider and freeze the list at "scanning".
      if (es.readyState === EventSource.CLOSED) setDone(true);
    };
    esRef.current = es;
  }

  // tear down any active refresh-scan stream on unmount
  useEffect(() => () => { esRef.current?.close(); }, []);

  // reset + open SSE whenever the target changes
  useEffect(() => {
    setOrder([]); setRuns({}); setLinks([]); setSubs([]); setDone(false);
    setActiveQ(new Set()); setActiveA(new Set()); setCollapsed({}); setFailed(new Set());
    autostarted.current = false; didInitFilter.current = false;
    const es = new EventSource(sourcesStreamUrl({ type, id, season, episode }));
    attachListeners(es);
    // Close whatever stream is currently active (esRef tracks the latest — a refresh
    // scan may have replaced `es`), otherwise re-running this effect (e.g. on a
    // torrent-mode toggle) would leak the in-flight refresh EventSource.
    return () => esRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, id, season, episode, liveSettings.torrentMode]);

  // Refresh ONLY the providers that didn't return a source — keep the working ones.
  function refreshFailed() {
    const ids = order.filter((pid) => runs[pid]?.state !== "found");
    if (!ids.length) return;
    esRef.current?.close();
    setLinks((l) => l.filter((x) => !ids.includes(x.providerId)));   // drop their stale (empty) results
    setRuns((m) => { const n = { ...m }; ids.forEach((pid) => { if (n[pid]) n[pid] = { ...n[pid], state: "running" } as ProviderRun; }); return n; });
    setDone(false);
    attachListeners(new EventSource(sourcesStreamUrl({ type, id, season, episode, fresh: true, providers: ids })));
  }

  // Re-scan EVERY provider from scratch (skip cache) — the 5s-hover "Refresh all".
  function refreshAll() {
    esRef.current?.close();
    setOrder([]); setRuns({}); setLinks([]); setSubs([]); setDone(false);
    setActiveQ(new Set()); setActiveA(new Set()); setCollapsed({}); setFailed(new Set());
    autostarted.current = false; didInitFilter.current = false;
    attachListeners(new EventSource(sourcesStreamUrl({ type, id, season, episode, fresh: true })));
  }

  // default quality filter from settings
  useEffect(() => {
    if (didInitFilter.current || !links.length) return;
    if (settings.quality && settings.quality !== "auto") {
      const bucket = bucketOf(Number(settings.quality));
      // Only pre-apply the default-quality filter when a source ACTUALLY matches it.
      // Otherwise a title that isn't available in that quality would show 0 sources
      // and never autoplay — the user had to notice and clear the filter by hand.
      if (allParsed.some((s) => s.bucket === bucket)) setActiveQ(new Set([bucket]));
    }
    didInitFilter.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links, settings.quality]);

  const prefLangs = settings.audioLanguages || [];
  const langRank = (a: string) => { const i = prefLangs.indexOf(a); return i < 0 ? 99 : i; };

  // Anime Sub/Dub audio preference → a rank for auto-play (0 = matches the pref).
  // Dub pref: an explicit dub source is best (0), a neutral source is meh (1), a
  // sub source is worst (2). Sub pref (the default): sub OR neutral is fine (0),
  // an explicit dub is worst (2) — so a neutral source like AniZone still plays
  // instantly for sub viewers instead of waiting for a "sub"-labelled one.
  const animePref = liveSettings.anime ?? "sub";
  const audioRank = (s: Parsed): number => {
    const hay = `${s.name || s.variant || ""} ${s.audio || ""}`;
    const dub = DUB_RE.test(hay), sub = SUB_RE.test(hay);
    return animePref === "dub" ? (dub ? 0 : sub ? 2 : 1) : ((sub || !dub) ? 0 : 2);
  };

  // group parsed links by provider
  const byProvider = useMemo(() => {
    const map = new Map<string, Parsed[]>();
    for (const l of links) {
      const arr = map.get(l.providerId) || [];
      arr.push(parse(l, runs[l.providerId]?.name || l.providerId));
      map.set(l.providerId, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => typeRank(a.type) - typeRank(b.type) || langRank(a.audio) - langRank(b.audio) || b.q - a.q);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [links, runs, prefLangs.join(",")]);

  const allParsed = useMemo(() => [...byProvider.values()].flat(), [byProvider]);
  const bucketsPresent = ["4K", "1080p", "720p", "SD"].filter((b) => allParsed.some((s) => s.bucket === b));
  const audiosPresent = [...new Set(allParsed.map((s) => s.audio).filter(Boolean))];
  const pass = (s: Parsed) => (!activeQ.size || activeQ.has(s.bucket)) && (!activeA.size || activeA.has(s.audio));

  // Stable, sequential order: providers stay in the fixed registration order they
  // are scanned in (no re-sorting by status/quality), so the list doesn't shuffle
  // as results stream in — you can watch each provider get checked in sequence.
  const providers = useMemo(() => {
    // Apply this kind's provider prefs: drop hidden ones, and sort pinned providers
    // to the top in the user's saved order (the rest keep registration/arrival order).
    const rank = (pid: string) => { const i = pref.order.indexOf(pid); return i >= 0 ? i : pref.order.length + order.indexOf(pid); };
    const visible = order.filter((pid) => !pref.hidden.includes(pid)).sort((a, b) => rank(a) - rank(b));
    return visible.map((pid) => {
      const run = runs[pid];
      const items = (byProvider.get(pid) || []).filter(pass);
      const best = items.reduce((m, s) => Math.max(m, s.q), 0);
      return { pid, run, items, best, state: run?.state || "pending" };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, runs, byProvider, activeQ, activeA, prefLangs.join(","), pref.order.join(","), pref.hidden.join(",")]);

  const onlineCount = providers.filter((p) => p.state === "found").length;
  const totalSources = allParsed.filter(pass).length;

  // keep an up-to-date ordered list of in-browser-playable sources (m3u8/mp4).
  // `providers` is already in the effective order (user pref → registration order,
  // anime providers first by default), so we just preserve that and push VLC/
  // external-only sources to the very end of the auto-play order.
  // External/VLC sources sink to the end; for anime, the Sub/Dub preference orders
  // ahead of provider priority (a stable sort keeps provider order within a tier),
  // so a dub-preferring viewer auto-plays a dub source even from a lower provider.
  playableRef.current = providers.flatMap((p) => p.items)
    .filter((s) => s.type === "m3u8" || s.type === "mp4")
    .sort((a, b) => Number(a.external) - Number(b.external) || (isAnime ? audioRank(a) - audioRank(b) : 0));

  function play(p: Parsed) {
    const ordered = [...subs].sort((a, b) => {
      const rank = (lang: string) => { const i = prefLangs.findIndex((l) => lang?.toLowerCase().includes(l.toLowerCase())); return i < 0 ? 99 : i; };
      return rank(a.lang) - rank(b.lang);
    });
    // Remember this provider for the kind so the next episode starts from it (sticky).
    if (kind && p.providerId && liveSettings.stickyProvider[kind] !== p.providerId) {
      updateSettings({ stickyProvider: { ...liveSettings.stickyProvider, [kind]: p.providerId } });
    }
    onPlay({ title: p.name || p.variant, url: p.url, type: p.type as PlayerSource["type"], provider: runs[p.providerId]?.name || p.providerId, subtitles: ordered }, ordered);
  }

  // auto-play the first playable source once (respects the Autoplay setting).
  // For anime we hold the autoplay for the primary providers: play the first
  // primary source as soon as it resolves (AniZone is ~1-2s), and only fall back
  // to a generic source once every primary provider has finished/failed — so a
  // fast movie provider can't grab the player ahead of the anime sources.
  useEffect(() => {
    if (autostarted.current || !settings.autoplay) return;
    const notFailed = (s: Parsed) => !failed.has(s.url);
    // 1) Sticky: resume from the provider used last for this kind. If it has a source
    //    now, play it; if it's still resolving, wait for it before falling back.
    if (sticky && !pref.hidden.includes(sticky)) {
      const st = playableRef.current.find((s) => s.providerId === sticky && notFailed(s));
      if (st) { autostarted.current = true; play(st); return; }
      if (order.includes(sticky) && !isTerminal(runs[sticky]?.state)) return;
    }
    // 2) Anime: honour the Sub/Dub preference. Play the first anime source that
    //    MATCHES the preference as soon as it resolves; if none matches yet, wait
    //    for the still-pending anime providers (one may bring the preferred audio —
    //    e.g. AniNeko's DUB arrives a few seconds after AniZone's sub). Only once
    //    every anime provider has settled do we play the best available (pref-sorted)
    //    anime source, so a generic movie provider never grabs the player first.
    if (isAnime) {
      const animeAvail = playableRef.current.filter((s) => ANIME_PROVIDERS.has(s.providerId) && notFailed(s));
      const prefMatch = animeAvail.find((s) => audioRank(s) === 0);
      if (prefMatch) { autostarted.current = true; play(prefMatch); return; }
      const animeIds = order.filter((pid) => ANIME_PROVIDERS.has(pid) && !pref.hidden.includes(pid));
      const stillPending = animeIds.some((pid) => !isTerminal(runs[pid]?.state));
      if (animeIds.length && stillPending) return;
      if (animeAvail.length) { autostarted.current = true; play(animeAvail[0]); return; }
    }
    const first = playableRef.current.find(notFailed);
    if (first) { autostarted.current = true; play(first); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  // a source failed in the player → remember it and advance to the NEXT playable
  // source *after* it in list order (not back to the top / last working one)
  useEffect(() => {
    if (!failedUrl) return;
    // Keep the state updater PURE — advancing the player is a side effect and must
    // not live inside setState (React StrictMode double-invokes updaters in dev,
    // which would advance two sources at once and double-write sticky-provider prefs).
    const next = new Set(failed); next.add(failedUrl);
    setFailed(next);
    const list = playableRef.current;
    const idx = list.findIndex((s) => s.url === failedUrl);
    // Next non-failed source after the one that failed; wrap to earlier ones as a
    // last resort. Self-terminates once every source has failed (each URL is added
    // to `next` exactly once, and candidates must be absent from `next`).
    const candidate = list.slice(idx + 1).find((s) => !next.has(s.url)) || list.find((s) => !next.has(s.url));
    if (candidate) play(candidate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedUrl, failSeq]);

  const toggle = (set: Set<string>, val: string, setter: (s: Set<string>) => void) => {
    const n = new Set(set); n.has(val) ? n.delete(val) : n.add(val); setter(n);
  };

  return (
    <div className="sources-rail">
      <div className="rail-head">
        <h3>Sources</h3>
        <span className={`badge ${done ? "" : "badge-warning"}`}>
          {done ? `${onlineCount} online · ${totalSources} sources` : <><span className="spin" style={{ width: 12, height: 12, marginRight: 6, verticalAlign: -1 }} /> scanning {providers.length}…</>}
        </span>
        <button
          className={`btn btn-icon btn-ghost btn-sm ${liveSettings.torrentMode ? "active" : ""}`}
          title={liveSettings.torrentMode ? "Torrent mode ON (this device) — click to use the normal providers" : "Torrent mode OFF — click to resolve via torrents (anime, movies & TV). This device only."}
          aria-label="Toggle torrent mode"
          aria-pressed={!!liveSettings.torrentMode}
          onClick={() => updateSettings({ torrentMode: !liveSettings.torrentMode })}
        ><Zap size={15} /></button>
        <button
          className="btn btn-icon btn-ghost btn-sm"
          title="Hard refresh — re-scan every provider from scratch (skips the cache)"
          aria-label="Refresh all sources"
          onClick={refreshAll}
          disabled={!done}
        ><RotateCcw size={15} /></button>
        <button className="btn btn-icon btn-ghost btn-sm" title="Edit providers for this kind" aria-label="Edit providers" onClick={() => setEditorOpen(true)}><SlidersHorizontal size={15} /></button>
      </div>

      {(bucketsPresent.length > 1 || audiosPresent.length > 0) && (
        <div className="src-filters">
          {bucketsPresent.map((b) => (
            <button key={b} className={`fchip ${activeQ.has(b) ? "on" : ""}`} onClick={() => toggle(activeQ, b, setActiveQ)}>{b} <span className="n">{allParsed.filter((s) => s.bucket === b).length}</span></button>
          ))}
          {audiosPresent.map((a) => (
            <button key={a} className={`fchip ${activeA.has(a) ? "on" : ""}`} onClick={() => toggle(activeA, a, setActiveA)}>{a} <span className="n">{allParsed.filter((s) => s.audio === a).length}</span></button>
          ))}
        </div>
      )}

      <div className="rail-list">
        {providers.length === 0 && <div className="empty" style={{ padding: "var(--space-8) 0" }}>Starting scan…</div>}

        {/* providers that returned sources → expandable cards */}
        {providers.filter((p) => p.items.length).map(({ pid, run, items, best }) => {
          const playingHere = items.some((s) => s.url === currentUrl);
          const open = collapsed[pid] === undefined ? true : !collapsed[pid];
          return (
            <div className={`src-group ${open ? "open" : ""} ${playingHere ? "has-playing" : ""}`} key={pid}>
              <button className="group-head" onClick={() => setCollapsed((m) => ({ ...m, [pid]: open }))}>
                <StatusDot state="found" />
                <span className="pname">{run?.name || pid}</span>
                <span className="pcount">{items.length}</span>
                <span className={`pbest ${best >= 720 ? "" : "sd"}`}>{bucketOf(best)}</span>
                <ChevronRight size={14} className="chev" />
              </button>
              <div className="group-body">
                {(() => { const seen: Record<string, number> = {}; return items.map((s, i) => {
                  const dupCount = items.filter((x) => x.variant === s.variant).length;
                  let label = s.variant;
                  if (dupCount > 1) { seen[s.variant] = (seen[s.variant] || 0) + 1; label = `${s.variant} (${seen[s.variant]})`; }
                  return (
                  <div
                    className={`srow ${s.url === currentUrl ? "playing" : ""} ${failed.has(s.url) ? "failed" : ""}`}
                    key={s.url}
                    role="button"
                    tabIndex={0}
                    onClick={() => play(s)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); play(s); } }}
                  >
                    <span className="led" />
                    <span className="sname">{label}</span>
                    <span className="tags">
                      {s.external && <span className="tag ext" title="Made for an external player (VLC) — copy the link to open it there">VLC</span>}
                      {s.q > 0 && <span className={`tag ${s.q >= 720 ? "hd" : ""}`}>{s.q}p</span>}
                      {s.audio && <span className="tag audio">{s.audio}</span>}
                      <span className="tag fmt">{(s.type || "").toUpperCase()}</span>
                      <button
                        className="srow-copy"
                        title="Open / copy link (VLC & external players)"
                        aria-label="Link options"
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          setLinkMenu((m) => (m?.url === s.url ? null : { url: s.url, top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) }));
                        }}
                      >
                        {copied === s.url ? <Check size={13} /> : <Copy size={13} />}
                      </button>
                    </span>
                  </div>
                  );
                }); })()}
              </div>
            </div>
          );
        })}

        {(() => {
          const scanning = providers.filter((p) => !p.items.length && (p.state === "running" || p.state === "pending"));
          if (!scanning.length) return null;
          return (
            <div className="pstat scanning">
              <span className="spin" style={{ width: 12, height: 12, marginRight: 8, verticalAlign: -1 }} />
              Checking {scanning.length} more provider{scanning.length === 1 ? "" : "s"}…
            </div>
          );
        })()}

        {/* Failed / timed-out providers — shown with a reason so you can see WHY a
            provider produced nothing (e.g. "timed out after 45s") instead of it
            silently disappearing. Empty (no-source-for-this-title) ones collapse to a count. */}
        {(() => {
          const failedList = providers.filter((p) => !p.items.length && p.state === "failed");
          const emptyList = providers.filter((p) => !p.items.length && p.state === "empty");
          if (!failedList.length && !emptyList.length) return null;
          return (
            <div className="pstat-group">
              <button className="btn btn-sm btn-ghost" style={{ alignSelf: "flex-start" }} onClick={refreshFailed} disabled={!done} title="Re-scan only the providers that found nothing">
                <RotateCcw size={13} /> Retry {failedList.length + emptyList.length} unavailable
              </button>
              {failedList.map(({ pid, run }) => (
                <div className="pstat unavail" key={pid} title={run?.note || "failed"}>
                  <StatusDot state="failed" />
                  <span className="pname-sm">{run?.name || pid}</span>
                  <span className="subtle unavail-note">{run?.note || "failed"}</span>
                </div>
              ))}
              {emptyList.length > 0 && (
                <button className="pstat unavail-toggle" onClick={() => setShowEmpty((v) => !v)}>
                  <StatusDot state="empty" />
                  {emptyList.length} provider{emptyList.length === 1 ? "" : "s"} had no source for this title
                  <ChevronRight size={13} className="chev" style={{ transform: showEmpty ? "rotate(90deg)" : undefined }} />
                </button>
              )}
              {showEmpty && emptyList.map(({ pid, run }) => (
                <div className="pstat unavail dim" key={pid}>
                  <StatusDot state="empty" />
                  <span className="pname-sm">{run?.name || pid}</span>
                  <span className="subtle unavail-note">no sources</span>
                </div>
              ))}
            </div>
          );
        })()}
      </div>

      {linkMenu && (
        <div className="menu link-menu" style={{ position: "fixed", top: linkMenu.top, right: linkMenu.right }} onClick={(e) => e.stopPropagation()}>
          <div className="menu-label">Stream link</div>
          <a className="menu-item" href={`vlc://${originalUrl(linkMenu.url)}`}>Open in VLC</a>
          <a className="menu-item" href={originalUrl(linkMenu.url)} target="_blank" rel="noopener noreferrer">Open in new tab</a>
          <button className="menu-item" onClick={() => { copyText(originalUrl(linkMenu.url)); setCopied(linkMenu.url); setTimeout(() => setCopied((c) => (c === linkMenu.url ? null : c)), 1500); setLinkMenu(null); }}>Copy link</button>
        </div>
      )}

      {editorOpen && <ProviderPrefsEditor kind={kind} onClose={() => setEditorOpen(false)} />}
    </div>
  );
}
