import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { updateSettings, useSettings, type ClientSettings } from "../../lib/settings";
import { ListGroup, ListRow, Panel } from "../ui";

export type SettingsView = "root" | "quality" | "audio" | "subs" | "style" | "speed" | "source";

const TITLES: Record<SettingsView, string> = {
  root: "Settings", quality: "Quality", audio: "Audio", subs: "Subtitles", style: "Subtitle style", speed: "Playback speed", source: "Change source",
};
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const speedLabel = (r: number) => (r === 1 ? "Normal" : `${r}×`);
const BOOST = ["Off", "Low", "Medium", "High"];
const SIZES: { value: ClientSettings["subtitleSize"]; label: string }[] = [
  { value: "sm", label: "Small" }, { value: "md", label: "Medium" }, { value: "lg", label: "Large" }, { value: "xl", label: "Extra large" },
];
// Same values as Settings › Subtitles, so both places stay in sync.
const COLORS = [
  { value: "#ffffff", label: "White" }, { value: "#ffe082", label: "Yellow" }, { value: "#8ce99a", label: "Green" },
  { value: "#74c0fc", label: "Blue" }, { value: "#ffa8a8", label: "Pink" },
];
export const SUB_SIZE_PCT: Record<string, number> = { sm: 80, md: 100, lg: 135, xl: 175 };

export interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  container: HTMLElement | null;
  /** Open straight into a sub-view (CC right-click → Subtitles) */
  initialView?: SettingsView;
  levels: { index: number; height: number }[];
  /** -1 = Auto */
  level: number;
  /** Height of what's on screen now, for "Auto (1080p)" */
  playingHeight: number;
  onLevel: (index: number) => void;
  audios: { key: string; label: string }[];
  audio: string;
  onAudio: (key: string) => void;
  boost: number;
  onBoost: (level: number) => void;
  /** Subtitle track labels */
  tracks: string[];
  cc: number;
  onCc: (index: number) => void;
  rate: number;
  onRate: (r: number) => void;
  series: boolean;
  hasSkips: boolean;
  onPip?: () => void;
  onAirplay?: () => void;
  sourceLabel?: string;
  renderSource?: (close: () => void) => ReactNode;
  /** Current video frame as an image, for the subtitle style preview */
  frame?: () => string | undefined;
}

