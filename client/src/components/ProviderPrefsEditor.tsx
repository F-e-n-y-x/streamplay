import { useEffect, useMemo, useRef, useState } from "react";
import type { ProviderInfo } from "../lib/types";
import { useProviders } from "../lib/queries";
import { useSettings, updateSettings } from "../lib/settings";
import { ChevronDown, ChevronUp, X } from "./icons";
import { Button, IconButton, Skeleton, StateMessage, Switch } from "./ui";

const KIND_LABEL: Record<string, string> = { anime: "Anime", movie: "Movies", series: "Series", asian: "Asian drama" };

/**
 * Per-content-kind provider editor (Settings › Server and the player's sources view). Reorder providers (pinned ones sort to the top
 * of the sources list + autoplay) and hide the ones you never want for this kind.
 * Saved into settings (so it persists locally AND syncs across your devices).
 */
export default function ProviderPrefsEditor({ kind, onClose }: { kind: string; onClose: () => void }) {
  const s = useSettings();
  const { data: providers, isError } = useProviders();
  // Native modal <dialog>: focus trap, Escape (fires `cancel` → onClose) and top layer for free.
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = dlg.current; d?.showModal(); return () => d?.close(); }, []);

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

  const label = KIND_LABEL[kind] || kind;
  return (
    <dialog ref={dlg} className="dialog ppe" aria-labelledby="ppe-h" onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ppe-inner">
        <div className="ppe-head">
          <h2 id="ppe-h" className="dialog-title">Provider order: {label}</h2>
          <IconButton label="Close" onClick={onClose}><X size={20} /></IconButton>
        </div>
        <p className="dialog-body">Providers higher up are tried first for {label.toLowerCase()}. Drag a row or use the arrows to move it; switch one off to never use it. Synced to your devices.</p>
        {!providers ? (
          isError ? <StateMessage kind="error" title="Couldn't load the providers." body="Close this and try again in a moment." />
            : <div className="ppe-list" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={48} />)}</div>
        ) : (
          <ol className="ppe-list">
            {ordered.map((p, i) => {
              const hidden = pref.hidden.includes(p.id);
              return (
                <li
                  className="ppe-row" key={p.id} data-off={hidden ? "" : undefined}
                  data-drag={dragIdx === i ? "" : undefined} data-over={overIdx === i && dragIdx !== null && dragIdx !== i ? "" : undefined}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => { e.preventDefault(); if (overIdx !== i) setOverIdx(i); }}
                  onDrop={drop}
                  onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}
                >
                  <span className="ppe-idx" aria-hidden="true">{i + 1}</span>
                  <span className="ppe-name">{p.name}</span>
                  <IconButton size="sm" label={`Move ${p.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><ChevronUp size={16} /></IconButton>
                  <IconButton size="sm" label={`Move ${p.name} down`} disabled={i === ordered.length - 1} onClick={() => move(i, 1)}><ChevronDown size={16} /></IconButton>
                  <Switch checked={!hidden} label={`Use ${p.name}`} onChange={() => toggleHidden(p.id)} />
                </li>
              );
            })}
          </ol>
        )}
        <div className="dialog-actions">
          <Button variant="ghost" onClick={reset} className="ppe-reset">Reset to default</Button>
          <Button variant="solid" onClick={onClose}>Done</Button>
        </div>
      </div>
    </dialog>
  );
}
