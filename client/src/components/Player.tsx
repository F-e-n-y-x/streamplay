import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type PointerEvent as RPointerEvent } from "react";
import type Hls from "hls.js";
import { useSettings, updateSettings } from "../lib/settings";
import { nominalHeight } from "../lib/useSources";
import type { SkipTimes } from "../lib/api";
import { toast } from "./ui";
import SettingsPanel, { SUB_SIZE_PCT, type SettingsView } from "./player/SettingsPanel";
import { Cast, ChevronDown, ChevronLeft, ChevronUp, Forward10, ListVideo, Lock, Maximize, Minimize, Pause, PictureInPicture, Play, Rewind10, RotateCcw, Settings, SkipForward, Subtitles, Sun, Unlock, Users, Volume2, VolumeX } from "./icons";

/** ISO/short language code → display name (audio + subtitle menus). */
const LANG_NAMES: Record<string, string> = {
  ja: "Japanese", jpn: "Japanese", en: "English", eng: "English", hi: "Hindi", hin: "Hindi",
  ta: "Tamil", tam: "Tamil", te: "Telugu", tel: "Telugu", ml: "Malayalam", mal: "Malayalam",
  kn: "Kannada", kan: "Kannada", ko: "Korean", kor: "Korean", zh: "Chinese", zho: "Chinese",
  fr: "French", fra: "French", es: "Spanish", spa: "Spanish", de: "German", deu: "German",
  it: "Italian", ita: "Italian", pt: "Portuguese", ru: "Russian", ar: "Arabic", bn: "Bengali",
  mr: "Marathi", pa: "Punjabi", ur: "Urdu", th: "Thai", id: "Indonesian", vi: "Vietnamese", und: "Original",
};
const langName = (code: string): string => {
  const c = (code || "").trim();
  if (!c) return "Original";
  if (LANG_NAMES[c.toLowerCase()]) return LANG_NAMES[c.toLowerCase()];
  try { return new Intl.DisplayNames(["en"], { type: "language" }).of(c) || c; } catch { return c; }   // "pt-BR" → "Brazilian Portuguese"
};
/** Track labels, unique: the second "Portuguese" becomes "Portuguese 2". */
const uniqueLabels = (names: string[]) => names.map((n, i) => {
  const k = names.slice(0, i).filter((x) => x === n).length;
  return k ? `${n} ${k + 1}` : n;
});
// display name → 2-letter code, derived from LANG_NAMES (for the <track srcLang>).
const NAME2CODE = Object.fromEntries(Object.entries(LANG_NAMES).filter(([c]) => c.length === 2).map(([c, n]) => [n.toLowerCase(), c]));
const subLangCode = (label: string): string => {
  const l = (label || "").toLowerCase().trim();
  if (/^[a-z]{2,3}(-[a-z]{2,4})?$/i.test(l)) return l;        // already a code (en, ja, pt-BR…)
  return NAME2CODE[l] || "und";
};
/** EXT-X-MEDIA audio renditions declared in an HLS master playlist. */
const parseAudios = (txt: string) => [...txt.matchAll(/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*/gi)].flatMap((m) => {
  const name = /NAME="([^"]+)"/.exec(m[0])?.[1];
  return name ? [{ name, lang: /LANGUAGE="([^"]+)"/.exec(m[0])?.[1] || "", def: /DEFAULT=YES/i.test(m[0]) }] : [];
});
type NativeAudio = { length: number; [i: number]: { label?: string; language?: string; enabled: boolean } };
const nativeAudioOf = (el: HTMLVideoElement | null) => (el as (HTMLVideoElement & { audioTracks?: NativeAudio }) | null)?.audioTracks;

export interface PlayerSource {
  title: string;
  url: string;
  type: "youtube" | "m3u8" | "mp4" | "iframe";
  /** Provider name (for history). */
  provider?: string;
  /** Subtitle tracks (already proxied to .vtt by the backend). */
  subtitles?: { lang: string; url: string }[];
}

/** iOS/iPadOS: media volume is read-only from JS (hardware buttons only). */
const isIOS = () => typeof navigator !== "undefined" && (/iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

/** Vertical drag slider on a screen edge (touch fullscreen: brightness left, volume right). */
function EdgeSlider({ side, label, value, onChange, icon }: { side: "l" | "r"; label: string; value: number; onChange: (v: number) => void; icon: ReactNode }) {
  const set = (e: RPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onChange(Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)));
  };
  const pct = Math.round(value * 100);
  return (
    <div className={`vp-edge ${side}`}>
      <span className="vp-edge-v" aria-hidden>{pct}%</span>
      <div
        className="vp-edge-track"
        role="slider" tabIndex={-1} aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-orientation="vertical"
        onPointerDown={(e) => { e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); set(e); }}
        onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) set(e); }}
        onPointerUp={(e) => e.stopPropagation()}
      >
        <span style={{ transform: `scaleY(${value})` }} />
      </div>
      {icon}
    </div>
  );
}

export function EmbedFrame({ source, onLoad }: { source: PlayerSource; onLoad?: () => void }) {
  return (
    <iframe
      src={source.url}
      onLoad={onLoad}
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
      <span><Users size={12} /> {st.numPeers ?? 0}</span>
      {!complete && <span><ChevronDown size={12} /> {fmtBytes(st.downloadSpeed ?? 0)}/s</span>}
      <span><ChevronUp size={12} /> {fmtBytes(st.uploadSpeed ?? 0)}/s</span>
      <span className="ts-prog">{complete ? "Ready" : `${pct}%`}</span>
    </div>
  );
}

