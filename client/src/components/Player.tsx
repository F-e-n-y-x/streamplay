import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { getSettings } from "../lib/settings";
import { copyText } from "../lib/clipboard";
import { Check, Copy, ExternalLink, Maximize, Pause, Play, RotateCcw, Settings, Subtitles, Volume2, VolumeX, X } from "./icons";

/** ISO/short language code → display name for the audio menu. */
const LANG_NAMES: Record<string, string> = {
  ja: "Japanese", jpn: "Japanese", en: "English", eng: "English", hi: "Hindi", hin: "Hindi",
  ta: "Tamil", tam: "Tamil", te: "Telugu", tel: "Telugu", ml: "Malayalam", mal: "Malayalam",
  kn: "Kannada", kan: "Kannada", ko: "Korean", kor: "Korean", zh: "Chinese", zho: "Chinese",
  fr: "French", fra: "French", es: "Spanish", spa: "Spanish", de: "German", deu: "German",
  it: "Italian", ita: "Italian", pt: "Portuguese", ru: "Russian", ar: "Arabic", bn: "Bengali",
  mr: "Marathi", pa: "Punjabi", ur: "Urdu", th: "Thai", id: "Indonesian", vi: "Vietnamese", und: "Original",
};
const langName = (code: string) => LANG_NAMES[(code || "").toLowerCase()] || (code ? code.toUpperCase() : "Original");

export interface PlayerSource {
  title: string;
  url: string;
  type: "youtube" | "m3u8" | "mp4" | "iframe";
  /** Provider name (for history). */
  provider?: string;
  /** Subtitle tracks (already proxied to .vtt by the backend). */
  subtitles?: { lang: string; url: string }[];
}

