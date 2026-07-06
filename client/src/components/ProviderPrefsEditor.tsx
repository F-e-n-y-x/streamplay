import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { ProviderInfo } from "../lib/types";
import { useSettings, updateSettings } from "../lib/settings";
import { ChevronDown, ChevronUp, X } from "./icons";

const KIND_LABEL: Record<string, string> = { anime: "Anime", movie: "Movies", series: "Series", asian: "Asian drama" };

/**
 * Per-content-kind provider editor. Reorder providers (pinned ones sort to the top
 * of the sources list + autoplay) and hide the ones you never want for this kind.
 * Saved into settings (so it persists locally AND syncs across your devices).
 */
export default function ProviderPrefsEditor({ kind, onClose }: { kind: string; onClose: () => void }) {
  const s = useSettings();
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);

  useEffect(() => { api.providers().then(setProviders).catch(() => setProviders([])); }, []);

  const pref = s.providerPrefs[kind] || { order: [], hidden: [] };

  // Effective display order: explicitly-ordered providers first (in saved order),
  // then any remaining providers in their natural registration order.
  const ordered = useMemo(() => {
    if (!providers) return [];
    const byId = new Map(providers.map((p) => [p.id, p]));
    const seen = new Set<string>();
    const out: ProviderInfo[] = [];
    for (const id of pref.order) { const p = byId.get(id); if (p && !seen.has(id)) { out.push(p); seen.add(id); } }
    for (const p of providers) if (!seen.has(p.id)) out.push(p);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, pref.order.join(",")]);

  const savePref = (order: string[], hidden: string[]) =>
    updateSettings({ providerPrefs: { ...s.providerPrefs, [kind]: { order, hidden } } });

  const move = (idx: number, dir: -1 | 1) => {
    const ids = ordered.map((p) => p.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    savePref(ids, pref.hidden);
  };
  // Drag-and-drop reorder (arrows remain as a fallback / for keyboard).
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const drop = () => {
    if (dragIdx !== null && overIdx !== null && dragIdx !== overIdx) {
      const ids = ordered.map((p) => p.id);
      const [moved] = ids.splice(dragIdx, 1);
      ids.splice(overIdx, 0, moved);
      savePref(ids, pref.hidden);
    }
    setDragIdx(null); setOverIdx(null);
  };
  const toggleHidden = (id: string) => {
    const hidden = pref.hidden.includes(id) ? pref.hidden.filter((x) => x !== id) : [...pref.hidden, id];
    // materialize the current order too so hiding doesn't lose an unsaved order
    savePref(ordered.map((p) => p.id), hidden);
  };
  const reset = () => updateSettings({ providerPrefs: { ...s.providerPrefs, [kind]: { order: [], hidden: [] } } });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Providers · {KIND_LABEL[kind] || kind}</h3>
          <button className="btn btn-icon btn-ghost btn-sm" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <div className="modal-body">
          <div className="hint" style={{ marginBottom: "var(--space-3)" }}>
            Drag rows to reorder (or use the arrows) — providers higher up are tried and auto-played first for {KIND_LABEL[kind]?.toLowerCase() || kind}. Turn one off to hide it entirely for this kind. Saved to your account and synced across devices.
          </div>
          {!providers ? (
            <div className="empty">Loading providers…</div>
          ) : (
            <div className="prov-editor">
              {ordered.map((p, i) => {
                const hidden = pref.hidden.includes(p.id);
                return (
                  <div
                    className={`prov-row ${hidden ? "off" : ""} ${dragIdx === i ? "dragging" : ""} ${overIdx === i && dragIdx !== null && dragIdx !== i ? "drag-over" : ""}`}
                    key={p.id}
                    draggable
                    onDragStart={() => setDragIdx(i)}
                    onDragOver={(e) => { e.preventDefault(); if (overIdx !== i) setOverIdx(i); }}
                    onDrop={drop}
                    onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                  >
                    <span className="prov-idx" title="Drag to reorder">{i + 1}</span>
                    <span className="prov-name">{p.name}<span className="prov-kind subtle"> · {p.kind}</span></span>
                    <div className="prov-move">
                      <button className="btn btn-icon btn-ghost btn-sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ChevronUp size={15} /></button>
                      <button className="btn btn-icon btn-ghost btn-sm" disabled={i === ordered.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ChevronDown size={15} /></button>
                    </div>
                    <button role="switch" aria-checked={!hidden} aria-label={hidden ? "Show provider" : "Hide provider"} className={!hidden ? "switch on" : "switch"} onClick={() => toggleHidden(p.id)} />
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn btn-sm" style={{ marginRight: "auto" }} onClick={reset}>Reset</button>
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
