import { useState, type ComponentType } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { useSettings, updateSettings, type ClientSettings } from "../lib/settings";
import { useStore, getSyncState, getSyncCode, getDeviceName, setDeviceName, getRoster, createSync, joinSync, disableSync, forgetDevice, bridgeCode, randomCode } from "../lib/store";
import { setThemePref, useThemePref, type ThemePref } from "../lib/theme";
import { useHealth } from "../lib/queries";
import { useDocTitle } from "../lib/useDocTitle";
import { copyText } from "../lib/clipboard";
import { rove } from "../components/ui/rove";
import { Button, IconButton, InputChip, ListGroup, ListRow, Menu, SegmentedControl, StatusDot, toast } from "../components/ui";
import ConfirmDialog from "../components/ConfirmDialog";
import { Check, ChevronLeft, ChevronRight, Copy, Info, Layers, Moon, Play, Plus, Shield, Subtitles, Users, X } from "../components/icons";
import ServerSection from "./settings/Server";
import AddonsSection from "./settings/Addons";
import { Field, Group } from "./settings/shared";
import { version } from "../../package.json";
import "../styles/settings.css";

const AUDIO_LANGS = [
  "English", "Hindi", "Tamil", "Telugu", "Malayalam", "Kannada", "Spanish",
  "French", "German", "Korean", "Japanese", "Chinese", "Arabic", "Russian",
  "Portuguese", "Italian",
];
const SUB_SIZES: { value: ClientSettings["subtitleSize"]; label: string; pct: number }[] = [
  { value: "sm", label: "Small", pct: 80 }, { value: "md", label: "Medium", pct: 100 }, { value: "lg", label: "Large", pct: 135 }, { value: "xl", label: "Extra large", pct: 175 },
];
const SUB_COLORS = [
  { value: "#ffffff", label: "White" }, { value: "#ffe082", label: "Yellow" }, { value: "#8ce99a", label: "Green" },
  { value: "#74c0fc", label: "Blue" }, { value: "#ffa8a8", label: "Pink" },
];
const THEMES: { value: ThemePref; label: string }[] = [{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "Match device" }];
const SYNC: Record<string, { tone: "success" | "warning" | "error" | "neutral"; text: string }> = {
  live: { tone: "success", text: "Synced" },
  connecting: { tone: "warning", text: "Connecting…" },
  error: { tone: "error", text: "Couldn't sync. Check the server address." },
  off: { tone: "neutral", text: "Not connected" },
};
const MIN_CODE = 8;

type Section = { id: string; label: string; icon: ComponentType<{ size?: number }>; Body: ComponentType; summary: (s: ClientSettings) => string };
const SECTIONS: Section[] = [
  { id: "playback", label: "Playback", icon: Play, Body: Playback, summary: (s) => `${s.audioLanguages.length ? s.audioLanguages.join(", ") : "Original audio"} · anime ${s.anime === "dub" ? "dubbed" : "subtitled"}` },
  { id: "subtitles", label: "Subtitles", icon: Subtitles, Body: SubtitlesSection, summary: (s) => `${SUB_SIZES.find((x) => x.value === s.subtitleSize)?.label ?? "Medium"}, ${SUB_COLORS.find((c) => c.value === s.subtitleColor)?.label.toLowerCase() ?? "custom colour"}` },
  { id: "appearance", label: "Appearance", icon: Moon, Body: Appearance, summary: () => THEMES.find((t) => t.value === useThemePref())?.label ?? "Dark" },
  { id: "sync", label: "Sync", icon: Users, Body: Sync, summary: () => SYNC[getSyncState()]?.text.split(".")[0] ?? "Not connected" },
  { id: "server", label: "Server", icon: Shield, Body: ServerSection, summary: () => "Torrents, provider order, indexer" },
  { id: "addons", label: "Addons", icon: Layers, Body: AddonsSection, summary: () => "Nuvio repos and Stremio addons" },
  { id: "about", label: "About", icon: Info, Body: About, summary: () => `Version ${version}` },
];