/** Overlay modal player — used for trailers (YouTube) and iframe embeds. */
export default function Player({ source, onClose }: { source: PlayerSource; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const ytId = (u: string) => (u.match(/[?&]v=([^&]+)/) || u.match(/youtu\.be\/([^?]+)/) || [, u])[1];

  return (
    <div className="player-overlay" onClick={onClose}>
      <div className="player" onClick={(e) => e.stopPropagation()}>
        <div className="topbar">
          <span className="title">{source.title}</span>
          <button className="btn btn-sm" onClick={onClose}><X size={16} /> Close</button>
        </div>
        {source.type === "youtube" ? (
          <div className="frame">
            <iframe
              src={`https://www.youtube.com/embed/${ytId(source.url)}?autoplay=1`}
              title={source.title}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
            />
          </div>
        ) : source.type === "iframe" ? (
          <div className="frame"><EmbedFrame source={source} /></div>
        ) : (
          <VideoPlayer source={source} />
        )}
      </div>
    </div>
  );
}

export function EmbedFrame({ source }: { source: PlayerSource }) {
  return (
    <iframe
      src={source.url}
      title={source.title}
      referrerPolicy="origin"
      allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
      allowFullScreen
      style={{ width: "100%", height: "100%", border: 0, display: "block", background: "#000" }}
    />
  );
}

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Custom-skinned HTML5 player for mp4/m3u8 sources. Embeddable (used inline on the
 * Watch page). Handles the autoplay-with-sound block by falling back to muted
 * autoplay and offering a one-click unmute — never surfaces that as an "error".
 */
export function VideoPlayer({ source, embedded, onFail, resumeAt, onProgress }: { source: PlayerSource; embedded?: boolean; onFail?: () => void; resumeAt?: number; onProgress?: (position: number, duration: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const shakaRef = useRef<any>(null);
  const engineRef = useRef<"shaka" | "hls" | "native">("native");
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const autostarted = useRef(false);
  const resumed = useRef(false);
  const lastSaved = useRef(0);

  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showControls, setShowControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const [ccIndex, setCcIndex] = useState(-1);
  const [autoMuted, setAutoMuted] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState("");
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [levels, setLevels] = useState<{ index: number; height: number; bitrate: number }[]>([]);
  const [curLevel, setCurLevel] = useState(-1); // -1 = Auto
  const [audioTracks, setAudioTracks] = useState<{ id: number; label: string }[]>([]);
  const [curAudio, setCurAudio] = useState(-1);
  // Audio renditions parsed from the manifest (used when hls.js doesn't expose them).
  const [manifestAudios, setManifestAudios] = useState<{ name: string; lang: string }[]>([]);
  const [curMAudio, setCurMAudio] = useState("");
  const pendingSeek = useRef<number | null>(null);

  const tracks = source.subtitles ?? [];
  const prefLangs = (getSettings() as unknown as { audioLanguages?: string[] }).audioLanguages ?? [];
  const animeTrack = (getSettings() as unknown as { anime?: "sub" | "dub" }).anime ?? "sub";
  const wantAutoplay = (getSettings() as unknown as { autoplay?: boolean }).autoplay ?? true;

  // start (or autoplay) the current video, with muted fallback for blocked autoplay
  const start = useCallback(() => {
    const el = video.current;
    if (!el) return;
    el.play().catch(() => {
      // autoplay-with-sound blocked → retry muted (always allowed), offer unmute
      el.muted = true;
      setMuted(true);
      setAutoMuted(true);
      el.play().catch(() => { /* leave paused; user can press play */ });
    });
  }, []);

  // Attach the source. Engine priority for HLS: Shaka (broad codecs + reliable
  // audio-track APIs) → hls.js → native. Plain mp4 plays natively.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    setError(null); setLoading(true); autostarted.current = false;
    setLevels([]); setAudioTracks([]); setCurLevel(-1); setCurAudio(-1);
    setManifestAudios([]); setCurMAudio("");

    let cancelled = false;
    let cleanup = () => { /* replaced by the active engine */ };

    // Preferred audio: anime Sub/Dub first, then the preferred-language list.
    const autoPick = (langs: { name: string; lang: string }[]) => {
      if (langs.length <= 1) return undefined;
      const has = (re: RegExp) => langs.find((a) => re.test(a.name) || re.test(a.lang));
      const jp = has(/\b(jp|jpn|japanese)\b/i);
      const want = jp ? (animeTrack === "dub" ? has(/\b(en|eng|english)\b/i) : jp) : undefined;
      if (want) return want;
      if (prefLangs.length) return langs.find((a) => prefLangs.some((p) => `${a.name} ${a.lang}`.toLowerCase().includes(p.toLowerCase())));
      return undefined;
    };

    // ── native (iOS Safari / mp4) ──
    const startNative = () => {
      engineRef.current = "native";
      el.src = source.url;
      const nativeAudio = () => {
        const nat = (el as unknown as { audioTracks?: { length: number; [i: number]: { label?: string; language?: string; enabled: boolean } } }).audioTracks;
        if (!nat || nat.length <= 1) return;
        const at = Array.from({ length: nat.length }, (_v, i) => ({ id: i, label: nat[i].label || nat[i].language || `Track ${i + 1}` }));
        setAudioTracks(at);
        setCurAudio(Array.from({ length: nat.length }).findIndex((_v, i) => nat[i].enabled));
      };
      el.addEventListener("loadedmetadata", nativeAudio);
      cleanup = () => el.removeEventListener("loadedmetadata", nativeAudio);
    };

    // ── hls.js (fallback) — parses alt-audio from the manifest, switches via &audio= reload ──
    const startHls = () => {
      if (cancelled) return;
      if (!Hls.isSupported()) { startNative(); return; }
      engineRef.current = "hls";
      const inst = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 60, maxMaxBufferLength: 600, backBufferLength: 60, fragLoadingMaxRetry: 6, manifestLoadingMaxRetry: 4, levelLoadingMaxRetry: 4 });
      hls.current = inst;
      const syncAudio = () => {
        const at = inst.audioTracks.map((t) => ({ id: t.id, label: t.name || t.lang || `Track ${t.id + 1}` }));
        setAudioTracks(at); setCurAudio(inst.audioTrack);
      };
      inst.attachMedia(el);
      fetch(source.url).then((r) => r.text()).then((txt) => {
        const list = [...txt.matchAll(/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*/gi)].map((mm) => {
          const line = mm[0];
          const name = /NAME="([^"]+)"/.exec(line)?.[1];
          const lang = /LANGUAGE="([^"]+)"/.exec(line)?.[1] || "";
          return name ? { name, lang, def: /DEFAULT=YES/i.test(line) } : null;
        }).filter(Boolean) as { name: string; lang: string; def: boolean }[];
        setManifestAudios(list.map(({ name, lang }) => ({ name, lang })));
        let chosen = (list.find((a) => a.def) || list[0])?.name || "";
        let loadUrl = source.url;
        const want = autoPick(list);
        if (want && want.name !== chosen) {
          chosen = want.name;
          const base = source.url.replace(/[?&]$/, "");
          loadUrl = `${base}${base.includes("?") ? "&" : "?"}audio=${encodeURIComponent(want.name)}`;
        }
        setCurMAudio(chosen);
        inst.loadSource(loadUrl);
      }).catch(() => inst.loadSource(source.url));
      inst.on(Hls.Events.MANIFEST_PARSED, () => {
        const lv = inst.levels.map((l, index) => ({ index, height: l.height || 0, bitrate: l.bitrate || 0 })).filter((l) => l.height > 0).sort((a, b) => b.height - a.height);
        setLevels(lv); syncAudio();
        if (pendingSeek.current != null && el) { el.currentTime = pendingSeek.current; pendingSeek.current = null; start(); }
        else if (wantAutoplay && !autostarted.current) { autostarted.current = true; start(); }
      });
      inst.on(Hls.Events.AUDIO_TRACKS_UPDATED, syncAudio);
      inst.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_e, d) => setCurAudio(d.id));
      inst.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => setCurLevel(inst.autoLevelEnabled ? -1 : d.level));
      inst.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) { setError("This source failed to load."); onFail?.(); } });
      cleanup = () => { inst.destroy(); hls.current = null; };
    };

    // ── Shaka (primary) — exposes audio languages + qualities reliably ──
    const startShaka = async () => {
      try {
        // @ts-expect-error — shaka's compiled build ships non-ES-module typings
        const shakaMod: any = await import("shaka-player/dist/shaka-player.compiled.js");
        const shaka: any = shakaMod.default || shakaMod;
        if (cancelled) return;
        shaka.polyfill.installAll();
        if (!shaka.Player.isBrowserSupported()) throw new Error("shaka unsupported");
        const player = new shaka.Player();
        await player.attach(el);
        if (cancelled) { try { player.destroy(); } catch { /* */ } return; }
        shakaRef.current = player;
        engineRef.current = "shaka";
        player.configure({ streaming: { bufferingGoal: 60, rebufferingGoal: 2, retryParameters: { maxAttempts: 5, baseDelay: 500, backoffFactor: 2 } } });
        let fellBack = false;
        player.addEventListener("error", (ev: any) => {
          if (ev?.detail?.severity === 2 && !fellBack && !cancelled) { fellBack = true; try { player.destroy(); } catch { /* */ } shakaRef.current = null; startHls(); }
        });
        await player.load(source.url, (resumeAt && resumeAt > 5) ? resumeAt : undefined);
        if (cancelled) { try { player.destroy(); } catch { /* */ } return; }
        resumed.current = true;
        const variants: any[] = player.getVariantTracks?.() || [];
        const audios = (player.getAudioLanguages?.() || []).map((c: string) => ({ name: langName(c), lang: c }));
        setManifestAudios(audios);
        const active = variants.find((v) => v.active);
        let chosen = active ? langName(active.language) : (audios[0]?.name || "");
        const want = autoPick(audios);
        if (want && want.lang !== active?.language) { try { player.selectAudioLanguage(want.lang); } catch { /* */ } chosen = want.name; }
        setCurMAudio(chosen);
        const heights = [...new Set(variants.map((v) => v.height).filter(Boolean))].sort((a, b) => (b as number) - (a as number)) as number[];
        setLevels(heights.map((h, index) => ({ index, height: h, bitrate: 0 })));
        setCurLevel(-1);
        cleanup = () => { try { player.destroy(); } catch { /* */ } shakaRef.current = null; };
        if (wantAutoplay && !autostarted.current) { autostarted.current = true; start(); }
      } catch {
        if (!cancelled) startHls();
      }
    };

    if (source.type === "m3u8") startShaka();
    else startNative();

    return () => { cancelled = true; cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // Keep the active options tab scrolled into view so it's never clipped.
  useEffect(() => {
    if (sheetOpen) activeTabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [sheetOpen, sheetTab]);

  // Toggle the selected caption track.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const list = el.textTracks;
    for (let i = 0; i < list.length; i++) list[i].mode = i === ccIndex ? "showing" : "disabled";
  }, [ccIndex, source]);

  const togglePlay = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => { el.muted = true; setMuted(true); el.play().catch(() => {}); });
    else el.pause();
  }, []);

  const unmute = () => { const el = video.current; if (el) { el.muted = false; setMuted(false); } setAutoMuted(false); };

  const nudgeControls = useCallback(() => {
    setShowControls(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => { if (!video.current?.paused) setShowControls(false); }, 2600);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = video.current;
      if (!el) return;
      if (e.key === " " || e.key === "k") { e.preventDefault(); togglePlay(); }
      else if (e.key === "ArrowRight") el.currentTime = Math.min(el.duration, el.currentTime + 10);
      else if (e.key === "ArrowLeft") el.currentTime = Math.max(0, el.currentTime - 10);
      else if (e.key === "f") toggleFullscreen();
      else if (e.key === "m") el.muted = !el.muted;
      else if (e.key === "c" && tracks.length) setCcIndex((i) => (i < 0 ? 0 : -1));
      nudgeControls();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [togglePlay, nudgeControls, tracks.length]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else wrap.current?.requestFullscreen?.();
  }
  function pickQuality(index: number) {
    if (engineRef.current === "shaka" && shakaRef.current) {
      const p = shakaRef.current;
      try {
        if (index < 0) { p.configure({ abr: { enabled: true } }); }
        else {
          const height = levels.find((l) => l.index === index)?.height;
          p.configure({ abr: { enabled: false } });
          const vars = (p.getVariantTracks() || []) as any[];
          const active = vars.find((v) => v.active);
          const target = vars.filter((v) => v.height === height).find((v) => v.language === active?.language) || vars.find((v) => v.height === height);
          if (target) p.selectVariantTrack(target, true);
        }
      } catch { /* */ }
      setCurLevel(index);
      return;
    }
    const h = hls.current; if (!h) return; h.currentLevel = index; setCurLevel(index);
  }
  // Switch a manifest-declared audio rendition by reloading the master with our
  // proxy's &audio= (which re-defaults that track), resuming at the same position.
  function pickManifestAudio(name: string) {
    if (name === curMAudio) return;
    // Shaka switches audio in place, no reload.
    if (engineRef.current === "shaka" && shakaRef.current) {
      const a = manifestAudios.find((x) => x.name === name);
      if (a) { try { shakaRef.current.selectAudioLanguage(a.lang); } catch { /* */ } setCurMAudio(name); }
      return;
    }
    // hls.js: reload the master with our &audio= re-default, resuming position.
    const inst = hls.current; const el = video.current;
    if (!inst || !el) return;
    const base = source.url.replace(/([?&])audio=[^&]*/i, "$1").replace(/[?&]$/, "");
    const sep = base.includes("?") ? "&" : "?";
    pendingSeek.current = el.currentTime;
    setCurMAudio(name);
    inst.loadSource(`${base}${sep}audio=${encodeURIComponent(name)}`);
  }
  function pickAudio(id: number) {
    const h = hls.current;
    if (h) { h.audioTrack = id; setCurAudio(id); return; }
    // native HLS (iOS): toggle the AudioTrackList
    const nat = (video.current as unknown as { audioTracks?: { length: number; [i: number]: { enabled: boolean } } })?.audioTracks;
    if (nat) { for (let i = 0; i < nat.length; i++) nat[i].enabled = i === id; setCurAudio(id); }
  }

  const pct = duration ? (current / duration) * 100 : 0;
  const bufPct = duration ? (buffered / duration) * 100 : 0;
  // Tag anime audio tracks as SUB (Japanese) / DUB (English) when both exist.
  const animeAudio = audioTracks.some((t) => /\b(jp|jpn|japanese)\b/i.test(t.label))
    || manifestAudios.some((a) => /\b(jp|jpn|japanese)\b/i.test(a.name));
  const audioLabel = (label: string) => {
    if (!animeAudio) return label;
    if (/\b(jp|jpn|japanese)\b/i.test(label)) return `${label} · SUB`;
    if (/\b(en|eng|english)\b/i.test(label)) return `${label} · DUB`;
    return label;
  };
  const ccOn = ccIndex >= 0;
  // Absolute URL of the (proxied) stream — plays in VLC with headers already injected.
  const streamAbs = source.url.startsWith("/") ? `${location.origin}${source.url}` : source.url;
  const copyStream = () => { copyText(streamAbs).then((ok) => { if (ok) { setCopiedUrl(true); setTimeout(() => setCopiedUrl(false), 1500); } }); };
  // Audio is ALWAYS a tab. Quality/Subtitles show when present. VLC always.
  const sheetTabs = [
    { id: "audio", label: "Audio" },
    ...(levels.length > 1 ? [{ id: "quality", label: "Quality" }] : []),
    ...(tracks.length > 0 ? [{ id: "subs", label: "Subtitles" }] : []),
    { id: "vlc", label: "VLC" },
  ];
  const activeTab = sheetTabs.some((t) => t.id === sheetTab) ? sheetTab : sheetTabs[0].id;

  return (
    <div
      ref={wrap}
      className={`vp ${embedded ? "embedded" : ""} ${showControls ? "show" : ""} ${playing ? "" : "paused"} ${fullscreen ? "fs" : ""}`}
      onMouseMove={nudgeControls}
      onPointerDown={nudgeControls}
      onMouseLeave={() => playing && setShowControls(false)}
    >
      <video
        ref={video}
        playsInline
        crossOrigin="anonymous"
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onPlay={() => { setPlaying(true); setEnded(false); nudgeControls(); }}
        onPause={() => { setPlaying(false); setShowControls(true); const el = video.current; if (onProgress && el && el.duration > 0) onProgress(el.currentTime, el.duration); }}
        onWaiting={() => setLoading(true)}
        onPlaying={() => setLoading(false)}
        onCanPlay={() => { setLoading(false); if (wantAutoplay && !autostarted.current && engineRef.current === "native") { autostarted.current = true; start(); } }}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget; setDuration(el.duration);
          if (!resumed.current && resumeAt && resumeAt > 5 && resumeAt < el.duration - 5) { el.currentTime = resumeAt; }
          resumed.current = true;
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget; setCurrent(el.currentTime);
          try { if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1)); } catch { /* noop */ }
          if (onProgress && el.duration > 0 && Date.now() - lastSaved.current > 8000) { lastSaved.current = Date.now(); onProgress(el.currentTime, el.duration); }
        }}
        onVolumeChange={(e) => { setVolume(e.currentTarget.volume); setMuted(e.currentTarget.muted); }}
        onEnded={() => { setPlaying(false); setEnded(true); setShowControls(true); }}
        onError={() => { setError("This source could not be played in the browser."); onFail?.(); }}
      >
        {tracks.map((t, i) => (<track key={i} kind="subtitles" label={t.lang || `Track ${i + 1}`} srcLang="en" src={t.url} />))}
      </video>

      <span className="badge badge-pill">{source.type.toUpperCase()}</span>

      {autoMuted && playing && (
        <button className="unmute-pill" onClick={unmute}><VolumeX size={14} /> Muted — click to unmute</button>
      )}

      <div className="center">
        {error ? null : loading && !playing ? (
          <div className="spinner" />
        ) : !playing ? (
          <button aria-label={ended ? "Replay" : "Play"} onClick={togglePlay}>{ended ? <RotateCcw size={28} /> : <Play size={28} />}</button>
        ) : null}
      </div>

      {error && (
        <div className="vp-error">
          <div>
            <p>{error}</p>
            <p className="subtle" style={{ fontSize: "var(--text-sm)" }}>This host blocks playback — pick another source from the list.</p>
          </div>
        </div>
      )}

      <div className="controls" onClick={(e) => e.stopPropagation()}>
        <div className="seek">
          <div className="track">
            <div className="buffered" style={{ width: `${bufPct}%` }} />
            <div className="played" style={{ width: `${pct}%` }} />
            <div className="knob" style={{ left: `${pct}%` }} />
          </div>
          {/* transparent native range overlay = reliable tap + drag on touch & mouse */}
          <input
            className="seek-range"
            type="range"
            min={0}
            max={duration || 0}
            step="any"
            value={Number.isFinite(current) ? current : 0}
            onChange={(e) => { const t = Number(e.target.value); setCurrent(t); if (video.current) video.current.currentTime = t; }}
            aria-label="Seek"
          />
        </div>
        <div className="ctrlrow">
          <button aria-label={playing ? "Pause" : "Play"} onClick={togglePlay}>{playing ? <Pause size={20} /> : <Play size={20} />}</button>
          <button aria-label={muted ? "Unmute" : "Mute"} onClick={() => { if (video.current) video.current.muted = !video.current.muted; setAutoMuted(false); }}>{muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}</button>
          <input className="vol" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => { if (video.current) { video.current.volume = Number(e.target.value); video.current.muted = false; } }} aria-label="Volume" />
          <span className="time">{fmt(current)} / {fmt(duration)}</span>
          <span className="grow" />
          {tracks.length > 0 && (
            <button className={ccOn ? "active" : ""} aria-label="Toggle subtitles" aria-pressed={ccOn} onClick={() => setCcIndex((i) => (i < 0 ? 0 : -1))}><Subtitles size={20} /></button>
          )}
          <button aria-label="Audio, quality & subtitles" onClick={() => setSheetOpen(true)}><Settings size={20} /></button>
          <button aria-label="Fullscreen" onClick={toggleFullscreen}><Maximize size={20} /></button>
        </div>
      </div>

      {sheetOpen && (
        <>
          <div className="vp-scrim" onClick={() => setSheetOpen(false)} />
          <div className="vp-sheet" role="dialog" aria-label="Player options" onClick={(e) => e.stopPropagation()}>
            <div className="vp-sheet-head">
              <div className="vp-tabs">
                {sheetTabs.map((t) => (
                  <button key={t.id} ref={activeTab === t.id ? activeTabRef : undefined} className={`vp-tab ${activeTab === t.id ? "active" : ""}`} onClick={() => setSheetTab(t.id)}>{t.label}</button>
                ))}
              </div>
              <button className="vp-sheet-x" aria-label="Close" onClick={() => setSheetOpen(false)}><X size={18} /></button>
            </div>
            <div className="vp-sheet-body">
              {activeTab === "audio" && (
                <div className="vp-sec">
                  {audioTracks.length > 1 ? (
                    audioTracks.map((t) => (
                      <button key={t.id} className={`vp-opt ${curAudio === t.id ? "active" : ""}`} onClick={() => pickAudio(t.id)}>
                        <span>{audioLabel(t.label)}</span>{curAudio === t.id && <Check size={16} />}
                      </button>
                    ))
                  ) : manifestAudios.length > 1 ? (
                    manifestAudios.map((a) => (
                      <button key={a.name} className={`vp-opt ${curMAudio === a.name ? "active" : ""}`} onClick={() => pickManifestAudio(a.name)}>
                        <span>{audioLabel(a.name)}</span>{curMAudio === a.name && <Check size={16} />}
                      </button>
                    ))
                  ) : (
                    <>
                      <button className="vp-opt active"><span>{manifestAudios[0]?.name || audioTracks[0]?.label || "Default"}</span><Check size={16} /></button>
                      <div className="vp-hint">This stream has one selectable track. If VLC shows more audio, they're embedded (muxed) and can't be switched in a browser — open it in VLC (VLC tab) to access them all.</div>
                    </>
                  )}
                </div>
              )}
              {activeTab === "quality" && (
                <div className="vp-sec">
                  <button className={`vp-opt ${curLevel < 0 ? "active" : ""}`} onClick={() => pickQuality(-1)}><span>Auto</span>{curLevel < 0 && <Check size={16} />}</button>
                  {levels.map((l) => (
                    <button key={l.index} className={`vp-opt ${curLevel === l.index ? "active" : ""}`} onClick={() => pickQuality(l.index)}>
                      <span>{l.height}p</span>{curLevel === l.index && <Check size={16} />}
                    </button>
                  ))}
                </div>
              )}
              {activeTab === "subs" && (
                <div className="vp-sec">
                  <button className={`vp-opt ${ccIndex < 0 ? "active" : ""}`} onClick={() => setCcIndex(-1)}><span>Off</span>{ccIndex < 0 && <Check size={16} />}</button>
                  {tracks.map((t, i) => (
                    <button key={i} className={`vp-opt ${ccIndex === i ? "active" : ""}`} onClick={() => setCcIndex(i)}>
                      <span>{t.lang || `Track ${i + 1}`}</span>{ccIndex === i && <Check size={16} />}
                    </button>
                  ))}
                </div>
              )}
              {activeTab === "vlc" && (
                <div className="vp-sec">
                  <a className="vp-opt" href={`vlc://${streamAbs}`}><span>Open in VLC</span><ExternalLink size={16} /></a>
                  <button className="vp-opt" onClick={copyStream}><span>{copiedUrl ? "Copied!" : "Copy stream link"}</span>{copiedUrl ? <Check size={16} /> : <Copy size={16} />}</button>
                  <div className="vp-hint">VLC handles every audio track &amp; subtitle format natively — useful if a track won't switch here.</div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
