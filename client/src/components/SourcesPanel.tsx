import { useEffect, useMemo, useRef, useState } from "react";
import { sourcesStreamUrl } from "../lib/api";
import { getSettings } from "../lib/settings";
import type { ProviderRun, StreamLink, SubtitleTrack } from "../lib/types";
import type { PlayerSource } from "./Player";
import { Check, ChevronRight, Copy } from "./icons";

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
const STATE_RANK: Record<string, number> = { found: 0, running: 1, pending: 2, empty: 3, failed: 4, "circuit-broken": 5 };
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

export default function SourcesPanel({
  type, id, season, episode, onPlay, currentUrl, failedUrl,
}: {
  type: "movie" | "tv";
  id: number;
  season?: number;
  episode?: number;
  onPlay: (s: PlayerSource, subs: SubtitleTrack[]) => void;
  currentUrl: string | null;
  failedUrl?: string | null;
}) {
  const [order, setOrder] = useState<string[]>([]);
  const [runs, setRuns] = useState<Record<string, ProviderRun>>({});
  const [links, setLinks] = useState<StreamLink[]>([]);
  const [subs, setSubs] = useState<SubtitleTrack[]>([]);
  const [done, setDone] = useState(false);
  const [activeQ, setActiveQ] = useState<Set<string>>(new Set());
  const [activeA, setActiveA] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [linkMenu, setLinkMenu] = useState<{ url: string; top: number; right: number } | null>(null);

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

  // reset + open SSE whenever the target changes
  useEffect(() => {
    setOrder([]); setRuns({}); setLinks([]); setSubs([]); setDone(false);
    setActiveQ(new Set()); setActiveA(new Set()); setCollapsed({}); setFailed(new Set());
    autostarted.current = false; didInitFilter.current = false;

    const es = new EventSource(sourcesStreamUrl({ type, id, season, episode }));
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
    es.onerror = () => { setDone(true); es.close(); };
    return () => es.close();
  }, [type, id, season, episode]);

  // default quality filter from settings
  useEffect(() => {
    if (didInitFilter.current || !links.length) return;
    if (settings.quality && settings.quality !== "auto") setActiveQ(new Set([bucketOf(Number(settings.quality))]));
    didInitFilter.current = true;
  }, [links, settings.quality]);

  const prefLangs = settings.audioLanguages || [];
  const langRank = (a: string) => { const i = prefLangs.indexOf(a); return i < 0 ? 99 : i; };

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

  // provider order: found (best quality) → running → pending → empty → failed
  const providers = useMemo(() => {
    return order.map((pid) => {
      const run = runs[pid];
      const items = (byProvider.get(pid) || []).filter(pass);
      const best = items.reduce((m, s) => Math.max(m, s.q), 0);
      const hasPref = items.some((s) => langRank(s.audio) < 99);
      return { pid, run, items, best, hasPref, state: run?.state || "pending" };
    }).sort((a, b) =>
      (STATE_RANK[a.state] - STATE_RANK[b.state]) || (Number(b.hasPref) - Number(a.hasPref)) || (b.best - a.best) || (b.items.length - a.items.length),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, runs, byProvider, activeQ, activeA, prefLangs.join(",")]);

  const onlineCount = providers.filter((p) => p.state === "found").length;
  const totalSources = allParsed.filter(pass).length;

  // keep an up-to-date ordered list of in-browser-playable sources (m3u8/mp4),
  // with VLC/external-only sources pushed to the end of the auto-play order
  playableRef.current = providers.flatMap((p) => p.items)
    .filter((s) => s.type === "m3u8" || s.type === "mp4")
    .sort((a, b) => Number(a.external) - Number(b.external));

  function play(p: Parsed) {
    const ordered = [...subs].sort((a, b) => {
      const rank = (lang: string) => { const i = prefLangs.findIndex((l) => lang?.toLowerCase().includes(l.toLowerCase())); return i < 0 ? 99 : i; };
      return rank(a.lang) - rank(b.lang);
    });
    onPlay({ title: p.name || p.variant, url: p.url, type: p.type as PlayerSource["type"], provider: runs[p.providerId]?.name || p.providerId, subtitles: ordered }, ordered);
  }

  // auto-play the first playable source once (respects the Autoplay setting)
  useEffect(() => {
    if (autostarted.current || !settings.autoplay) return;
    const first = playableRef.current.find((s) => !failed.has(s.url));
    if (first) { autostarted.current = true; play(first); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  // a source failed in the player → remember it and auto-advance to the next playable one
  useEffect(() => {
    if (!failedUrl) return;
    setFailed((prev) => {
      const next = new Set(prev); next.add(failedUrl);
      if (next.size <= 8) {
        const candidate = playableRef.current.find((s) => !next.has(s.url));
        if (candidate) setTimeout(() => play(candidate), 0);
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedUrl]);

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
                    key={i}
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

        {/* providers still scanning or with no sources → compact status rows */}
        {providers.some((p) => !p.items.length) && (
          <>
            <div className="pstat-label">Other providers</div>
            {providers.filter((p) => !p.items.length).map(({ pid, run, state }) => (
              <div className="pstat" key={pid}>
                <StatusDot state={state} />
                <span className="pn">{run?.name || pid}</span>
                <span className="ps">{STATE_LABEL[state]}</span>
              </div>
            ))}
          </>
        )}
      </div>

      {subs.length > 0 && (
        <div className="rail-subs">
          <div className="block-label">Subtitles ({subs.length})</div>
          <div className="chips">
            {subs.slice(0, 40).map((s, i) => (<a className="badge" key={i} href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>{s.lang || "Sub"}</a>))}
          </div>
        </div>
      )}

      {linkMenu && (
        <div className="menu link-menu" style={{ position: "fixed", top: linkMenu.top, right: linkMenu.right }} onClick={(e) => e.stopPropagation()}>
          <div className="menu-label">Stream link</div>
          <a className="menu-item" href={`vlc://${originalUrl(linkMenu.url)}`}>Open in VLC</a>
          <a className="menu-item" href={originalUrl(linkMenu.url)} target="_blank" rel="noopener noreferrer">Open in new tab</a>
          <button className="menu-item" onClick={() => { navigator.clipboard.writeText(originalUrl(linkMenu.url)).catch(() => {}); setCopied(linkMenu.url); setTimeout(() => setCopied((c) => (c === linkMenu.url ? null : c)), 1500); setLinkMenu(null); }}>Copy link</button>
        </div>
      )}
    </div>
  );
}