/**
 * Settings. Tablet/desktop: section nav on the left, one section on the right (/settings/:section,
 * /settings = Playback). Phone: /settings is the list of sections with their current values,
 * each section is its own page with a back button.
 */
export default function Settings() {
  const { section } = useParams();
  const s = useSettings();
  useStore();
  const active = SECTIONS.find((x) => x.id === section);
  const current = active ?? SECTIONS[0];
  useDocTitle(active ? `${active.label} settings` : "Settings");
  if (section && !active) return <Navigate to="/settings" replace />;

  return (
    <div className="container settings" data-root={section ? undefined : ""}>
      <div className="settings-head">
        <Button className="settings-back" variant="ghost" size="sm" to="/settings" icon={<ChevronLeft size={20} />}>Settings</Button>
        <h1 className="t-h1 settings-title">Settings</h1>
      </div>
      <nav className="settings-nav" aria-label="Settings sections">
        {SECTIONS.map((x) => (
          <Link key={x.id} to={`/settings/${x.id}`} className="settings-nav-item" aria-current={x === current ? "page" : undefined}
            data-current={x === current && section ? "" : undefined}>
            <x.icon size={20} />
            <span className="sn-text"><span className="sn-label">{x.label}</span><span className="sn-sum"><Summary of={x} s={s} /></span></span>
            <ChevronRight size={20} className="sn-chev" />
          </Link>
        ))}
      </nav>
      <section className="settings-content" aria-labelledby="settings-h">
        <h2 id="settings-h" className="settings-h">{current.label}</h2>
        <current.Body key={current.id} />
      </section>
    </div>
  );
}
// summaries may call hooks (theme), so each is its own component
function Summary({ of, s }: { of: Section; s: ClientSettings }) { return <>{of.summary(s)}</>; }

function Playback() {
  const s = useSettings();
  return (
    <>
      <AudioLanguages />
      <Field label="Anime audio" desc="Japanese audio with subtitles, or a dub in your language when one exists.">
        <SegmentedControl label="Anime audio" value={s.anime} options={[{ value: "sub", label: "Subtitled" }, { value: "dub", label: "Dubbed" }]}
          onChange={(v) => updateSettings({ anime: v })} />
      </Field>
      <Group title="Autoplay and content">
        <ListGroup divided>
          <ListRow kind="toggle" checked={s.autoNext} onClick={() => updateSettings({ autoNext: !s.autoNext })}
            title="Autoplay next episode" description="Starts the next episode when one ends." />
          <ListRow kind="toggle" checked={s.autoSkip} onClick={() => updateSettings({ autoSkip: !s.autoSkip })}
            title="Skip intros and credits" description="Skips openings and endings when their times are known, mostly for anime." />
          <ListRow kind="toggle" checked={s.adult} onClick={() => updateSettings({ adult: !s.adult })}
            title="Show 18+ titles" description="When off, adult titles stay out of browse and search." />
        </ListGroup>
      </Group>
    </>
  );
}