/** ⚙ in the player: navigation rows with their current values; each pushes a real sub-view. */
export default function SettingsPanel(p: SettingsPanelProps) {
  const S = useSettings();
  const [view, setView] = useState<SettingsView>("root");
  const [still, setStill] = useState<string | undefined>();
  useEffect(() => { if (p.open) setView(p.initialView ?? "root"); }, [p.open, p.initialView]);
  useEffect(() => { if (view === "style") setStill(p.frame?.()); /* freeze one frame for the preview */ }, [view]);   // eslint-disable-line react-hooks/exhaustive-deps

  const go = (v: SettingsView) => () => setView(v);
  const cur = p.levels.find((l) => l.index === p.level);
  const qualityValue = cur ? `${cur.height}p` : `Auto${p.playingHeight ? ` (${p.playingHeight}p)` : ""}`;
  const audioValue = p.audios.find((a) => a.key === p.audio)?.label ?? p.audios[0]?.label ?? "Default";
  const back = view === "root" ? undefined : view === "style" ? go("subs") : go("root");

  let body: ReactNode;
  if (view === "quality") {
    body = (
      <ListGroup role="radiogroup" label="Quality">
        <ListRow kind="choice" checked={p.level < 0} title="Auto" onClick={() => p.onLevel(-1)}
          description={`Adjusts to your connection${p.playingHeight ? ` · now ${p.playingHeight}p` : ""}`} />
        {p.levels.map((l) => <ListRow key={l.index} kind="choice" checked={p.level === l.index} title={`${l.height}p`} onClick={() => p.onLevel(l.index)} />)}
      </ListGroup>
    );
  } else if (view === "audio") {
    body = (
      <>
        <ListGroup role="radiogroup" label="Audio track">
          {p.audios.length > 1
            ? p.audios.map((a) => <ListRow key={a.key} kind="choice" checked={a.key === p.audio} title={a.label} onClick={() => p.onAudio(a.key)} />)
            : <ListRow kind="choice" checked title={audioValue} />}
        </ListGroup>
        {p.audios.length <= 1 && (
          <p className="set-help">
            This stream has one audio track. For another language, choose a different source.
            {p.renderSource && <> <button type="button" className="btn-link" onClick={go("source")}>Change source</button></>}
          </p>
        )}
        <h3 className="set-head">Dialogue boost</h3>
        <ListGroup role="radiogroup" label="Dialogue boost">
          {BOOST.map((b, i) => <ListRow key={b} kind="choice" checked={(p.boost || 0) === i} title={b} onClick={() => p.onBoost(i)} />)}
        </ListGroup>
      </>
    );
  } else if (view === "subs") {
    body = (
      <>
        <ListGroup role="radiogroup" label="Subtitles">
          <ListRow kind="choice" checked={p.cc < 0} title="Off" onClick={() => p.onCc(-1)} />
          {p.tracks.map((t, i) => <ListRow key={i} kind="choice" checked={p.cc === i} title={t} onClick={() => p.onCc(i)} />)}
        </ListGroup>
        {!p.tracks.length && <p className="set-help">This stream came without subtitles. Another source may have them.</p>}
        <div className="set-sep" />
        <ListGroup><ListRow kind="nav" title="Subtitle style" value={`${SIZES.find((s) => s.value === S.subtitleSize)?.label ?? "Medium"} · ${COLORS.find((c) => c.value === S.subtitleColor)?.label ?? "Custom"}`} onClick={go("style")} /></ListGroup>
      </>
    );
  } else if (view === "style") {
    const cue: CSSProperties = { color: S.subtitleColor, background: `rgba(0,0,0,${S.subtitleBgOpacity})`, fontSize: `${SUB_SIZE_PCT[S.subtitleSize] ?? 100}%` };
    body = (
      <>
        <div className="sub-preview" style={still ? { backgroundImage: `url(${still})` } : undefined} aria-hidden="true">
          <span style={cue}>This is how subtitles will look</span>
        </div>
        <h3 className="set-head">Size</h3>
        <ListGroup role="radiogroup" label="Size">
          {SIZES.map((s) => <ListRow key={s.value} kind="choice" checked={S.subtitleSize === s.value} title={s.label} onClick={() => updateSettings({ subtitleSize: s.value })} />)}
        </ListGroup>
        <h3 className="set-head">Text colour</h3>
        <ListGroup role="radiogroup" label="Text colour">
          {COLORS.map((c) => (
            <ListRow key={c.value} kind="choice" checked={S.subtitleColor === c.value} title={c.label}
              leading={<span className="swatch-dot" style={{ background: c.value }} />} onClick={() => updateSettings({ subtitleColor: c.value })} />
          ))}
        </ListGroup>
        <label className="set-slider">
          <span className="set-slider-top"><span>Background</span><span>{Math.round(S.subtitleBgOpacity * 100)}%</span></span>
          <input type="range" min={0} max={1} step={0.05} value={S.subtitleBgOpacity} onChange={(e) => updateSettings({ subtitleBgOpacity: Number(e.target.value) })} />
        </label>
      </>
    );
  } else if (view === "speed") {
    body = (
      <ListGroup role="radiogroup" label="Playback speed">
        {SPEEDS.map((r) => <ListRow key={r} kind="choice" checked={p.rate === r} title={speedLabel(r)} onClick={() => p.onRate(r)} />)}
      </ListGroup>
    );
  } else if (view === "source") {
    body = p.renderSource?.(p.onClose);
  } else {
    body = (
      <>
        <ListGroup>
          {p.levels.length > 1 && <ListRow kind="nav" title="Quality" value={qualityValue} onClick={go("quality")} />}
          <ListRow kind="nav" title="Audio" value={audioValue} onClick={go("audio")} />
          <ListRow kind="nav" title="Subtitles" value={p.cc < 0 ? "Off" : p.tracks[p.cc]} onClick={go("subs")} />
          <ListRow kind="nav" title="Playback speed" value={speedLabel(p.rate)} onClick={go("speed")} />
        </ListGroup>
        {(p.series || p.hasSkips) && (
          <>
            <div className="set-sep" />
            <ListGroup>
              {p.series && <ListRow kind="toggle" checked={S.autoNext} title="Autoplay next episode" onClick={() => updateSettings({ autoNext: !S.autoNext })} />}
              {p.hasSkips && <ListRow kind="toggle" checked={S.autoSkip} title="Skip intros and credits" onClick={() => updateSettings({ autoSkip: !S.autoSkip })} />}
            </ListGroup>
          </>
        )}
        <div className="set-sep" />
        <ListGroup>
          {p.renderSource && <ListRow kind="nav" title="Source" value={p.sourceLabel} onClick={go("source")} />}
          {p.onPip && <ListRow title="Picture-in-picture" onClick={() => { p.onClose(); p.onPip!(); }} />}
          {p.onAirplay && <ListRow title="AirPlay" onClick={() => { p.onClose(); p.onAirplay!(); }} />}
        </ListGroup>
      </>
    );
  }

  return (
    <Panel open={p.open} onClose={p.onClose} container={p.container} scrim={false} title={TITLES[view]} view={view} onBack={back} className="set-panel">
      {body}
    </Panel>
  );
}
