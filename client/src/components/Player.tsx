import { useCallback, useEffect, useRef, useState, type TouchEvent as RTouchEvent } from "react";
import Hls from "hls.js";
import { getSettings, useSettings, updateSettings } from "../lib/settings";
import { copyText } from "../lib/clipboard";
import type { SkipTimes } from "../lib/api";
import { Check, ChevronDown, ChevronUp, Copy, ExternalLink, Forward10, Maximize, MonitorPlay, Pause, Play, Rewind10, RotateCcw, Settings, Subtitles, Users, Volume2, VolumeX, X, Zap } from "./icons";

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

// Reverse map (display name → BCP-47 code) so a subtitle <track> is labelled with
// the correct srcLang instead of a hardcoded "en" (matters for native track pickers
// and accessibility). Falls back to the raw code, or "und" (undetermined).
const NAME2CODE: Record<string, string> = {
  japanese: "ja", english: "en", hindi: "hi", tamil: "ta", telugu: "te", malayalam: "ml",
  kannada: "kn", korean: "ko", chinese: "zh", french: "fr", spanish: "es", german: "de",
  italian: "it", portuguese: "pt", russian: "ru", arabic: "ar", bengali: "bn", marathi: "mr",
  punjabi: "pa", urdu: "ur", thai: "th", indonesian: "id", vietnamese: "vi",
};
const subLangCode = (label: string): string => {
  const l = (label || "").toLowerCase().trim();
  if (/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(l)) return l;        // already a code (en, ja, pt-BR…)
  return NAME2CODE[l] || "und";
};

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

const fmtBytes = (n: number): string => {
  if (!n || n < 1024) return `${n | 0} B`;
  const u = ["KB", "MB", "GB", "TB"]; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
};

interface TStatus { active: boolean; name?: string; progress?: number; downloaded?: number; length?: number; downloadSpeed?: number; uploadSpeed?: number; numPeers?: number; ready?: boolean }

/**
 * Live torrent overlay (peers, ↓/↑ speed, progress) — only renders for a
 * /api/torrent stream. Polls /api/torrent/status while the torrent is downloading
 * and auto-hides once the file is complete so it doesn't clutter playback.
 */
