import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { getSettings } from "../lib/settings";
import { Check, Maximize, Pause, Play, RotateCcw, Settings, Subtitles, Volume2, VolumeX, X } from "./icons";

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
  const [ccOpen, setCcOpen] = useState(false);
  const [ccIndex, setCcIndex] = useState(-1);
  const [autoMuted, setAutoMuted] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [levels, setLevels] = useState<{ index: number; height: number; bitrate: number }[]>([]);
  const [curLevel, setCurLevel] = useState(-1); // -1 = Auto
  const [audioTracks, setAudioTracks] = useState<{ id: number; label: string }[]>([]);
  const [curAudio, setCurAudio] = useState(-1);

  const tracks = source.subtitles ?? [];
  const prefLangs = (getSettings() as unknown as { audioLanguages?: string[] }).audioLanguages ?? [];
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

  // Attach the source (hls.js for m3u8 where needed).
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    setError(null); setLoading(true); autostarted.current = false;
    setLevels([]); setAudioTracks([]); setCurLevel(-1); setCurAudio(-1);
    if (source.type === "m3u8" && !el.canPlayType("application/vnd.apple.mpegurl") && Hls.isSupported()) {
      const inst = new Hls({ enableWorker: true });
      hls.current = inst;
      inst.loadSource(source.url);
      inst.attachMedia(el);
      inst.on(Hls.Events.MANIFEST_PARSED, () => {
        // quality levels (distinct resolutions, highest first)
        const lv = inst.levels.map((l, index) => ({ index, height: l.height || 0, bitrate: l.bitrate || 0 }))
          .filter((l) => l.height > 0).sort((a, b) => b.height - a.height);
        setLevels(lv);
        if (wantAutoplay && !autostarted.current) { autostarted.current = true; start(); }
      });
      const syncAudio = () => {
        const at = inst.audioTracks.map((t) => ({ id: t.id, label: t.name || t.lang || `Track ${t.id + 1}` }));
        setAudioTracks(at);
        setCurAudio(inst.audioTrack);
        // auto-pick the user's preferred audio language if present
        if (at.length > 1 && prefLangs.length) {
          const want = at.find((t) => prefLangs.some((p) => t.label.toLowerCase().includes(p.toLowerCase())));
          if (want && want.id !== inst.audioTrack) inst.audioTrack = want.id;
        }
      };
      inst.on(Hls.Events.AUDIO_TRACKS_UPDATED, syncAudio);
      inst.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_e, d) => setCurAudio(d.id));
      inst.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => setCurLevel(inst.autoLevelEnabled ? -1 : d.level));
      inst.on(Hls.Events.ERROR, (_e, data) => { if (data.fatal) { setError("This source failed to load."); onFail?.(); } });
      return () => { inst.destroy(); hls.current = null; };
    }
    el.src = source.url;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

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
  function pickQuality(index: number) { const h = hls.current; if (!h) return; h.currentLevel = index; setCurLevel(index); setSettingsOpen(false); }
  function pickAudio(id: number) { const h = hls.current; if (!h) return; h.audioTrack = id; setCurAudio(id); setSettingsOpen(false); }

  const pct = duration ? (current / duration) * 100 : 0;
  const bufPct = duration ? (buffered / duration) * 100 : 0;
  const hasSettings = levels.length > 1 || audioTracks.length > 1;

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
        onCanPlay={() => { setLoading(false); if (wantAutoplay && !autostarted.current && source.type !== "m3u8") { autostarted.current = true; start(); } }}
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
            <div className="menu-wrap">
              <button aria-label="Subtitles" onClick={() => setCcOpen((v) => !v)}><Subtitles size={20} /></button>
              {ccOpen && (
                <div className="menu above right" onMouseLeave={() => setCcOpen(false)}>
                  <div className="menu-label">Subtitles</div>
                  <button className={`menu-item ${ccIndex < 0 ? "active" : ""}`} onClick={() => { setCcIndex(-1); setCcOpen(false); }}>Off</button>
                  {tracks.slice(0, 40).map((t, i) => (<button key={i} className={`menu-item ${ccIndex === i ? "active" : ""}`} onClick={() => { setCcIndex(i); setCcOpen(false); }}>{t.lang || `Track ${i + 1}`}</button>))}
                </div>
              )}
            </div>
          )}
          {hasSettings && (
            <div className="menu-wrap">
              <button aria-label="Quality & audio" onClick={() => setSettingsOpen((v) => !v)}><Settings size={20} /></button>
              {settingsOpen && (
                <div className="menu above right vp-settings" onMouseLeave={() => setSettingsOpen(false)}>
                  {audioTracks.length > 1 && (
                    <>
                      <div className="menu-label">Audio</div>
                      {audioTracks.map((t) => (
                        <button key={t.id} className={`menu-item ${curAudio === t.id ? "active" : ""}`} onClick={() => pickAudio(t.id)}>
                          <span>{t.label}</span>{curAudio === t.id && <Check size={14} />}
                        </button>
                      ))}
                    </>
                  )}
                  {levels.length > 1 && (
                    <>
                      <div className="menu-label">Quality</div>
                      <button className={`menu-item ${curLevel < 0 ? "active" : ""}`} onClick={() => pickQuality(-1)}>
                        <span>Auto{curLevel < 0 ? "" : ""}</span>{curLevel < 0 && <Check size={14} />}
                      </button>
                      {levels.map((l) => (
                        <button key={l.index} className={`menu-item ${curLevel === l.index ? "active" : ""}`} onClick={() => pickQuality(l.index)}>
                          <span>{l.height}p{l.bitrate ? ` · ${Math.round(l.bitrate / 1000)}k` : ""}</span>{curLevel === l.index && <Check size={14} />}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          <button aria-label="Fullscreen" onClick={toggleFullscreen}><Maximize size={20} /></button>
        </div>
      </div>
    </div>
  );
}
