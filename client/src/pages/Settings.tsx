import { useEffect, useState } from "react";
import { api, type TorznabInfo } from "../lib/api";
import { useSettings, updateSettings, type ClientSettings } from "../lib/settings";
import { useStore, getSyncState, getSyncCode, getDeviceName, setDeviceName, getRoster, createSync, joinSync, disableSync, forgetDevice, bridgeCode, randomCode } from "../lib/store";
import { getTheme, setTheme, type Theme } from "../lib/theme";
import Dropdown from "../components/Dropdown";
import { copyText } from "../lib/clipboard";
import { Check, Copy, Moon, Sun, X } from "../components/icons";

const AUDIO_LANGS = [
  "English", "Hindi", "Tamil", "Telugu", "Malayalam", "Kannada", "Spanish",
  "French", "German", "Korean", "Japanese", "Chinese", "Arabic", "Russian",
  "Portuguese", "Italian",
];
const QUALITIES: { value: ClientSettings["quality"]; label: string }[] = [
  { value: "auto", label: "Auto" }, { value: "2160", label: "4K" }, { value: "1080", label: "1080p" }, { value: "720", label: "720p" },
];
const WARP_MODES: { value: ClientSettings["warp"]; label: string }[] = [
  { value: "off", label: "Off" }, { value: "required", label: "Required" }, { value: "fallback", label: "Fallback" }, { value: "all", label: "All" },
];
const SUB_SIZES: { value: ClientSettings["subtitleSize"]; label: string }[] = [
  { value: "sm", label: "Small" }, { value: "md", label: "Medium" }, { value: "lg", label: "Large" }, { value: "xl", label: "X-Large" },
];
const SUB_COLORS = ["#ffffff", "#ffe082", "#8ce99a", "#74c0fc", "#ffa8a8"];