function SubtitlesSection() {
  const s = useSettings();
  const pct = SUB_SIZES.find((x) => x.value === s.subtitleSize)?.pct ?? 100;
  return (
    <>
      <div className="sub-preview media-dark" aria-hidden="true">
        <span className="sub-cue" style={{ color: s.subtitleColor, background: `rgba(0,0,0,${s.subtitleBgOpacity})`, fontSize: `calc(1.125rem * ${pct / 100})` }}>
          This is how subtitles will look.
        </span>
      </div>
      <Field label="Size" stack>
        <SegmentedControl label="Subtitle size" value={s.subtitleSize} options={SUB_SIZES} onChange={(v) => updateSettings({ subtitleSize: v })} />
      </Field>
      <Field label="Colour" stack>
        <div role="radiogroup" aria-label="Subtitle colour" className="swatches" onKeyDown={(e) => { const el = rove(e, '[role="radio"]'); if (el) updateSettings({ subtitleColor: el.dataset.value! }); }}>
          {SUB_COLORS.map((c) => {
            const on = s.subtitleColor === c.value;
            return (
              <button key={c.value} type="button" role="radio" aria-checked={on} tabIndex={on ? 0 : -1} data-value={c.value} className="swatch-opt"
                onClick={() => updateSettings({ subtitleColor: c.value })}>
                <span className="swatch-dot" style={{ background: c.value }}>{on && <Check size={14} />}</span>{c.label}
              </button>
            );
          })}
        </div>
      </Field>
      <div className="set-field" data-stack="">
        <div className="set-field-text set-slider-head">
          <label className="set-label" htmlFor="sub-bg">Background</label>
          <span className="set-value">{Math.round(s.subtitleBgOpacity * 100)}%</span>
        </div>
        <input id="sub-bg" className="slider" type="range" min={0} max={1} step={0.1} value={s.subtitleBgOpacity}
          onChange={(e) => updateSettings({ subtitleBgOpacity: Number(e.target.value) })} />
      </div>
      <p className="set-desc">Subtitle style is saved on this device only.</p>
    </>
  );
}

/** Preferred audio, in order. Empty = the server picks the title's original language, then English. */
function AudioLanguages() {
  const s = useSettings();
  const add = (lang: string) => { if (!s.audioLanguages.includes(lang)) updateSettings({ audioLanguages: [...s.audioLanguages, lang] }); };
  const left = AUDIO_LANGS.filter((l) => !s.audioLanguages.includes(l));
  return (
    <Field label="Audio language" stack desc={s.audioLanguages.length
      ? "Sources with these audio tracks are tried first, in this order. Remove them all to go back to each title's original language."
      : "Each title plays in its original language, with English as a backup. Add a language, such as Hindi, to try it first."}>
      <div className="chip-row">
        {s.audioLanguages.map((l) => (
          <InputChip key={l} removeLabel={`Remove ${l}`} onRemove={() => updateSettings({ audioLanguages: s.audioLanguages.filter((x) => x !== l) })}>{l}</InputChip>
        ))}
        {left.length > 0 && (
          <Menu label="Add an audio language" items={left.map((l) => ({ label: l, onSelect: () => add(l) }))}
            trigger={(p) => <Button {...p} variant="secondary" size="sm" icon={<Plus size={16} />}>Add language</Button>} />
        )}
      </div>
    </Field>
  );
}

function Appearance() {
  const pref = useThemePref();
  return (
    <Field label="Theme" desc="Artwork and the player stay dark in every theme.">
      <SegmentedControl label="Theme" value={pref} options={THEMES} onChange={setThemePref} />
    </Field>
  );
}