function fmt(t: number): string {
  if (!isFinite(t) || t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

const isFs = () => !!(document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement);
type LockableOrientation = ScreenOrientation & { lock?: (o: string) => Promise<void> };
/** Safari-only <video> extensions (iPhone fullscreen, PiP presentation mode, AirPlay). */
type WebkitVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitSetPresentationMode?: (m: "inline" | "picture-in-picture" | "fullscreen") => void;
  webkitPresentationMode?: string;
  webkitShowPlaybackTargetPicker?: () => void;
};
const canPip = () => typeof document !== "undefined" && (document.pictureInPictureEnabled || "webkitSetPresentationMode" in HTMLVideoElement.prototype);
/** Element fullscreen exists (desktop, Android, iPadOS ≥16.4) — false on iPhone Safari. */
const canElementFs = () => !!(document.fullscreenEnabled || (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled);
const finePointer = () => typeof matchMedia !== "undefined" && matchMedia("(hover: hover) and (pointer: fine)").matches;

const STALL_MS = 12_000;    // a mid-play stall this long = switch source
const HIDE_MS = 3_000;

export interface NextEpisode { label: string; still?: string; go: () => void }

/**
 * Custom-skinned HTML5 player (keyed by URL: every source gets a fresh instance).
 * Chrome per design-system §8.18. Mouse: click = play/pause, double-click = fullscreen.
 * Touch: tap reveals/hides chrome, double-tap the left/right third = ∓10s, middle = fullscreen.
 * HLS: hls.js (lazy, bounded recovery) → Shaka → native (Safari) → onFail.
 */
export function VideoPlayer({ source, title, subtitle, poster, startingLabel, resumeAt, onProgress, onFirstFrame, onFail, onStall, skips, next, onEpisodes, onBack, stage, sourceLabel, renderSource, hold, timeRef, onHeight, audioLang, onPlayingChange }: {
  source: PlayerSource;
  /** Line 1 of the top bar: show or movie title */
  title: string;
  /** Line 2: "S1 · E3 · …And the Bag's in the River" */
  subtitle?: string;
  /** Episode still / backdrop shown until the first frame */
  poster?: string;
  /** "Starting VidFast · 1080p" under the spinner until the first frame */
  startingLabel?: string;
  resumeAt?: number;
  onProgress?: (position: number, duration: number) => void;
  onFirstFrame?: () => void;
  /** Fatal error / start timeout */
  onFail?: (reason: string) => void;
  /** Mid-play stall longer than STALL_MS */
  onStall?: () => void;
  /** Written on every timeupdate, so the next source (failover/switch) resumes here */
  timeRef?: { current: number };
  skips?: SkipTimes | null;
  /** Next episode (undefined = not a series; null = last episode). */
  next?: NextEpisode | null;
  /** ☰ (series only) */
  onEpisodes?: () => void;
  onBack?: () => void;
  /** The stage element: fullscreen root (survives source switches) and the panels' container */
  stage: HTMLElement | null;
  sourceLabel?: string;
  renderSource?: (close: () => void) => ReactNode;
  /** Keep the chrome up (a panel owned by the page is open) */
  hold?: boolean;
  /** Nominal height of what's on screen now (ABR moves it), for the status line */
  onHeight?: (h: number) => void;
  /** The source's known audio language, shown when the stream declares no tracks */
  audioLang?: string;
  /** Playing ↔ paused/ended (the page's "Playing" indicator follows it) */
  onPlayingChange?: (playing: boolean) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const hls = useRef<Hls | null>(null);
  const shakaRef = useRef<any>(null);
  const engineRef = useRef<"shaka" | "hls" | "native">("native");
  const hideTimer = useRef<number | undefined>(undefined);
  const resumed = useRef(false);
  const lastSaved = useRef(0);
  const failedOnce = useRef(false);
  const firstFrame = useRef(false);
  const stallTimer = useRef<number | undefined>(undefined);
  const hovered = useRef(false);
  // pointer type of the latest press (click/dblclick don't reliably carry it); seeded for a fresh instance
  const lastPointer = useRef(typeof matchMedia !== "undefined" && matchMedia("(pointer: coarse)").matches ? "touch" : "mouse");

  const S = useSettings();
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [loading, setLoading] = useState(true);
  const lastTick = useRef(-1);
  const [ready, setReady] = useState(false);       // first frame decoded
  const [showControls, setShowControls] = useState(true);
  const shownRef = useRef(true);
  shownRef.current = showControls;
  const [fullscreen, setFullscreen] = useState(false);
  const [ended, setEnded] = useState(false);
  const [ccIndex, setCcIndex] = useState(-1);
  const [settingsView, setSettingsView] = useState<SettingsView | null>(null);
  const [rate, setRate] = useState(1);
  const [levels, setLevels] = useState<{ index: number; height: number }[]>([]);
  const [curLevel, setCurLevel] = useState(-1); // -1 = Auto
  const [playingHeight, setPlayingHeight] = useState(0);
  const [audioTracks, setAudioTracks] = useState<{ id: number; label: string }[]>([]);
  const [curAudio, setCurAudio] = useState(-1);
  // Audio renditions parsed from the manifest (used when hls.js doesn't expose them).
  const [manifestAudios, setManifestAudios] = useState<{ name: string; lang: string }[]>([]);
  // server remux (MKV): every audio track of the file; the server maps the chosen one (&audio=n)
  const [remuxAudios, setRemuxAudios] = useState<{ index: number; label: string }[]>([]);
  const [curRemux, setCurRemux] = useState(0);
  const [curMAudio, setCurMAudio] = useState("");
  const pendingSeek = useRef<number | null>(null);
  // AniSkip: the OP/ED interval the playhead is inside, and which were auto-skipped once.
  const [activeSkip, setActiveSkip] = useState<{ label: string; end: number } | null>(null);
  const autoSkipped = useRef<Set<string>>(new Set());
  // Double-tap seek bubble (accumulates while you keep tapping the same side).
  const [bubble, setBubble] = useState<{ side: "l" | "r"; n: number } | null>(null);
  const bubbleTimer = useRef<number | undefined>(undefined);
  const tap = useRef({ t: 0, side: "", chain: 0, timer: 0 });
  // Up next: off → shown (last 20s / credits) → counting (autoplay) | dismissed
  const [upNext, setUpNext] = useState<"off" | "shown" | "dismissed">("off");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [remaining, setRemaining] = useState(true);   // right-hand time shows −remaining (tap toggles)
  const [hover, setHover] = useState<number | null>(null);   // seek preview, 0..1
  // Touch extras: screen lock (taps ignored until unlocked) + brightness (CSS filter on the video).
  const [locked, setLocked] = useState(false);
  const [lockHint, setLockHint] = useState(false);
  const lockTimer = useRef<number | undefined>(undefined);
  const [bright, setBright] = useState(1);
  const ios = isIOS();
  const pokeLock = () => { setLockHint(true); window.clearTimeout(lockTimer.current); lockTimer.current = window.setTimeout(() => setLockHint(false), 2200); };
  const settingsOpen = settingsView != null;

  // Subtitle appearance (applied to native ::cue + shaka-rendered cues).
  const subCss = `.vp video::cue{color:${S.subtitleColor};background:rgba(0,0,0,${S.subtitleBgOpacity});font-size:${SUB_SIZE_PCT[S.subtitleSize] ?? 100}%}`
    + `.vp .shaka-text-container span,.vp .shaka-text-container div{color:${S.subtitleColor}!important;background:rgba(0,0,0,${S.subtitleBgOpacity})!important}`;

  useEffect(() => { if (video.current) video.current.playbackRate = rate; }, [rate]);
  // Save the exact position when leaving (navigation, tab close) — the 8 s timer misses short watches.
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;
  useEffect(() => {
    const el = video.current;
    const flush = () => { if (el && el.duration > 0 && el.currentTime > 0) progressRef.current?.(el.currentTime, el.duration); };
    window.addEventListener("pagehide", flush);
    return () => { window.removeEventListener("pagehide", flush); flush(); };
  }, []);
  useEffect(() => { if (playingHeight) onHeight?.(playingHeight); }, [playingHeight]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onPlayingChange?.(playing); }, [playing]);   // eslint-disable-line react-hooks/exhaustive-deps

  const pipOk = canPip();   // Firefox has no PiP JS API → hidden
  const togglePip = async () => {
    const el = video.current as WebkitVideo | null; if (!el) return;
    try {
      if (el.requestPictureInPicture) { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await el.requestPictureInPicture(); }
      else el.webkitSetPresentationMode?.(el.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
    } catch { /* unsupported / blocked */ }
  };
  // AirPlay (Safari): offered only when a target is around.
  const [airplay, setAirplay] = useState(false);
  useEffect(() => {
    const el = video.current;
    if (!el || !("WebKitPlaybackTargetAvailabilityEvent" in window)) return;
    const on = (e: Event) => setAirplay((e as Event & { availability?: string }).availability === "available");
    el.addEventListener("webkitplaybacktargetavailabilitychanged", on);
    return () => el.removeEventListener("webkitplaybacktargetavailabilitychanged", on);
  }, []);
  const showAirplay = () => (video.current as WebkitVideo | null)?.webkitShowPlaybackTargetPicker?.();

  // ── Dialogue boost (Web Audio): high-pass, a peaking boost at the 2.6 kHz speech band,
  //    gentle compression. Built lazily on a gesture (an element can be tapped by
  //    createMediaElementSource only once). ──
  const va = useRef<{ ctx: AudioContext; el: HTMLVideoElement; hp: BiquadFilterNode; peak: BiquadFilterNode; comp: DynamicsCompressorNode } | null>(null);
  const applyBoost = useCallback((level: number) => {
    const a = va.current; if (!a) return;
    const gains = [0, 4, 7, 10];
    a.peak.gain.value = gains[level] ?? 0;
    a.hp.frequency.value = level > 0 ? 95 : 20;
    a.comp.threshold.value = -18; a.comp.knee.value = 20; a.comp.attack.value = 0.003; a.comp.release.value = 0.25;
    a.comp.ratio.value = level > 0 ? 2 + level : 1;
    if (a.ctx.state === "suspended") a.ctx.resume().catch(() => { /* needs a gesture */ });
  }, []);
  const ensureVoiceGraph = useCallback(() => {
    const el = video.current; if (!el) return false;
    try {
      if (va.current && va.current.el === el) return true;
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = va.current?.ctx ?? new Ctx();
      const src = ctx.createMediaElementSource(el);
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 20;
      const peak = ctx.createBiquadFilter(); peak.type = "peaking"; peak.frequency.value = 2600; peak.Q.value = 1.1; peak.gain.value = 0;
      const comp = ctx.createDynamicsCompressor(); comp.ratio.value = 1;
      src.connect(hp); hp.connect(peak); peak.connect(comp); comp.connect(ctx.destination);
      va.current = { ctx, el, hp, peak, comp };
      return true;
    } catch { return false; }
  }, []);
  // Only on a real user gesture: a graph on a still-suspended AudioContext (autoplay,
  // iOS) would route the audio into silence.
  const onPlayWireBoost = () => {
    const gesture = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive;
    if ((S.voiceBoost || 0) > 0 && gesture && ensureVoiceGraph()) applyBoost(S.voiceBoost);
  };
  const setBoost = (level: number) => { updateSettings({ voiceBoost: level }); if (level > 0) { if (ensureVoiceGraph()) applyBoost(level); } else applyBoost(0); };
  useEffect(() => () => { try { va.current?.ctx.close(); } catch { /* */ } }, []);

  const tracks = source.subtitles ?? [];
  const trackLabels = uniqueLabels(tracks.map((t) => langName(t.lang)));

  // ── Subtitle memory: re-apply the last chosen language (or "off") on every video. ──
  const prefTrackIndex = () => {
    const p = (S.subtitlePref || "").toLowerCase();
    if (!p || p === "off") return -1;
    const exact = tracks.findIndex((t) => (t.lang || "").toLowerCase() === p);
    return exact >= 0 ? exact : tracks.findIndex((t) => (t.lang || "").toLowerCase().includes(p));
  };
  const chooseCc = (index: number) => {
    setCcIndex(index);
    updateSettings({ subtitlePref: index < 0 ? "off" : (tracks[index]?.lang || "off") });
  };
  const toggleCc = () => { if (tracks.length) chooseCc(ccIndex < 0 ? Math.max(prefTrackIndex(), 0) : -1); };
  useEffect(() => { if (tracks.length) setCcIndex(prefTrackIndex()); /* eslint-disable-next-line */ }, [tracks.length]);

  // Never auto-mute: if autoplay-with-sound is blocked, stay paused (the user's tap has sound).
  const start = useCallback(() => { video.current?.play().catch(() => { /* blocked — leave paused */ }); }, []);

  const fail = useCallback((reason: string) => {
    if (failedOnce.current) return;
    failedOnce.current = true;
    window.clearTimeout(stallTimer.current);
    onFail?.(reason);
  }, [onFail]);

  const reachedFirstFrame = () => {
    if (firstFrame.current) return;
    firstFrame.current = true;
    setReady(true);
    onFirstFrame?.();
  };

  // Attach the source. HLS: hls.js (≤2 recoveries) → Shaka → native (Safari) → fail.
  // mp4 plays natively.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    let cancelled = false;
    let cleanup = () => { /* replaced by the active engine */ };
    const S0 = S;   // settings snapshot for this source

    // Preferred audio: anime Sub/Dub first, then the preferred-language list.
    const autoPick = (langs: { name: string; lang: string }[]) => {
      if (langs.length <= 1) return undefined;
      const has = (re: RegExp) => langs.find((a) => re.test(a.name) || re.test(a.lang));
      const jp = has(/\b(jp|jpn|japanese)\b/i);
      const want = jp ? (S0.anime === "dub" ? has(/\b(en|eng|english)\b/i) : jp) : undefined;
      if (want) return want;
      const pl = S0.audioLanguages;
      if (pl.length) return langs.find((a) => pl.some((p) => `${a.name} ${a.lang}`.toLowerCase().includes(p.toLowerCase())));
      return undefined;
    };

    const startNative = () => {
      engineRef.current = "native";
      const remux = /^\/api\/torrent\/http\?.*remux=1/.test(source.url);
      const alang = remux ? `&alang=${encodeURIComponent(S0.audioLanguages.join(","))}` : "";
      el.src = source.url + alang;
      if (remux) {
        const b64 = new URL(source.url, location.origin).searchParams.get("url");
        fetch(`/api/torrent/tracks?url=${encodeURIComponent(b64 || "")}${alang}`).then((r) => r.json()).then((j: { chosen: number; tracks: { index: number; label: string }[] }) => {
          if (cancelled || !(j.tracks?.length > 1)) return;
          setRemuxAudios(j.tracks); setCurRemux(j.chosen || 0);
        }).catch(() => { /* single track as far as we know */ });
      }
      const nativeAudio = () => {
        const nat = nativeAudioOf(el);
        if (!nat || nat.length <= 1) return;
        setAudioTracks(Array.from({ length: nat.length }, (_v, i) => ({ id: i, label: nat[i].label || langName(nat[i].language || "") || `Track ${i + 1}` })));
        setCurAudio(Array.from({ length: nat.length }).findIndex((_v, i) => nat[i].enabled));
      };
      el.addEventListener("loadedmetadata", nativeAudio);
      cleanup = () => el.removeEventListener("loadedmetadata", nativeAudio);
      start();
    };
    const nativeOrFail = (reason: string) => (el.canPlayType("application/vnd.apple.mpegurl") ? startNative() : fail(reason));

    const startShaka = async (reason: string) => {
      let gaveUp = false;
      const giveUp = () => { if (gaveUp || cancelled) return; gaveUp = true; cleanup(); cleanup = () => {}; nativeOrFail(reason); };
      try {
        // @ts-expect-error — shaka's compiled build ships non-ES-module typings
        const shakaMod: any = await import("shaka-player/dist/shaka-player.compiled.js");
        const shaka: any = shakaMod.default || shakaMod;
        if (cancelled) return;
        shaka.polyfill.installAll();
        if (!shaka.Player.isBrowserSupported()) throw new Error("shaka unsupported");
        const player = new shaka.Player();
        // Assigned BEFORE any await: a teardown mid-load destroys this instance.
        cleanup = () => { try { player.destroy(); } catch { /* */ } shakaRef.current = null; };
        await player.attach(el);
        if (cancelled) return;
        shakaRef.current = player;
        engineRef.current = "shaka";
        player.configure({ streaming: { bufferingGoal: 60, rebufferingGoal: 2, retryParameters: { maxAttempts: 5, baseDelay: 500, backoffFactor: 2 } } });
        player.addEventListener("error", (ev: any) => { if (ev?.detail?.severity === 2) giveUp(); });
        await player.load(source.url, (resumeAt && resumeAt > 5) ? resumeAt : undefined);
        if (cancelled) return;
        resumed.current = true;
        const variants: any[] = player.getVariantTracks?.() || [];
        // Audio list from the master's EXT-X-MEDIA NAMEs (distinct even when renditions
        // share/omit LANGUAGE, e.g. Indian-dub masters); else Shaka's language list.
        let audios: { name: string; lang: string }[] = [];
        try { audios = parseAudios(await (await fetch(source.url)).text()); } catch { /* */ }
        if (audios.length < 2) {
          const sl = (player.getAudioLanguages?.() || []).map((c: string) => ({ name: langName(c), lang: c }));
          if (sl.length > audios.length) audios = sl;
        }
        if (cancelled) return;
        setManifestAudios(audios);
        const active = variants.find((v) => v.active);
        let chosen = active ? langName(active.language) : (audios[0]?.name || "");
        const want = autoPick(audios);
        if (want && want.lang !== active?.language) { try { player.selectAudioLanguage(want.lang); } catch { /* */ } chosen = want.name; }
        setCurMAudio(chosen);
        const heights = [...new Set(variants.filter((v) => v.height).map((v) => nominalHeight(v.width || 0, v.height)))].sort((a, b) => b - a);
        setLevels(heights.map((h, index) => ({ index, height: h })));
        start();
      } catch { giveUp(); }
    };

    const startHls = async () => {
      let Hls: typeof import("hls.js").default;
      try { Hls = (await import("hls.js")).default; } catch { if (!cancelled) startShaka("hls.js failed to load"); return; }
      if (cancelled) return;
      if (!Hls.isSupported()) { nativeOrFail("HLS not supported"); return; }
      engineRef.current = "hls";
      // capLevelToPlayerSize: no 1080p into a 400px window; a 5 Mbps first guess starts at
      // ~720p instead of the 240p a cold 500 kbps estimate picks.
      const inst = new Hls({ enableWorker: true, lowLatencyMode: false, capLevelToPlayerSize: true, abrEwmaDefaultEstimate: 5_000_000, maxBufferLength: 60, maxMaxBufferLength: 600, backBufferLength: 60, fragLoadingMaxRetry: 6, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 4,
        // server GPU conversion: the first segment after a start/seek can take ~15 s
        ...(source.url.includes("/api/torrent/hls") ? { fragLoadingTimeOut: 60_000, manifestLoadingTimeOut: 30_000, levelLoadingTimeOut: 30_000 } : {}) });
      hls.current = inst;
      cleanup = () => { inst.destroy(); hls.current = null; };
      const syncAudio = () => {
        setAudioTracks(inst.audioTracks.map((t) => ({ id: t.id, label: t.name || langName(t.lang || "") || `Track ${t.id + 1}` })));
        setCurAudio(inst.audioTrack);
      };
      inst.attachMedia(el);
      fetch(source.url).then((r) => r.text()).then((txt) => {
        if (cancelled) return;
        const list = parseAudios(txt);
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
      }).catch(() => { if (!cancelled) inst.loadSource(source.url); });
      inst.on(Hls.Events.MANIFEST_PARSED, () => {
        setLevels(inst.levels.map((l, index) => ({ index, height: l.height ? nominalHeight(l.width || 0, l.height) : 0 })).filter((l) => l.height > 0).sort((a, b) => b.height - a.height));
        syncAudio();
        if (pendingSeek.current != null) { el.currentTime = pendingSeek.current; pendingSeek.current = null; }
        start();
      });
      inst.on(Hls.Events.AUDIO_TRACKS_UPDATED, syncAudio);
      inst.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_e, d) => setCurAudio(d.id));
      inst.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => setCurLevel(inst.autoLevelEnabled ? -1 : d.level));
      // Bounded self-recovery, then hand the same source to Shaka (broader codec coverage).
      let recoveries = 0;
      inst.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal || cancelled) return;
        // Manifest never loaded (dead link / blocked host): startLoad() wouldn't re-request
        // it and Shaka would hit the same wall — fail now so the next source gets a turn.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !inst.levels?.length) { cleanup(); cleanup = () => {}; fail(`hls: ${data.details}`); return; }
        if (recoveries++ < 2) {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { inst.startLoad(); return; }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { inst.recoverMediaError(); return; }
        }
        cleanup(); cleanup = () => {};
        startShaka(`hls: ${data.details}`);
      });
    };

    if (source.type === "m3u8") startHls();
    else startNative();
    // Watchdog: nothing playable after 30s → failed (no endless spinner).
    // (torrents legitimately take longer to find peers → 2 min)
    const watchdog = window.setTimeout(() => { if (!cancelled && el.readyState < 3) { cleanup(); cleanup = () => {}; fail("start timeout"); } }, source.url.includes("/api/torrent/") ? 120000 : 30000);
    const disarm = () => window.clearTimeout(watchdog);
    el.addEventListener("canplay", disarm);
    return () => { cancelled = true; disarm(); window.clearTimeout(stallTimer.current); el.removeEventListener("canplay", disarm); cleanup(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const list = video.current?.textTracks;
    if (list) for (let i = 0; i < list.length; i++) list[i].mode = i === ccIndex ? "showing" : "disabled";
  }, [ccIndex]);

  const togglePlay = useCallback(() => {
    const el = video.current;
    if (!el) return;
    if (el.paused) el.play().catch(() => { /* interrupted load */ });
    else el.pause();
  }, []);

  const seekBy = useCallback((delta: number) => {
    const el = video.current;
    if (!el) return;
    const dur = el.duration || duration;
    el.currentTime = Math.max(0, Math.min(dur || el.currentTime + delta, el.currentTime + delta));
    setCurrent(el.currentTime);
  }, [duration]);

  // Chrome auto-hides 3s after the last interaction while playing; focus inside it keeps it up.
  const nudgeControls = useCallback(() => {
    setShowControls(true);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      const focusInChrome = !!wrap.current?.querySelector(".vp-top :focus-visible, .controls :focus-visible");
      if (!video.current?.paused && !focusInChrome) setShowControls(false);
    }, HIDE_MS);
  }, []);

  // ── Fullscreen (on the stage so it survives a source switch) + landscape lock on phones ──
  const toggleFullscreen = () => {
    const root = (stage ?? wrap.current) as (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }) | null;
    const vid = video.current as WebkitVideo | null;
    const doc = document as Document & { webkitExitFullscreen?: () => void };
    if (isFs()) { (document.exitFullscreen ? document.exitFullscreen() : (doc.webkitExitFullscreen?.(), Promise.resolve())).catch(() => {}); return; }
    const lock = () => {
      if (vid && vid.videoHeight > vid.videoWidth) return;   // portrait video: don't rotate
      (screen.orientation as LockableOrientation | undefined)?.lock?.("landscape").catch(() => { /* desktop / iOS */ });
    };
    // iPhone Safari has no element fullscreen: only the <video> itself (native controls).
    const nativeFs = () => { try { vid?.webkitEnterFullscreen?.(); } catch { /* not ready yet */ } };
    if (!canElementFs() || !root) { nativeFs(); return; }
    if (root.requestFullscreen) root.requestFullscreen().then(lock).catch(nativeFs);
    else Promise.resolve(root.webkitRequestFullscreen?.()).catch(nativeFs);
  };
  useEffect(() => {
    const onFs = () => {
      const fs = isFs(); setFullscreen(fs);
      if (!fs) { setLocked(false); try { screen.orientation?.unlock?.(); } catch { /* */ } }
    };
    // iPhone: native video fullscreen reports via webkitbegin/endfullscreen on the element
    const v = video.current;
    const onBegin = () => setFullscreen(true), onEnd = () => setFullscreen(false);
    onFs();
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onFs);
    v?.addEventListener("webkitbeginfullscreen", onBegin);
    v?.addEventListener("webkitendfullscreen", onEnd);
    return () => {
      document.removeEventListener("fullscreenchange", onFs); document.removeEventListener("webkitfullscreenchange", onFs);
      v?.removeEventListener("webkitbeginfullscreen", onBegin); v?.removeEventListener("webkitendfullscreen", onEnd);
    };
  }, []);

  const setVol = (d: number) => { const el = video.current; if (!el || ios) return; el.volume = Math.min(1, Math.max(0, el.volume + d)); el.muted = el.volume === 0; };

  // ── Hotkeys: when the player is focused/hovered/fullscreen (arrows), or nothing else has
  //    focus (letters). Never with modifiers, while typing, while a panel is open, or for
  //    Space/Enter on a focused button/link. ──
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || !video.current) return;
    if (document.querySelector(".panel-root")) return;   // the panel owns the keyboard
    const t = e.target as HTMLElement | null;
    if (t?.closest?.("input:not(.seek-range), textarea, select, [contenteditable]")) return;
    const inside = !!(t && wrap.current?.contains(t));
    const free = !t || t === document.body;
    const near = fullscreen || inside || hovered.current;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (k === "Escape") { if (upNext === "shown") { setUpNext("dismissed"); setCountdown(null); e.preventDefault(); } return; }
    if (!(near || free)) return;
    const onControl = !!t?.closest?.("button, a");
    if (k === " " || k === "Enter") { if (onControl || (k === "Enter" && t !== wrap.current)) return; togglePlay(); }
    else if (k === "k") togglePlay();
    else if (k === "f") toggleFullscreen();
    else if (k === "m") { if (video.current) video.current.muted = !video.current.muted; }
    else if (k === "c") toggleCc();
    else if (k === "n" && next) next.go();
    else if (k === "e" && onEpisodes) onEpisodes();
    else if (k === "s") setSettingsView("root");
    else if (!near) return;
    else if (k === "ArrowRight") seekBy(10);
    else if (k === "ArrowLeft") seekBy(-10);
    else if (k === "ArrowUp") setVol(0.1);
    else if (k === "ArrowDown") setVol(-0.1);
    else return;
    e.preventDefault();
    nudgeControls();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Touch gestures on the picture ──
  const showBubble = (side: "l" | "r") => {
    setBubble((b) => ({ side, n: b && b.side === side ? b.n + 10 : 10 }));
    window.clearTimeout(bubbleTimer.current);
    bubbleTimer.current = window.setTimeout(() => setBubble(null), 700);
  };
  const onSurfacePointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    lastPointer.current = e.pointerType;
    if (e.pointerType === "mouse") return;               // mouse → onClick / onDoubleClick
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const side = x < 1 / 3 ? "l" : x > 2 / 3 ? "r" : "m";
    const now = Date.now(), T = tap.current;
    window.clearTimeout(T.timer);
    const seek = (s: string) => { seekBy(s === "l" ? -10 : 10); showBubble(s as "l" | "r"); T.chain = now; };
    // Keep tapping the same side to keep seeking (YouTube-style).
    if (side !== "m" && side === T.side && now - T.chain < 700) { seek(side); T.t = 0; return; }
    if (now - T.t < 300 && side === T.side) {
      T.t = 0;
      if (side === "m") toggleFullscreen(); else seek(side);
      return;
    }
    T.t = now; T.side = side;
    T.timer = window.setTimeout(() => {
      // read live state: the auto-hide may have fired during the 260 ms wait
      if (shownRef.current && !video.current?.paused) { window.clearTimeout(hideTimer.current); setShowControls(false); }
      else nudgeControls();
    }, 260);
  };

  // Rotate a phone to landscape while playing → try fullscreen (browsers may refuse
  // without a gesture; the landscape CSS gives a 100dvh player either way).
  useEffect(() => {
    const mq = window.matchMedia("(orientation: landscape) and (pointer: coarse) and (max-height: 500px)");   // phones only
    const onChange = () => {
      if (mq.matches && !isFs() && !video.current?.paused && canElementFs()) (stage ?? wrap.current)?.requestFullscreen?.().catch(() => {});
      else if (!mq.matches && isFs()) document.exitFullscreen?.().catch(() => {});
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [stage]);

  // Put the keyboard on the player when nothing else has it (TV remotes, desktop hotkeys).
  useEffect(() => { if (document.activeElement === document.body) wrap.current?.focus({ preventScroll: true }); }, []);

  // Up-next countdown.
  useEffect(() => {
    if (countdown == null) return;
    if (countdown <= 0) { next?.go(); return; }
    const t = window.setTimeout(() => setCountdown((n) => (n == null ? n : n - 1)), 1000);
    return () => window.clearTimeout(t);
  }, [countdown, next]);
  const startCountdown = () => { if (S.autoNext && countdown == null) setCountdown(10); };

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
  // Switch a manifest-declared audio rendition: in place when it has a unique LANGUAGE,
  // else reload the master with our proxy's &audio= re-default, resuming the position.
  function pickManifestAudio(name: string) {
    if (name === curMAudio) return;
    const el = video.current;
    const base = source.url.replace(/([?&])audio=[^&]*/i, "$1").replace(/[?&]$/, "");
    const url = `${base}${base.includes("?") ? "&" : "?"}audio=${encodeURIComponent(name)}`;
    if (engineRef.current === "shaka" && shakaRef.current) {
      const a = manifestAudios.find((x) => x.name === name);
      if (!a) return;
      const unique = !!a.lang && manifestAudios.filter((x) => x.lang === a.lang).length === 1;
      setCurMAudio(name);
      if (unique) { try { shakaRef.current.selectAudioLanguage(a.lang); } catch { /* */ } return; }
      const pos = el?.currentTime || 0;
      shakaRef.current.load(url, pos > 5 ? pos : undefined).then(start).catch(() => { /* */ });
      return;
    }
    const inst = hls.current;
    if (!inst || !el) return;
    pendingSeek.current = el.currentTime;
    setCurMAudio(name);
    inst.loadSource(url);
  }
  function pickAudio(id: number) {
    const h = hls.current;
    if (h) { h.audioTrack = id; setCurAudio(id); return; }
    const nat = nativeAudioOf(video.current);   // native HLS (iOS)
    if (nat) { for (let i = 0; i < nat.length; i++) nat[i].enabled = i === id; setCurAudio(id); }
  }

  // Anime: "Japanese · Sub" / "English · Dub" when both exist.
  const JP = /\b(jp|jpn|japanese)\b/i;
  const animeAudio = audioTracks.some((t) => JP.test(t.label)) || manifestAudios.some((a) => JP.test(a.name));
  const audioLabel = (label: string) => !animeAudio ? label : JP.test(label) ? `${label} · Sub` : /\b(en|eng|english)\b/i.test(label) ? `${label} · Dub` : label;
  const audios = remuxAudios.length > 1 ? remuxAudios.map((t) => ({ key: `r${t.index}`, label: audioLabel(t.label) }))
    : audioTracks.length > 1 ? audioTracks.map((t) => ({ key: `t${t.id}`, label: audioLabel(t.label) }))
    : manifestAudios.length > 1 ? manifestAudios.map((a) => ({ key: `m${a.name}`, label: audioLabel(a.name) }))
    : [{ key: "x", label: manifestAudios[0]?.name || audioTracks[0]?.label || audioLang || "Original" }];
  const audioKey = remuxAudios.length > 1 ? `r${curRemux}` : audioTracks.length > 1 ? `t${curAudio}` : manifestAudios.length > 1 ? `m${curMAudio}` : "x";
  // Remux: restart the server conversion on the other track and jump back to where we were
  // (a live remux may refuse the seek — then it resumes from the start).
  function pickRemuxAudio(index: number) {
    const el = video.current;
    if (!el || index === curRemux) return;
    const pos = el.currentTime;
    const url = source.url.replace(/([?&])(audio|alang)=[^&]*/gi, "$1").replace(/[?&]+$/, "");
    el.addEventListener("loadedmetadata", () => { if (pos > 5) try { el.currentTime = pos; } catch { /* not seekable */ } }, { once: true });
    el.src = `${url}&audio=${index}`;
    el.play().catch(() => { /* autoplay policy: the play button stays */ });
    setCurRemux(index);
  }
  const onAudio = (key: string) => { if (key[0] === "t") pickAudio(Number(key.slice(1))); else if (key[0] === "m") pickManifestAudio(key.slice(1)); else if (key[0] === "r") pickRemuxAudio(Number(key.slice(1))); };
  const grabFrame = () => {
    const el = video.current; if (!el || !el.videoWidth) return poster;
    try {
      const c = document.createElement("canvas"); c.width = 480; c.height = Math.round(480 * el.videoHeight / el.videoWidth);
      c.getContext("2d")!.drawImage(el, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.7);
    } catch { return poster; }   // cross-origin frame
  };

  const pct = duration ? (current / duration) * 100 : 0;
  const bufPct = duration ? (buffered / duration) * 100 : 0;
  const ccOn = ccIndex >= 0;
  const hasSkips = !!(skips?.opening || skips?.ending);
  const holdChrome = settingsOpen || !!hold || (loading && !ready);
  const series = next !== undefined;
  const seg = (iv: { start: number; end: number } | null | undefined) => iv && duration > 0
    ? [iv.start, iv.end].filter((x) => x > 1 && x < duration - 1).map((x) => <i key={x} className="seek-gap" style={{ left: `${(x / duration) * 100}%` }} />) : null;

  return (
    <div
      ref={wrap}
      tabIndex={-1}
      aria-label={`Video player: ${title}`}
      className={`vp ${showControls && !locked ? "show" : ""} ${playing ? "" : "paused"} ${fullscreen ? "fs" : ""} ${locked ? "locked" : ""} ${holdChrome && !locked ? "hold" : ""} ${ready ? "ready" : ""} ${upNext === "shown" && next ? "upnext-on" : ""}`}
      onPointerMove={(e) => { if (e.pointerType === "mouse") nudgeControls(); }}
      onPointerDown={(e) => { lastPointer.current = e.pointerType; if (e.pointerType === "mouse" || (e.target as Element).closest(".controls, .center, .vp-top")) nudgeControls(); }}
      onFocus={() => nudgeControls()}
      onMouseEnter={() => { hovered.current = true; }}
      onMouseLeave={() => { hovered.current = false; if (playing) setShowControls(false); }}
    >
      <video
        ref={video}
        playsInline
        {...{ "webkit-playsinline": "true", "x-webkit-airplay": "allow" }}
        crossOrigin="anonymous"
        style={bright < 1 ? { filter: `brightness(${0.2 + bright * 0.8})` } : undefined}
        onPlay={() => { setPlaying(true); setEnded(false); nudgeControls(); onPlayWireBoost(); }}
        onPause={() => { setPlaying(false); setShowControls(true); const el = video.current; if (onProgress && el && el.duration > 0) onProgress(el.currentTime, el.duration); }}
        onWaiting={() => {
          setLoading(true);
          if (firstFrame.current && onStall) {
            window.clearTimeout(stallTimer.current);
            // server-converted streams restart the conversion on a seek: give them longer before giving up
            stallTimer.current = window.setTimeout(() => { if (!failedOnce.current) { failedOnce.current = true; onStall(); } }, source.url.includes("/api/torrent/") ? 45_000 : STALL_MS);
          }
        }}
        onPlaying={() => { setLoading(false); window.clearTimeout(stallTimer.current); reachedFirstFrame(); }}
        onCanPlay={() => { setLoading(false); window.clearTimeout(stallTimer.current); }}
        onLoadedData={reachedFirstFrame}
        onResize={(e) => setPlayingHeight(nominalHeight(e.currentTarget.videoWidth, e.currentTarget.videoHeight))}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget; setDuration(el.duration); setPlayingHeight(nominalHeight(el.videoWidth, el.videoHeight));
          if (!resumed.current && resumeAt && resumeAt > 5 && resumeAt < el.duration - 5) el.currentTime = resumeAt;
          resumed.current = true;
          el.playbackRate = rate;
        }}
        onDurationChange={(e) => setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => {
          const el = e.currentTarget; const t = el.currentTime; setCurrent(t);
          // `waiting` isn't always followed by `playing`/`canplay` (hls.js, Safari): time moving = not buffering
          if (!el.paused && t !== lastTick.current) { if (loading) { setLoading(false); window.clearTimeout(stallTimer.current); } }
          lastTick.current = t;
          if (timeRef) timeRef.current = t;
          try { if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1)); } catch { /* noop */ }
          if (onProgress && el.duration > 0 && Date.now() - lastSaved.current > 8000) { lastSaved.current = Date.now(); onProgress(t, el.duration); }
          // AniSkip: offer "Skip intro/credits" inside OP/ED, or auto-skip each once.
          const inIv = (iv: { start: number; end: number } | null | undefined) => iv && t >= iv.start && t < iv.end - 0.3;
          const credits = inIv(skips?.ending);
          if (skips) {
            const hit = inIv(skips.opening) ? { key: "op", label: "Skip intro", end: skips.opening!.end }
              : credits ? { key: "ed", label: "Skip credits", end: skips.ending!.end } : null;
            if (hit && !(hit.key === "ed" && next)) {   // with a next episode, credits = Up next
              if (S.autoSkip && !autoSkipped.current.has(hit.key)) { autoSkipped.current.add(hit.key); el.currentTime = hit.end; setActiveSkip(null); toast(hit.key === "op" ? "Intro skipped" : "Credits skipped"); }
              else if (!S.autoSkip) setActiveSkip({ label: hit.label, end: hit.end });
            } else if (activeSkip) setActiveSkip(null);
          }
          // Up next: last 20 s or the credits; the countdown starts at the credits (or the end).
          if (next && el.duration > 60) {
            const near = t >= el.duration - 20 || !!credits;
            if (near && upNext === "off") { setUpNext("shown"); if (credits) startCountdown(); }
            else if (!near && upNext === "shown" && countdown == null) setUpNext("off");
          }
        }}
        onVolumeChange={(e) => { setVolume(e.currentTarget.volume); setMuted(e.currentTarget.muted); }}
        onEnded={() => {
          setPlaying(false); setEnded(true); setShowControls(true);
          if (onProgress && video.current?.duration) onProgress(video.current.duration, video.current.duration);
          if (next && upNext !== "dismissed") { setUpNext("shown"); startCountdown(); }
        }}
        onError={(e) => { if (engineRef.current === "native") fail(`media error ${e.currentTarget.error?.code ?? ""}`.trim()); }}
      >
        {tracks.map((t, i) => (<track key={t.url || i} kind="subtitles" label={trackLabels[i]} srcLang={subLangCode(t.lang)} src={t.url} />))}
      </video>
      {/* tap/click layer over the picture: a plain div gets pointer events on every browser
          (iOS Safari can swallow them on <video>) */}
      <div className="vp-gesture" aria-hidden="true" onPointerUp={onSurfacePointerUp}
        onClick={() => { if (lastPointer.current === "mouse") togglePlay(); }}
        onDoubleClick={() => { if (lastPointer.current === "mouse") toggleFullscreen(); }} />
      {/* user subtitle appearance (Settings › Subtitles) applied to native + shaka cues */}
      <style>{subCss}</style>

      {/* top bar: back · title (show / episode) · lock · AirPlay · Episodes · Settings */}
      <div className="vp-top" onClick={(e) => e.stopPropagation()}>
        {onBack && <button className="vp-btn" aria-label="Back" title="Back" onClick={onBack}><ChevronLeft size={24} /></button>}
        <div className="vp-title">
          <span className="vp-title-1">{title}</span>
          {subtitle && <span className="vp-title-2">{subtitle}</span>}
        </div>
        <button className="vp-btn vp-lock-btn" aria-label="Lock screen" title="Lock screen" onClick={() => { setSettingsView(null); setLocked(true); pokeLock(); }}><Lock size={22} /></button>
        {airplay && <button className="vp-btn" aria-label="AirPlay" title="AirPlay" onClick={showAirplay}><Cast size={22} /></button>}
        {onEpisodes && <button className="vp-btn" aria-label="Episodes" title="Episodes (e)" onClick={onEpisodes}><ListVideo size={24} /></button>}
        <button className="vp-btn" aria-label="Settings" title="Settings (s)" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsView("root")}><Settings size={22} /></button>
      </div>

      {/* touch fullscreen: brightness (left) + volume (right, not on iOS where it's read-only) */}
      <EdgeSlider side="l" label="Brightness" value={bright} onChange={(v) => { setBright(v); nudgeControls(); }} icon={<Sun size={16} />} />
      {!ios && <EdgeSlider side="r" label="Volume" value={muted ? 0 : volume} onChange={(v) => { const el = video.current; if (el) { el.volume = v; el.muted = v === 0; } nudgeControls(); }} icon={<Volume2 size={16} />} />}

      {locked && (
        <div className="vp-lock" onPointerUp={(e) => { e.stopPropagation(); pokeLock(); }} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          {lockHint && <button className="vp-unlock" onClick={() => { setLocked(false); setLockHint(false); nudgeControls(); }}><Unlock size={18} /> Tap to unlock</button>}
        </div>
      )}

      {poster && (!ready || (!playing && current === 0)) && <img className="vp-poster" src={poster} alt="" />}
      <TorrentStats url={source.url} />

      <div className="center">
        <button className="c-skip" aria-label="Back 10 seconds" title="Back 10s (←)" onClick={() => { seekBy(-10); nudgeControls(); }}><Rewind10 size={26} /></button>
        {loading && !ended
          ? <div className="c-wait" role="status"><span className="vp-spinner" aria-hidden="true" /><span className="sr-only">Loading</span></div>
          : <button className="c-main" aria-label={ended ? "Replay" : playing ? "Pause" : "Play"} title={playing ? "Pause (k)" : "Play (k)"} onClick={togglePlay}>{ended ? <RotateCcw size={30} /> : playing ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}</button>}
        <button className="c-skip" aria-label="Forward 10 seconds" title="Forward 10s (→)" onClick={() => { seekBy(10); nudgeControls(); }}><Forward10 size={26} /></button>
      </div>
      {!ready && startingLabel && <p className="vp-starting" aria-hidden="true">{startingLabel}</p>}

      {bubble && <div className={`seek-bubble ${bubble.side}`} aria-hidden>{bubble.side === "l" ? "−" : "+"}{bubble.n}s</div>}

      {activeSkip && upNext !== "shown" && (
        <button className="btn btn-media vp-skip" onClick={(e) => { e.stopPropagation(); if (video.current) video.current.currentTime = activeSkip.end; setActiveSkip(null); }}>
          {activeSkip.label}
        </button>
      )}

      {upNext === "shown" && next && (
        <div className="upnext" role="region" aria-label="Up next">
          <div className="upnext-still">{next.still ? <img src={next.still} alt="" /> : null}</div>
          <div className="upnext-text">
            <span className="upnext-k">Up next</span>
            <strong className="upnext-t">{next.label}</strong>
            <div className="upnext-act">
              <button className="btn btn-accent btn-sm upnext-play" onClick={() => next.go()}>
                {countdown != null
                  ? <svg className="upnext-ring" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" /><circle key={next.label} className="upnext-ring-fill" cx="10" cy="10" r="8" /></svg>
                  : <Play size={16} fill="currentColor" />}
                {countdown != null ? <>Play now <span className="sr-only">(starts in {countdown} seconds)</span></> : "Play now"}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => { setUpNext("dismissed"); setCountdown(null); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="controls" onClick={(e) => e.stopPropagation()}>
        <div className="seek-row">
          <span className="vp-time">{fmt(current)}</span>
          <div className="seek"
            onPointerMove={(e) => { if (e.pointerType !== "mouse" || !duration) return; const r = e.currentTarget.getBoundingClientRect(); setHover(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))); }}
            onPointerLeave={() => setHover(null)}>
            <div className="track">
              <div className="buffered" style={{ transform: `scaleX(${bufPct / 100})` }} />
              <div className="played" style={{ transform: `scaleX(${pct / 100})` }} />
              {seg(skips?.opening)}{seg(skips?.ending)}
            </div>
            <div className="knob" style={{ left: `${pct}%` }} />
            {hover != null && <span className="seek-tip" style={{ left: `${hover * 100}%` } as CSSProperties}>{fmt(hover * duration)}</span>}
            {/* transparent native range overlay = reliable tap + drag + keyboard on every engine */}
            <input
              className="seek-range"
              type="range"
              min={0}
              max={duration || 0}
              step="any"
              value={Number.isFinite(current) ? current : 0}
              onChange={(e) => { const t = Number(e.target.value); setCurrent(t); if (video.current) video.current.currentTime = t; }}
              aria-label="Seek"
              aria-valuetext={`${fmt(current)} of ${fmt(duration)}`}
            />
          </div>
          <button className="vp-time vp-time-btn" onClick={() => setRemaining((v) => !v)} aria-label={remaining ? "Show total time" : "Show time left"}>
            {remaining ? `−${fmt(duration - current)}` : fmt(duration)}
          </button>
        </div>
        <div className="ctrlrow">
          <button className="vp-btn ptr-only" aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (k)" : "Play (k)"} onClick={togglePlay}>{playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}</button>
          <button className="vp-btn ptr-only" aria-label="Back 10 seconds" title="Back 10s (←)" onClick={() => seekBy(-10)}><Rewind10 size={22} /></button>
          <button className="vp-btn ptr-only" aria-label="Forward 10 seconds" title="Forward 10s (→)" onClick={() => seekBy(10)}><Forward10 size={22} /></button>
          {!ios && (
            <div className="vp-vol">
              <button className="vp-btn" aria-label={muted ? "Unmute" : "Mute"} title="Mute (m)" onClick={() => { if (video.current) video.current.muted = !video.current.muted; }}>{muted || volume === 0 ? <VolumeX size={22} /> : <Volume2 size={22} />}</button>
              <input className="vol" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => { if (video.current) { video.current.volume = Number(e.target.value); video.current.muted = false; } }} aria-label="Volume" />
            </div>
          )}
          <span className="grow" />
          {next && <button className="vp-btn" aria-label={`Next episode: ${next.label}`} title={`Next: ${next.label} (n)`} onClick={next.go}><SkipForward size={22} /></button>}
          <button className="vp-btn" aria-label="Subtitles" title={tracks.length ? "Subtitles (c) · right-click for options" : "Subtitles"} aria-pressed={ccOn}
            onClick={() => (tracks.length ? toggleCc() : setSettingsView("subs"))} onContextMenu={(e) => { e.preventDefault(); setSettingsView("subs"); }}>
            <Subtitles size={22} />
          </button>
          {pipOk && finePointer() && <button className="vp-btn" aria-label="Picture-in-picture" title="Picture-in-picture" onClick={togglePip}><PictureInPicture size={22} /></button>}
          <button className="vp-btn" aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} title="Fullscreen (f)" onClick={toggleFullscreen}>{fullscreen ? <Minimize size={22} /> : <Maximize size={22} />}</button>
        </div>
      </div>

      <SettingsPanel
        open={settingsOpen} onClose={() => setSettingsView(null)} container={stage} initialView={settingsView ?? undefined}
        levels={levels} level={curLevel} playingHeight={playingHeight} onLevel={pickQuality}
        audios={audios} audio={audioKey} onAudio={onAudio} boost={S.voiceBoost || 0} onBoost={setBoost}
        tracks={trackLabels} cc={ccIndex} onCc={chooseCc}
        rate={rate} onRate={setRate} series={series} hasSkips={hasSkips}
        onPip={pipOk && !finePointer() ? togglePip : undefined} onAirplay={airplay ? showAirplay : undefined}
        sourceLabel={sourceLabel} renderSource={renderSource} frame={grabFrame}
      />
    </div>
  );
}
