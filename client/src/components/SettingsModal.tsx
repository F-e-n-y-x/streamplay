import { useState } from "react";
import { getSettings, setSettings, type ClientSettings } from "../lib/settings";
import { useStore, getSyncState, getSyncCode, getDeviceName, setDeviceName, getRoster, createSync, joinSync, disableSync, forgetDevice, bridgeCode, randomCode } from "../lib/store";
import Dropdown from "./Dropdown";
import { Check, Copy, X } from "./icons";

const AUDIO_LANGS = [
  "English", "Hindi", "Tamil", "Telugu", "Malayalam", "Kannada", "Spanish",
  "French", "German", "Korean", "Japanese", "Chinese", "Arabic", "Russian",
  "Portuguese", "Italian",
];
const QUALITIES: { value: ClientSettings["quality"]; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "2160", label: "4K" },
  { value: "1080", label: "1080p" },
  { value: "720", label: "720p" },
];

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [draft, setDraft] = useState<ClientSettings>(getSettings());
  useStore();
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

  function save() { setSettings(draft); onClose(); }
  function removeAudio(lang: string) { setDraft({ ...draft, audioLanguages: draft.audioLanguages.filter((l) => l !== lang) }); }
  function addAudio(lang: string) { if (lang && !draft.audioLanguages.includes(lang)) setDraft({ ...draft, audioLanguages: [...draft.audioLanguages, lang] }); }
  const availableAudio = AUDIO_LANGS.filter((l) => !draft.audioLanguages.includes(l));

  async function doCreate() { setMsg(""); try { await createSync(createCode); } catch (e: any) { setMsg(e.message); } }
  async function doJoin() { setMsg(""); try { await joinSync(joinCode); } catch (e: any) { setMsg(e.message); } }
  async function doBridge() { setBridgeMsg(""); try { await bridgeCode(bridge); setBridge(""); setBridgeMsg("Bridged ✓"); setTimeout(() => setBridgeMsg(""), 2000); } catch (e: any) { setBridgeMsg(e.message); } }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Settings</h3>
          <button className="btn btn-icon btn-ghost btn-sm" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="modal-body">
          <div className="settings-h">Playback &amp; content</div>

          <div className="field">
            <label>Preferred audio languages</label>
            <div className="rchips">
              {draft.audioLanguages.map((lang, i) => (
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
              <button className={draft.anime === "sub" ? "seg-opt active" : "seg-opt"} onClick={() => setDraft({ ...draft, anime: "sub" })}>Subbed</button>
              <button className={draft.anime === "dub" ? "seg-opt active" : "seg-opt"} onClick={() => setDraft({ ...draft, anime: "dub" })}>Dubbed</button>
            </div>
            <div className="hint">Preferred audio track for anime titles.</div>
          </div>

          <div className="field">
            <label>Default quality</label>
            <div className="segmented">
              {QUALITIES.map((q) => (
                <button key={q.value} className={draft.quality === q.value ? "seg-opt active" : "seg-opt"} onClick={() => setDraft({ ...draft, quality: q.value })}>{q.label}</button>
              ))}
            </div>
            <div className="hint">Pre-selects this quality filter when sources load.</div>
          </div>

          <div className="field">
            <div className="field-row">
              <label htmlFor="autoplay">Autoplay</label>
              <button id="autoplay" role="switch" aria-checked={draft.autoplay} className={draft.autoplay ? "switch on" : "switch"} onClick={() => setDraft({ ...draft, autoplay: !draft.autoplay })} />
            </div>
            <div className="hint">Start the best source automatically.</div>
          </div>

          <div className="field">
            <div className="field-row">
              <label htmlFor="adult">Show 18+ content</label>
              <button id="adult" role="switch" aria-checked={draft.adult} className={draft.adult ? "switch on" : "switch"} onClick={() => setDraft({ ...draft, adult: !draft.adult })} />
            </div>
            <div className="hint">Off by default — adult / hentai titles are hidden across browse and search.</div>
          </div>

          <div className="settings-h">Sync across devices</div>

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
                <button className="btn btn-sm" onClick={() => { navigator.clipboard.writeText(syncCode).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}>{copied ? <><Check size={14} /> Copied</> : <><Copy size={14} /> Copy</>}</button>
                <button className="btn btn-sm" onClick={() => disableSync()}>Disconnect</button>
              </div>
              <div className="hint">Enter this code on another device to link it. Up to many devices can share one code.</div>

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
                <div className="hint">{bridgeMsg ? <b style={{ color: bridgeMsg.includes("✓") ? "var(--success)" : "var(--error)" }}>{bridgeMsg}</b> : "Merge another network into this one. Bridges are transitive — if A links B and B links C, all three share one library."}</div>
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
        </div>

        <div className="modal-foot">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