function TorrentStats({ url }: { url: string }) {
  const [st, setSt] = useState<TStatus | null>(null);
  const magnet = (url.match(/[?&]magnet=([^&]+)/) || [])[1];
  const isTorrent = url.includes("/api/torrent/") && !!magnet;

  useEffect(() => {
    if (!isTorrent) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const r = await fetch(`/api/torrent/status?magnet=${magnet}`);
        const d: TStatus = await r.json();
        if (!alive) return;
        setSt(d);
        // Poll faster while downloading, back off once complete.
        const done = d.active && (d.progress ?? 0) >= 0.999;
        timer = window.setTimeout(tick, done ? 15000 : 2000);
      } catch { if (alive) timer = window.setTimeout(tick, 4000); }
    };
    tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [isTorrent, magnet]);

  if (!isTorrent || !st || !st.active) return null;
  const pct = Math.round((st.progress ?? 0) * 100);
  const complete = pct >= 100;
  return (
    <div className={`torrent-stats ${complete ? "done" : ""}`} title={st.name}>
      <span className="ts-peers"><Users size={12} /> {st.numPeers ?? 0}</span>
      {!complete && <span className="ts-dl"><ChevronDown size={12} /> {fmtBytes(st.downloadSpeed ?? 0)}/s</span>}
      <span className="ts-up"><ChevronUp size={12} /> {fmtBytes(st.uploadSpeed ?? 0)}/s</span>
      <span className={`ts-prog ${complete ? "ok" : ""}`}>{complete ? "Ready" : `${pct}%`}</span>
    </div>
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
export function VideoPlayer({ source, embedded, onFail, resumeAt, onProgress, skips, autoSkip, onEndedNext }: { source: PlayerSource; embedded?: boolean; onFail?: () => void; resumeAt?: number; onProgress?: (position: number, duration: number) => void; skips?: SkipTimes | null; autoSkip?: boolean; onEndedNext?: () => void }) {
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
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetTab, setSheetTab] = useState("");
  // Swipe-down-to-dismiss for the options bottom sheet (mobile).
  const [sheetDragY, setSheetDragY] = useState(0);
  const sheetTouchY = useRef<number | null>(null);
  const sheetBodyRef = useRef<HTMLDivElement>(null);
  const openSheet = () => { setSheetDragY(0); setSheetOpen(true); };
  const onSheetTouchStart = (e: RTouchEvent) => { sheetTouchY.current = e.touches[0].clientY; };
  const onSheetTouchMove = (e: RTouchEvent) => {
    if (sheetTouchY.current == null) return;
    const dy = e.touches[0].clientY - sheetTouchY.current;
    // Drag-to-close only when pulling DOWN and the list is scrolled to the top — so the
    // options list still scrolls normally, but a downward drag from the handle/top closes.
    if (dy > 0 && (sheetBodyRef.current?.scrollTop ?? 0) <= 0) setSheetDragY(dy);
  };
  const onSheetTouchEnd = () => {
    if (sheetDragY > 90) setSheetOpen(false);  // dragged far enough → close
    setSheetDragY(0);
    sheetTouchY.current = null;
  };
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [levels, setLevels] = useState<{ index: number; height: number; bitrate: number }[]>([]);
  const [curLevel, setCurLevel] = useState(-1); // -1 = Auto
  const [audioTracks, setAudioTracks] = useState<{ id: number; label: string }[]>([]);
  const [curAudio, setCurAudio] = useState(-1);
  // Audio renditions parsed from the manifest (used when hls.js doesn't expose them).
  const [manifestAudios, setManifestAudios] = useState<{ name: string; lang: string }[]>([]);
  const [curMAudio, setCurMAudio] = useState("");
  const pendingSeek = useRef<number | null>(null);
  // AniSkip: which OP/ED interval (if any) the playhead is currently inside, and a
  // per-episode record of intervals already auto-skipped (so we skip each once).
  const [activeSkip, setActiveSkip] = useState<{ label: string; end: number } | null>(null);
  const [skipToast, setSkipToast] = useState<string | null>(null);
  const skipToastTimer = useRef<number | undefined>(undefined);
  const autoSkipped = useRef<Set<string>>(new Set());
  const flashSkip = useCallback((msg: string) => {
    setSkipToast(msg);
    window.clearTimeout(skipToastTimer.current);
    skipToastTimer.current = window.setTimeout(() => setSkipToast(null), 2500);
  }, []);
  useEffect(() => { autoSkipped.current = new Set(); setActiveSkip(null); setSkipToast(null); }, [source]);

  const S = useSettings();   // live: subtitle appearance + voice boost (device-local)
  // Subtitle appearance (applied to native ::cue + shaka-rendered cues).
  const SUB_SIZE_PCT: Record<string, number> = { sm: 80, md: 100, lg: 135, xl: 175 };
  const subCss = `.vp video::cue{color:${S.subtitleColor};background:rgba(0,0,0,${S.subtitleBgOpacity});font-size:${SUB_SIZE_PCT[S.subtitleSize] ?? 100}%}`
    + `.vp .shaka-text-container span,.vp .shaka-text-container div{color:${S.subtitleColor}!important;background:rgba(0,0,0,${S.subtitleBgOpacity})!important}`;

  // ── Playback speed: PER-VIDEO (not a synced setting — it depends on what you're
  //    watching). Resets to 1× on each new source; adjusted with the +/- stepper. ──
  const [rate, setRate] = useState(1);
  useEffect(() => { setRate(1); }, [source]);
  useEffect(() => { if (video.current) video.current.playbackRate = rate; }, [rate]);
  const bumpRate = (d: number) => setRate((r) => Math.min(2, Math.max(0.25, Math.round((r + d) * 100) / 100)));

  const togglePip = async () => {
    const el = video.current; if (!el) return;
    try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await el.requestPictureInPicture(); } catch { /* unsupported / blocked */ }
  };

  // ── Voice / dialogue boost (Web Audio) — high-pass to trim rumble, a peaking boost
  //    around the 2.6 kHz speech band, and gentle compression to lift quiet dialogue
  //    under loud effects. Built lazily on a user gesture (createMediaElementSource can
  //    tap an element only once; the AudioContext persists and is reused per source). ──
  const va = useRef<{ ctx: AudioContext; el: HTMLVideoElement; hp: BiquadFilterNode; peak: BiquadFilterNode; comp: DynamicsCompressorNode } | null>(null);
  const applyBoost = useCallback((level: number) => {
    const a = va.current; if (!a) return;
    const gains = [0, 4, 7, 10];                 // dB lift at the speech band per level
    a.peak.gain.value = gains[level] ?? 0;
    a.hp.frequency.value = level > 0 ? 95 : 20;  // cut sub-bass rumble only when boosting
    a.comp.threshold.value = -18; a.comp.knee.value = 20; a.comp.attack.value = 0.003; a.comp.release.value = 0.25;
    a.comp.ratio.value = level > 0 ? 2 + level : 1;
    if (a.ctx.state === "suspended") a.ctx.resume().catch(() => { /* needs a gesture */ });
  }, []);
  const ensureVoiceGraph = useCallback(() => {
    const el = video.current; if (!el) return false;
    try {
      if (va.current && va.current.el === el) return true;     // already tapped this element
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = va.current?.ctx ?? new Ctx();                // reuse the context across sources
      const src = ctx.createMediaElementSource(el);
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 20;
      const peak = ctx.createBiquadFilter(); peak.type = "peaking"; peak.frequency.value = 2600; peak.Q.value = 1.1; peak.gain.value = 0;
      const comp = ctx.createDynamicsCompressor(); comp.ratio.value = 1;
      src.connect(hp); hp.connect(peak); peak.connect(comp); comp.connect(ctx.destination);
      va.current = { ctx, el, hp, peak, comp };
      return true;
    } catch { return false; }
  }, []);
  // Apply the saved boost when playback starts (a gesture, so the context can resume).
  const onPlayWireBoost = useCallback(() => { if ((S.voiceBoost || 0) > 0 && ensureVoiceGraph()) applyBoost(S.voiceBoost); }, [S.voiceBoost, ensureVoiceGraph, applyBoost]);
  const setBoost = (level: number) => { updateSettings({ voiceBoost: level }); if (level > 0) { if (ensureVoiceGraph()) applyBoost(level); } else applyBoost(0); };
  useEffect(() => () => { try { va.current?.ctx.close(); } catch { /* */ } }, []);

  const tracks = source.subtitles ?? [];
  const prefLangs = (getSettings() as unknown as { audioLanguages?: string[] }).audioLanguages ?? [];
  const animeTrack = (getSettings() as unknown as { anime?: "sub" | "dub" }).anime ?? "sub";
  const wantAutoplay = (getSettings() as unknown as { autoplay?: boolean }).autoplay ?? true;

  // ── Subtitle memory ── Remember the last subtitle language you chose (or "off") and
  // re-apply it on every video: if that language is in the menu it's auto-enabled; if
  // you turned subs off, they stay off. The preference is device-local (see settings).
  const prefTrackIndex = useCallback(() => {
    const p = (S.subtitlePref || "").toLowerCase();
    if (!p || p === "off") return -1;
    const exact = tracks.findIndex((t) => (t.lang || "").toLowerCase() === p);
    return exact >= 0 ? exact : tracks.findIndex((t) => (t.lang || "").toLowerCase().includes(p));
  }, [S.subtitlePref, tracks]);
  // choose a track AND remember it for future videos
  const chooseCc = useCallback((index: number) => {
    setCcIndex(index);
    updateSettings({ subtitlePref: index < 0 ? "off" : (tracks[index]?.lang || "off") });
  }, [tracks]);
  const toggleCc = () => chooseCc(ccIndex < 0 ? (prefTrackIndex() >= 0 ? prefTrackIndex() : 0) : -1);
  // apply the remembered preference whenever a new video's tracks arrive
  useEffect(() => { if (tracks.length) setCcIndex(prefTrackIndex()); /* eslint-disable-next-line */ }, [source, tracks.length]);

  // start (or autoplay) the current video, with muted fallback for blocked autoplay
  const start = useCallback(() => {
    const el = video.current;
    if (!el) return;
    // Never auto-mute. If the browser blocks autoplay-with-sound, just leave it paused —
    // the user presses play (a gesture) and gets sound. (Muting-to-autoplay was removed.)
    el.play().catch(() => { /* autoplay blocked — leave paused */ });
  }, []);

  // Attach the source. Engine priority for HLS: Shaka (broad codecs + reliable
  // audio-track APIs) → hls.js → native. Plain mp4 plays natively.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    setError(null); setLoading(true); autostarted.current = false; resumed.current = false;
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
      let hlsFellBack = false;
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
      inst.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        // Try to self-recover the common fatal errors before giving up.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { try { inst.startLoad(); return; } catch { /* */ } }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { try { inst.recoverMediaError(); return; } catch { /* */ } }
        // Otherwise hand the same source to Shaka (broader codec/DRM coverage).
        if (!hlsFellBack && !cancelled) { hlsFellBack = true; try { inst.destroy(); } catch { /* */ } hls.current = null; startShaka(); }
      });
      cleanup = () => { inst.destroy(); hls.current = null; };
    };

    // ── Shaka (fallback) — broad codec/DRM coverage + rich subtitle parsing ──
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
          if (ev?.detail?.severity === 2 && !fellBack && !cancelled) { fellBack = true; try { player.destroy(); } catch { /* */ } shakaRef.current = null; startNative(); }
        });
        await player.load(source.url, (resumeAt && resumeAt > 5) ? resumeAt : undefined);
        if (cancelled) { try { player.destroy(); } catch { /* */ } return; }
        resumed.current = true;
        const variants: any[] = player.getVariantTracks?.() || [];
        // Build the audio list from the master's EXT-X-MEDIA NAMEs — they're always
        // present and distinct even when the renditions share or omit LANGUAGE (the
        // Indian-dub masters do), which is what lets every dub show up AND switch.
        // Fall back to Shaka's language list if the parse yields nothing.
        let audios: { name: string; lang: string }[] = [];
        try {
          const txt = await (await fetch(source.url)).text();
          audios = ([...txt.matchAll(/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*/gi)].map((mm) => {
            const nm = /NAME="([^"]+)"/.exec(mm[0])?.[1];
            const lg = /LANGUAGE="([^"]+)"/.exec(mm[0])?.[1] || "";
            return nm ? { name: nm, lang: lg } : null;
          }).filter(Boolean)) as { name: string; lang: string }[];
        } catch { /* */ }
        if (audios.length < 2) {
          const sl = (player.getAudioLanguages?.() || []).map((c: string) => ({ name: langName(c), lang: c }));
          if (sl.length > audios.length) audios = sl;
        }
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
        if (!cancelled) startNative();
      }
    };

    // hls.js is the PRIMARY HLS engine: it enumerates alternate-audio renditions by
    // index/NAME (so dubs that lack a distinct LANGUAGE still show up and switch
    // seamlessly via hls.audioTrack), and has the best HLS coverage + error recovery.
    // Shaka is the fallback (broad codec/DRM + rich subtitles); native for mp4/iOS.
    if (source.type === "m3u8") startHls();
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
    // A click IS a user gesture, so sound is allowed — never force-mute here. (A rejected
    // play() is usually just an interrupted load/AbortError; muting on it was the bug that
    // made the video mute itself on click.)
    if (el.paused) el.play().catch(() => { /* interrupted — leave audio as-is */ });
    else el.pause();
  }, []);

  const seekBy = useCallback((delta: number) => {
    const el = video.current;
    if (!el) return;
    const dur = el.duration || duration;
    el.currentTime = Math.max(0, Math.min(dur || el.currentTime + delta, el.currentTime + delta));
    setCurrent(el.currentTime);
  }, [duration]);

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
    const onFs = () => setFullscreen(!!(document.fullscreenElement || (document as any).webkitFullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    return () => { document.removeEventListener("fullscreenchange", onFs); document.removeEventListener("webkitfullscreenchange", onFs); };
  }, []);

  function toggleFullscreen() {
    const el = wrap.current as any;
    const vid = video.current as any;
    const doc = document as any;
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      (document.exitFullscreen || doc.webkitExitFullscreen)?.call(document);
      return;
    }
    // Standard fullscreen on the wrapper; fall back to webkit, and finally to the VIDEO's
    // native fullscreen (iOS Safari only supports fullscreen on the <video> element).
    if (el?.requestFullscreen) el.requestFullscreen().catch(() => vid?.webkitEnterFullscreen?.());
    else if (el?.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else if (vid?.webkitEnterFullscreen) vid.webkitEnterFullscreen();
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
    if (engineRef.current === "shaka" && shakaRef.current) {
      const a = manifestAudios.find((x) => x.name === name);
      if (!a) return;
      // In-place switch works only when the track has a distinct, non-empty
      // LANGUAGE. Otherwise (Indian-dub renditions that share/omit LANGUAGE) reload
      // the master through the proxy's &audio= re-default, resuming the position.
      const langs = manifestAudios.map((x) => x.lang);
      const canSelectByLang = !!a.lang && langs.filter((l) => l === a.lang).length === 1;
      if (canSelectByLang) { try { shakaRef.current.selectAudioLanguage(a.lang); } catch { /* */ } setCurMAudio(name); return; }
      const el = video.current;
      const base = source.url.replace(/([?&])audio=[^&]*/i, "$1").replace(/[?&]$/, "");
      const sep = base.includes("?") ? "&" : "?";
      const pos = el?.currentTime || 0;
      setCurMAudio(name);
      shakaRef.current.load(`${base}${sep}audio=${encodeURIComponent(name)}`, pos > 5 ? pos : undefined).then(() => start()).catch(() => { /* */ });
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
  // Audio is ALWAYS a tab. Quality/Subtitles show when present.
  const sheetTabs = [
    { id: "playback", label: "Playback" },
    { id: "audio", label: "Audio" },
    ...(levels.length > 1 ? [{ id: "quality", label: "Quality" }] : []),
    ...(tracks.length > 0 ? [{ id: "subs", label: "Subtitles" }] : []),
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
        onPlay={() => { setPlaying(true); setEnded(false); nudgeControls(); onPlayWireBoost(); }}
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
          const el = e.currentTarget; const t = el.currentTime; setCurrent(t);
          try { if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1)); } catch { /* noop */ }
          if (onProgress && el.duration > 0 && Date.now() - lastSaved.current > 8000) { lastSaved.current = Date.now(); onProgress(t, el.duration); }
          // AniSkip: detect OP/ED window; show the Skip button and (if enabled) auto-skip once.
          if (skips) {
            const inIv = (iv: { start: number; end: number } | null) => iv && t >= iv.start && t < iv.end - 0.3;
            const hit = inIv(skips.opening) ? { key: "op", label: "Skip Opening", end: skips.opening!.end }
              : inIv(skips.ending) ? { key: "ed", label: "Skip Ending", end: skips.ending!.end } : null;
            if (hit) {
              if (autoSkip && !autoSkipped.current.has(hit.key)) { autoSkipped.current.add(hit.key); el.currentTime = hit.end; setActiveSkip(null); flashSkip(hit.key === "op" ? "Opening skipped" : "Ending skipped"); }
              else if (!autoSkip) setActiveSkip({ label: hit.label, end: hit.end });
            } else if (activeSkip) setActiveSkip(null);
          }
        }}
        onVolumeChange={(e) => { setVolume(e.currentTarget.volume); setMuted(e.currentTarget.muted); }}
        onEnded={() => { setPlaying(false); setEnded(true); setShowControls(true); if (onProgress && video.current?.duration) onProgress(video.current.duration, video.current.duration); onEndedNext?.(); }}
        onError={() => { setError("This source could not be played in the browser."); onFail?.(); }}
      >
        {tracks.map((t, i) => (<track key={i} kind="subtitles" label={t.lang || `Track ${i + 1}`} srcLang={subLangCode(t.lang)} src={t.url} />))}
      </video>
      {/* user subtitle appearance (Settings → Appearance) applied to native + shaka cues */}
      <style>{subCss}</style>

      <span className="badge badge-pill">{source.type.toUpperCase()}</span>

      <TorrentStats url={source.url} />

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

      {activeSkip && (
        <button
          className="skip-btn"
          onClick={(e) => { e.stopPropagation(); if (video.current) video.current.currentTime = activeSkip.end; flashSkip(activeSkip.label.replace(/^Skip /, "") + " skipped"); setActiveSkip(null); }}
        >
          <Zap size={15} /> {activeSkip.label}
        </button>
      )}

      {skipToast && <div className="skip-toast"><Zap size={13} /> {skipToast}</div>}

      <div className="controls" onClick={(e) => e.stopPropagation()}>
        <div className="seek">
          <div className="track">
            <div className="buffered" style={{ width: `${bufPct}%` }} />
            {/* AniSkip OP/ED markers — coloured so you can see where the opening/ending are */}
            {skips?.opening && duration > 0 && (
              <div className="skip-seg op" title="Opening" style={{ left: `${(skips.opening.start / duration) * 100}%`, width: `${((skips.opening.end - skips.opening.start) / duration) * 100}%` }} />
            )}
            {skips?.ending && duration > 0 && (
              <div className="skip-seg ed" title="Ending" style={{ left: `${(skips.ending.start / duration) * 100}%`, width: `${((skips.ending.end - skips.ending.start) / duration) * 100}%` }} />
            )}
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
          <button aria-label="Back 10 seconds" title="Back 10s (←)" onClick={() => seekBy(-10)}><Rewind10 size={20} /></button>
          <button aria-label={playing ? "Pause" : "Play"} onClick={togglePlay}>{playing ? <Pause size={20} /> : <Play size={20} />}</button>
          <button aria-label="Forward 10 seconds" title="Forward 10s (→)" onClick={() => seekBy(10)}><Forward10 size={20} /></button>
          <button className="mute-btn" aria-label={muted ? "Unmute" : "Mute"} onClick={() => { if (video.current) video.current.muted = !video.current.muted; }}>{muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}</button>
          <input className="vol" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => { if (video.current) { video.current.volume = Number(e.target.value); video.current.muted = false; } }} aria-label="Volume" />
          <span className="time">{fmt(current)} / {fmt(duration)}</span>
          <span className="grow" />
          {tracks.length > 0 && (
            <button className={ccOn ? "active" : ""} aria-label="Toggle subtitles" aria-pressed={ccOn} onClick={() => toggleCc()}><Subtitles size={20} /></button>
          )}
          {document.pictureInPictureEnabled && (
            <button className="pip-btn pbar-desktop" aria-label="Picture in picture" title="Picture-in-picture" onClick={togglePip}><MonitorPlay size={20} /></button>
          )}
          <button aria-label="Speed, audio, quality & subtitles" onClick={openSheet}><Settings size={20} /></button>
          <button aria-label="Fullscreen" onClick={toggleFullscreen}><Maximize size={20} /></button>
        </div>
      </div>

      {sheetOpen && (
        <>
          <div className="vp-scrim" onClick={() => setSheetOpen(false)} />
          <div
            className="vp-sheet"
            role="dialog"
            aria-label="Player options"
            onClick={(e) => e.stopPropagation()}
            onTouchStart={onSheetTouchStart}
            onTouchMove={onSheetTouchMove}
            onTouchEnd={onSheetTouchEnd}
            style={sheetDragY ? { transform: `translateY(${sheetDragY}px)`, transition: "none" } : undefined}
          >
            <div className="vp-sheet-head">
              <div className="vp-tabs">
                {sheetTabs.map((t) => (
                  <button key={t.id} ref={activeTab === t.id ? activeTabRef : undefined} className={`vp-tab ${activeTab === t.id ? "active" : ""}`} onClick={() => setSheetTab(t.id)}>{t.label}</button>
                ))}
              </div>
              <button className="vp-sheet-x" aria-label="Close" onClick={() => setSheetOpen(false)}><X size={18} /></button>
            </div>
            <div className="vp-sheet-body" ref={sheetBodyRef}>
              {activeTab === "playback" && (
                <div className="vp-sec">
                  <div className="vp-stepper">
                    <span>Speed</span>
                    <div className="vp-stepper-ctl">
                      <button aria-label="Slower" onClick={() => bumpRate(-0.25)} disabled={rate <= 0.25}>−</button>
                      <span className="vp-stepper-val">{rate}×</span>
                      <button aria-label="Faster" onClick={() => bumpRate(0.25)} disabled={rate >= 2}>+</button>
                    </div>
                  </div>
                  <div className="vp-stepper">
                    <span>Voice boost</span>
                    <div className="vp-stepper-ctl">
                      <button aria-label="Less" onClick={() => setBoost(Math.max(0, (S.voiceBoost || 0) - 1))} disabled={(S.voiceBoost || 0) <= 0}>−</button>
                      <span className="vp-stepper-val">{["Off", "Low", "Med", "High"][S.voiceBoost || 0]}</span>
                      <button aria-label="More" onClick={() => setBoost(Math.min(3, (S.voiceBoost || 0) + 1))} disabled={(S.voiceBoost || 0) >= 3}>+</button>
                    </div>
                  </div>
                  <div className="vp-hint">Enhances dialogue clarity — lifts the speech frequencies and evens out loud/quiet scenes.</div>
                </div>
              )}
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
                      <div className="vp-hint">This stream has one selectable track. Any other audio is embedded (muxed) in the file and can't be switched in a browser — try a different source or the Dub/Sub toggle.</div>
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
                  <button className={`vp-opt ${ccIndex < 0 ? "active" : ""}`} onClick={() => chooseCc(-1)}><span>Off</span>{ccIndex < 0 && <Check size={16} />}</button>
                  {tracks.map((t, i) => (
                    <button key={i} className={`vp-opt ${ccIndex === i ? "active" : ""}`} onClick={() => chooseCc(i)}>
                      <span>{t.lang || `Track ${i + 1}`}</span>{ccIndex === i && <Check size={16} />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