function Toggle({ id, label, hint, on, onChange }: { id: string; label: string; hint?: string; on: boolean; onChange: () => void }) {
  return (
    <div className="field">
      <div className="field-row">
        <label htmlFor={id}>{label}</label>
        <button id={id} role="switch" aria-checked={on} className={on ? "switch on" : "switch"} onClick={onChange} />
      </div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/** Torrent indexer (Jackett / Prowlarr / Torznab) — instance-wide server config. */
function TorznabCard() {
  const [info, setInfo] = useState<TorznabInfo | null>(null);
  const [adminLock, setAdminLock] = useState(false);
  const [kind, setKind] = useState("jackett");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.config().then((c) => { if (!alive) return; setInfo(c.torznab); setAdminLock(c.adminLock); if (c.torznab) { setKind(c.torznab.kind); setUrl(c.torznab.url); } }).catch(() => {});
    return () => { alive = false; };
  }, []);

  async function save() {
    setBusy(true); setMsg("");
    try {
      const r = await api.saveTorznab({ kind, url, apiKey }, token || undefined);
      if (r.ok) { setInfo(r.torznab); setApiKey(""); setMsg(url && apiKey ? "Saved ✓" : "Cleared ✓"); }
      else setMsg(r.error || "Failed");
    } catch { setMsg("Failed"); }
    setBusy(false);
  }
  async function test() {
    setBusy(true); setMsg("Testing…");
    try { const r = await api.testTorznab(); setMsg(r.ok ? `Reachable ✓ — ${r.count} results for a sample query` : `Failed: ${r.error || "no response"}`); }
    catch { setMsg("Test failed"); }
    setBusy(false);
  }

  return (
    <section className="settings-card">
      <div className="settings-h" style={{ paddingTop: 0, borderTop: "none" }}>Torrent indexer</div>
      <div className="field">
        <div className="hint" style={{ marginTop: 0 }}>
          Connect <b>Jackett</b> or <b>Prowlarr</b> to fan torrent search across every indexer you've configured (Movies/TV/Anime torrent providers use it). This is server-wide, not per-device.
        </div>
      </div>
      {info && (
        <div className="note" style={{ borderColor: "var(--success)" }}>
          Active: <b>{info.kind}</b> at <span className="mono">{info.url}</span>{info.hasKey ? " · key set" : " · no key"} <span className="subtle">({info.source === "ui" ? "from Settings" : "from env"})</span>
        </div>
      )}
      <div className="field">
        <label>Type</label>
        <div className="segmented">
          {["jackett", "prowlarr", "torznab"].map((k) => (
            <button key={k} className={kind === k ? "seg-opt active" : "seg-opt"} onClick={() => setKind(k)} style={{ textTransform: "capitalize" }}>{k}</button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>URL</label>
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={kind === "jackett" ? "http://jackett:9117" : kind === "prowlarr" ? "http://prowlarr:9696" : "http://host/api/v2.0/…/torznab/api"} />
        <div className="hint">{kind === "jackett" ? "Jackett base URL — the all-indexers endpoint is built automatically." : "Full Torznab feed URL."}</div>
      </div>
      <div className="field">
        <label>API key</label>
        <input className="input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={info?.hasKey ? "•••••• (leave blank to keep)" : "API key"} />
      </div>
      {adminLock && (
        <div className="field">
          <label>Admin token</label>
          <input className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Required (ADMIN_TOKEN is set)" />
        </div>
      )}
      <div className="sync-row">
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>Save</button>
        <button className="btn btn-sm" disabled={busy || !info} onClick={test}>Test</button>
        <button className="btn btn-sm" disabled={busy} onClick={() => { setUrl(""); setApiKey(""); setKind("jackett"); api.saveTorznab({ kind: "jackett", url: "", apiKey: "" }, token || undefined).then(() => { setInfo(null); setMsg("Cleared ✓"); }); }}>Clear</button>
        {msg && <span className="subtle" style={{ fontSize: "var(--text-sm)" }}>{msg}</span>}
      </div>
    </section>
  );
}

export default function Settings() {
  const s = useSettings();
  useStore();
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const applyTheme = (t: Theme) => { setTheme(t); setThemeState(t); };

  const syncState = getSyncState();
  const syncCode = getSyncCode();
  const roster = getRoster();
  const myDevice = (() => { try { return localStorage.getItem("sp.device.id") || ""; } catch { return ""; } })();

  const [name, setName] = useState(getDeviceName());
  const [createCode, setCreateCode] = useState(randomCode());
  const [joinCode, setJoinCode] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [bridge, setBridge] = useState("");
  const [bridgeMsg, setBridgeMsg] = useState("");

  const removeAudio = (lang: string) => updateSettings({ audioLanguages: s.audioLanguages.filter((l) => l !== lang) });
  const addAudio = (lang: string) => { if (lang && !s.audioLanguages.includes(lang)) updateSettings({ audioLanguages: [...s.audioLanguages, lang] }); };
  const availableAudio = AUDIO_LANGS.filter((l) => !s.audioLanguages.includes(l));

  async function doCreate() { setMsg(""); try { await createSync(createCode); } catch (e: any) { setMsg(e.message); } }
  async function doJoin() { setMsg(""); try { await joinSync(joinCode); } catch (e: any) { setMsg(e.message); } }
  async function doBridge() { setBridgeMsg(""); try { await bridgeCode(bridge); setBridge(""); setBridgeMsg("Bridged ✓"); setTimeout(() => setBridgeMsg(""), 2000); } catch (e: any) { setBridgeMsg(e.message); } }

  return (
    <div className="container settings-page">
      <h1 className="page-title">Settings</h1>
      <div className="settings-grid">
        {/* ── Appearance ── */}
        <section className="settings-card">
          <div className="settings-h" style={{ paddingTop: 0, borderTop: "none" }}>Appearance</div>
          <div className="field">
            <label>Theme</label>
            <div className="segmented">
              <button className={theme === "dark" ? "seg-opt active" : "seg-opt"} onClick={() => applyTheme("dark")}><Moon size={14} /> Dark</button>
              <button className={theme === "light" ? "seg-opt active" : "seg-opt"} onClick={() => applyTheme("light")}><Sun size={14} /> Light</button>
            </div>
          </div>
          <div className="field">
            <label>Subtitle size</label>
            <div className="segmented">
              {SUB_SIZES.map((z) => (
                <button key={z.value} className={s.subtitleSize === z.value ? "seg-opt active" : "seg-opt"} onClick={() => updateSettings({ subtitleSize: z.value })}>{z.label}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Subtitle colour</label>
            <div className="rchips" style={{ marginBottom: 0 }}>
              {SUB_COLORS.map((c) => (
                <button key={c} aria-label={c} onClick={() => updateSettings({ subtitleColor: c })}
                  style={{ width: 28, height: 28, borderRadius: "var(--radius-full)", background: c, border: s.subtitleColor === c ? "2px solid var(--accent)" : "2px solid var(--border)", cursor: "pointer" }} />
              ))}
            </div>
          </div>
          <div className="field">
            <label>Subtitle background <span className="subtle">({Math.round(s.subtitleBgOpacity * 100)}%)</span></label>
            <input className="slider" type="range" min={0} max={1} step={0.1} value={s.subtitleBgOpacity} onChange={(e) => updateSettings({ subtitleBgOpacity: Number(e.target.value) })} />
            <div className="hint">Darkens the box behind subtitles for readability over bright scenes.</div>
          </div>
        </section>

        {/* ── Playback & content ── */}
        <section className="settings-card">
          <div className="settings-h" style={{ paddingTop: 0, borderTop: "none" }}>Playback &amp; content</div>
          <div className="field">
            <label>Preferred audio languages</label>
            <div className="rchips">
              {s.audioLanguages.map((lang, i) => (
                <span key={lang} className={i === 0 ? "rchip primary" : "rchip"}>
                  <span className="idx">{i + 1}</span>{lang}
                  <button className="x" aria-label="Remove" onClick={() => removeAudio(lang)}><X size={12} /></button>
                </span>
              ))}
            </div>
            <Dropdown value="" placeholder="Add a language…" options={availableAudio.map((l) => ({ value: l, label: l }))} onChange={addAudio} ariaLabel="Add audio language" />
            <div className="hint">Sources matching these languages are sorted first (primary on top).</div>
          </div>
          <div className="field">
            <label>Anime track</label>
            <div className="segmented">
              <button className={s.anime === "sub" ? "seg-opt active" : "seg-opt"} onClick={() => updateSettings({ anime: "sub" })}>Subbed</button>
              <button className={s.anime === "dub" ? "seg-opt active" : "seg-opt"} onClick={() => updateSettings({ anime: "dub" })}>Dubbed</button>
            </div>
          </div>
          <div className="field">
            <label>Default quality</label>
            <div className="segmented">
              {QUALITIES.map((q) => (
                <button key={q.value} className={s.quality === q.value ? "seg-opt active" : "seg-opt"} onClick={() => updateSettings({ quality: q.value })}>{q.label}</button>
              ))}
            </div>
          </div>
          <Toggle id="autoplay" label="Autoplay" hint="Start the best source automatically when sources load." on={s.autoplay} onChange={() => updateSettings({ autoplay: !s.autoplay })} />
          <Toggle id="autoNext" label="Auto-play next episode" hint="Advance to the next episode automatically when one ends." on={s.autoNext} onChange={() => updateSettings({ autoNext: !s.autoNext })} />
          <Toggle id="autoSkip" label="Auto-skip openings/endings" hint="Skip anime OP/ED automatically using AniSkip data." on={s.autoSkip} onChange={() => updateSettings({ autoSkip: !s.autoSkip })} />
          <Toggle id="adult" label="Show 18+ content" hint="Off by default — adult / hentai titles are hidden across browse and search." on={s.adult} onChange={() => updateSettings({ adult: !s.adult })} />
          <div className="field">
            <label>WARP proxy</label>
            <div className="segmented">
              {WARP_MODES.map((m) => (
                <button key={m.value} className={s.warp === m.value ? "seg-opt active" : "seg-opt"} onClick={() => updateSettings({ warp: m.value })}>{m.label}</button>
              ))}
            </div>
            <div className="hint"><b>Required</b> = only providers that need it · <b>Fallback</b> = retry a failed provider via WARP · <b>All</b> = everything. Needs a WARP proxy configured on the server.</div>
          </div>
        </section>

        {/* ── Torrent indexer (Jackett/Prowlarr) ── */}
        <TorznabCard />

        {/* ── Sync ── */}
        <section className="settings-card">
          <div className="settings-h" style={{ paddingTop: 0, borderTop: "none" }}>Sync across devices</div>
          <div className="field">
            <label>This device</label>
            <div className="sync-row">
              <input className="input" style={{ flex: 1, minWidth: 140 }} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => setDeviceName(name)} placeholder="Device name" />
            </div>
            <div className="hint">Shown to your other devices in the list below.</div>
          </div>
          {syncCode ? (
            <div className="field">
              <div className="field-row">
                <label>Sync code</label>
                <span className={`badge ${syncState === "live" ? "badge-success" : syncState === "error" ? "badge-error" : "badge-warning"}`}>{syncState}</span>
              </div>
              <div className="sync-row">
                <code className="sync-code">{syncCode}</code>
                <button className="btn btn-sm" onClick={() => { copyText(syncCode).then((ok) => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1500); } }); }}>{copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}</button>
                <button className="btn btn-sm" onClick={() => disableSync()}>Disconnect</button>
              </div>
              <div className="hint">Enter this code on another device to link it.</div>
              <div style={{ marginTop: "var(--space-4)" }}>
                <div className="block-label">Devices ({roster.length})</div>
                <div className="roster">
                  {roster.map((d) => (
                    <div className="roster-row" key={d.id}>
                      <span className={`roster-dot ${d.online ? "online" : ""}`} title={d.online ? "online" : "offline"} />
                      <span className="rn">{d.name}{d.id === myDevice ? " (this device)" : ""}</span>
                      {d.id !== myDevice && <button className="btn btn-icon btn-ghost btn-sm" aria-label="Forget device" onClick={() => forgetDevice(d.id)}><X size={14} /></button>}
                    </div>
                  ))}
                  {roster.length === 0 && <div className="subtle" style={{ fontSize: "var(--text-sm)" }}>No devices yet.</div>}
                </div>
              </div>
              <div style={{ marginTop: "var(--space-4)" }}>
                <div className="block-label">Bridge another code</div>
                <div className="sync-row">
                  <input className="input" style={{ flex: 1, minWidth: 120 }} value={bridge} onChange={(e) => setBridge(e.target.value)} placeholder="Other code" />
                  <button className="btn btn-sm" disabled={!bridge.trim()} onClick={doBridge}>Bridge</button>
                </div>
                <div className="hint">{bridgeMsg ? <b style={{ color: bridgeMsg.includes("✓") ? "var(--success)" : "var(--error)" }}>{bridgeMsg}</b> : "Merge another network into this one. Bridges are transitive."}</div>
              </div>
            </div>
          ) : (
            <>
              <div className="field">
                <label>Create a code</label>
                <div className="sync-row">
                  <input className="input" style={{ flex: 1, minWidth: 120 }} value={createCode} onChange={(e) => setCreateCode(e.target.value)} placeholder="my-code" />
                  <button className="btn btn-sm" onClick={() => setCreateCode(randomCode())}>Random</button>
                  <button className="btn btn-primary btn-sm" disabled={!createCode.trim()} onClick={doCreate}>Create</button>
                </div>
                <div className="hint">Pick a unique code, then enter it on your other devices.</div>
              </div>
              <div className="field">
                <label>Join an existing code</label>
                <div className="sync-row">
                  <input className="input" style={{ flex: 1, minWidth: 120 }} value={joinCode} onChange={(e) => setJoinCode(e.target.value)} placeholder="Enter code" />
                  <button className="btn btn-sm" disabled={!joinCode.trim()} onClick={doJoin}>Join</button>
                </div>
                <div className="hint">{msg ? <b style={{ color: "var(--error)" }}>{msg}</b> : "Link this device to a code created on another device."}</div>
              </div>
            </>
          )}
          {syncCode && msg && <div className="hint"><b style={{ color: "var(--error)" }}>{msg}</b></div>}
        </section>
      </div>
      <div className="subtle" style={{ fontSize: "var(--text-xs)", marginTop: "var(--space-5)" }}>Changes are saved automatically and sync across your linked devices.</div>
    </div>
  );
}