function Sync() {
  useStore();
  const state = SYNC[getSyncState()] ?? SYNC.off;
  const code = getSyncCode();
  const roster = getRoster();
  const me = (() => { try { return localStorage.getItem("sp.device.id") || ""; } catch { return ""; } })();
  const [name, setName] = useState(getDeviceName());
  const [create, setCreate] = useState(randomCode);
  const [join, setJoin] = useState("");
  const [bridge, setBridge] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [unlink, setUnlink] = useState(false);
  const codeOk = create.trim().length >= MIN_CODE && new Set(create.trim()).size >= 4;
  const run = async (fn: () => Promise<void>, done?: string) => {
    setErr(""); setBusy(true);
    try { await fn(); if (done) toast(done, { tone: "success" }); } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  return (
    <>
      <p className="set-intro">Link your devices with a sync code. History, My List and preferences then follow you to every device that uses it.</p>
      <div className="sync-state" role="status"><StatusDot tone={state.tone} />{state.text}</div>

      <Group title="This device's name">
        <input className="input" aria-label="This device's name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setDeviceName(name.trim() || getDeviceName())} autoComplete="off" />
      </Group>

      {code ? (
        <>
          <Group title="Sync code" desc="Enter this code on another device to link it. Anyone with the code can see your history, so keep it private.">
            <div className="inline-form">
              <code className="sync-code">{code}</code>
              <Button icon={<Copy size={20} />} onClick={() => copyText(code).then((ok) => ok && toast("Code copied", { tone: "success" }))}>Copy</Button>
            </div>
          </Group>
          <Group title={`Devices (${roster.length})`}>
            {roster.length ? (
              <ListGroup divided>
                {roster.map((d) => (
                  <ListRow key={d.id} leading={<StatusDot tone={d.online ? "success" : "neutral"} />} title={d.id === me ? `${d.name} (this device)` : d.name}
                    description={d.online ? "Online" : "Offline"}
                    trailing={d.id !== me ? <IconButton size="sm" label={`Forget ${d.name}`} onClick={() => forgetDevice(d.id)}><X size={16} /></IconButton> : undefined} />
                ))}
              </ListGroup>
            ) : <p className="set-desc">No other devices yet.</p>}
          </Group>
          <Group title="Merge another code" desc="Have a second code from before? Merge it and both sets of devices share one history.">
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run(async () => { await bridgeCode(bridge); setBridge(""); }, "Codes merged"); }}>
              <input className="input mono" aria-label="Other sync code" value={bridge} onChange={(e) => setBridge(e.target.value)} autoCapitalize="off" autoComplete="off" spellCheck={false} />
              <Button type="submit" disabled={!bridge.trim() || busy}>Merge</Button>
            </form>
          </Group>
          <div className="set-actions"><Button variant="danger" onClick={() => setUnlink(true)}>Unlink this device</Button></div>
          {unlink && <ConfirmDialog title="Unlink this device?" body="It stops syncing but keeps what's already here. You can link it again with the code."
            confirm="Unlink" cancel="Keep linked" onClose={() => setUnlink(false)} onConfirm={() => disableSync()} />}
        </>
      ) : (
        <>
          <Group title="Start syncing" desc={codeOk ? "We made a random code for you. You can change it." : `Use at least ${MIN_CODE} characters with some variety.`}>
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (codeOk) run(() => createSync(create), "Sync is on"); }}>
              <input className="input mono" aria-label="New sync code" value={create} onChange={(e) => setCreate(e.target.value)} autoCapitalize="off" autoComplete="off" spellCheck={false} />
              <Button variant="ghost" onClick={() => setCreate(randomCode())}>New code</Button>
              <Button type="submit" variant="solid" disabled={!codeOk || busy}>Create</Button>
            </form>
          </Group>
          <Group title="Join from another device" desc="Already syncing somewhere else? Enter that device's code.">
            <form className="inline-form" onSubmit={(e) => { e.preventDefault(); run(() => joinSync(join), "Sync is on"); }}>
              <input className="input mono" aria-label="Existing sync code" value={join} onChange={(e) => setJoin(e.target.value)} autoCapitalize="off" autoComplete="off" spellCheck={false} />
              <Button type="submit" disabled={!join.trim() || busy}>Join</Button>
            </form>
          </Group>
        </>
      )}
      {err && <p className="set-error" role="alert">{err}</p>}
    </>
  );
}

function About() {
  const h = useHealth();
  return (
    <ListGroup divided>
      <ListRow title="Version" value={version} />
      <ListRow title="Title data" description={h.data ? (h.data.tmdb === "live" ? "Live from TMDB." : "Backup data. Add a TMDB key on the server for full, current titles.") : h.isError ? "Couldn't reach the server." : "Checking…"}
        leading={<StatusDot tone={!h.data ? (h.isError ? "error" : "neutral") : h.data.tmdb === "live" ? "success" : "warning"} />} />
      <ListRow kind="nav" to="/settings/providers" title="Provider health" description="Which providers are reachable right now." />
    </ListGroup>
  );
}
