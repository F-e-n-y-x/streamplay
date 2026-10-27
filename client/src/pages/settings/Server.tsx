import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useDiag, useHealth } from "../../lib/queries";
import { useSettings, updateSettings, type ClientSettings } from "../../lib/settings";
import ConfirmDialog from "../../components/ConfirmDialog";
import ProviderPrefsEditor from "../../components/ProviderPrefsEditor";
import { Button, ListGroup, ListRow, SegmentedControl, toast } from "../../components/ui";
import { AdminGate, Field, Group, adminMessage, useAdmin } from "./shared";

const KINDS = [
  { id: "movie", label: "Movies" }, { id: "series", label: "Series" }, { id: "anime", label: "Anime" }, { id: "asian", label: "Asian drama" },
];
// "off" is the stored default and is never sent, so the server's WARP_MODE applies: show it as "Server default".
const WARP: { value: ClientSettings["warp"]; label: string; desc: string }[] = [
  { value: "required", label: "Only where needed", desc: "Providers that block the server's address go through WARP." },
  { value: "fallback", label: "As a fallback", desc: "Retry a provider through WARP when it fails." },
  { value: "all", label: "Always", desc: "Send every provider through WARP. Slower." },
];
/** One label per WARP mode, shared with Provider health. */
export const warpLabel = (m: string) => WARP.find((w) => w.value === m)?.label ?? "Off";
const INDEXERS = [{ value: "jackett", label: "Jackett" }, { value: "prowlarr", label: "Prowlarr" }, { value: "torznab", label: "Torznab" }];

/** Settings › Server: device torrent mode, provider order, WARP, the torrent indexer, provider health. */
export default function ServerSection() {
  const s = useSettings();
  const warpReady = useHealth().data?.warp;
  const [editing, setEditing] = useState<string | null>(null);
  const prefSummary = (kind: string) => {
    const p = s.providerPrefs[kind];
    if (!p || (!p.order.length && !p.hidden.length)) return "Default";
    return p.hidden.length ? `${p.hidden.length} hidden` : "Custom order";
  };

  return (
    <>
      <AdminGate why="Changing the indexer and addons affects everyone using this server." />

      <Group title="This device">
        <ListGroup>
          <ListRow kind="toggle" checked={s.torrentMode} onClick={() => updateSettings({ torrentMode: !s.torrentMode })}
            title="Torrent mode" description="Play from torrents instead of streaming sites. Slower to start and needs seeders. Only affects this device." />
        </ListGroup>
      </Group>

      <Group title="Provider order" desc="Choose which providers are tried first, or hide ones you never want. Saved to your account.">
        <ListGroup divided>
          {KINDS.map((k) => <ListRow key={k.id} kind="nav" title={k.label} value={prefSummary(k.id)} onClick={() => setEditing(k.id)} />)}
        </ListGroup>
      </Group>
      {editing && <ProviderPrefsEditor kind={editing} onClose={() => setEditing(null)} />}

      {(warpReady || s.warp !== "off") && (
        <Group title="WARP proxy" desc={warpReady ? "Cloudflare WARP gives providers a different address when a site blocks the server." : "WARP isn't set up on this server, so this has no effect."}>
          <ListGroup role="radiogroup" label="WARP proxy" divided>
            <ListRow kind="choice" checked={s.warp === "off"} title="Server default" description={<WarpDefault />} onClick={() => updateSettings({ warp: "off" })} />
            {WARP.map((w) => <ListRow key={w.value} kind="choice" checked={s.warp === w.value} title={w.label} description={w.desc} onClick={() => updateSettings({ warp: w.value })} />)}
          </ListGroup>
        </Group>
      )}

      <Indexer />

      <Group title="Diagnostics">
        <ListGroup>
          <ListRow kind="nav" to="/settings/providers" title="Provider health" description="Which providers are reachable right now, plus FlareSolverr and WARP checks." />
        </ListGroup>
      </Group>
    </>
  );
}

/** The server's WARP_MODE (from the connection test, which runs once per visit). */
function WarpDefault() {
  const { data } = useDiag();
  return <>{data ? `${warpLabel(data.warpMode)}, set by the server.` : "Whatever the server is set to."}</>;
}

/** Torrent indexer (Jackett / Prowlarr / Torznab). Server-wide; open unless ADMIN_TOKEN is set. */
function Indexer() {
  const { token, cfg, lock, unlocked } = useAdmin();
  const qc = useQueryClient();
  const info = cfg.data?.torznab ?? null;
  const [kind, setKind] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "test" | "clear">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const k = kind ?? info?.kind ?? "jackett";
  const u = url ?? info?.url ?? "";
  const locked = !!lock && !unlocked;

  const save = async (body: { kind: string; url: string; apiKey: string }, what: "save" | "clear") => {
    setBusy(what); setMsg(null);
    try {
      const r = await api.saveTorznab(body, token || undefined);
      if (!r?.ok) throw new Error(r?.error || "The server didn't save it.");
      setApiKey(""); setKind(null); setUrl(null);
      await qc.invalidateQueries({ queryKey: ["config"] });
      toast(what === "clear" ? "Indexer removed" : "Indexer saved", { tone: "success" });
    } catch (e) { setMsg({ ok: false, text: adminMessage(e) }); }
    setBusy("");
  };
  const test = async () => {
    setBusy("test"); setMsg(null);
    try {
      const r = await api.testTorznab();
      setMsg(r.ok ? { ok: true, text: `Working. A test search returned ${r.count} results.` } : { ok: false, text: `Couldn't search the indexer: ${r.error || "no answer"}.` });
    } catch (e) { setMsg({ ok: false, text: adminMessage(e) }); }
    setBusy("");
  };

  return (
    <Group title="Torrent indexer" desc="Connect Jackett or Prowlarr so torrent providers search every indexer you've set up there. Applies to everyone on this server.">
      {info && <p className="set-note">Using {INDEXERS.find((x) => x.value === info.kind)?.label ?? info.kind} at <span className="mono">{info.url}</span>{info.hasKey ? "" : ", without an API key"}.</p>}
      <form className="set-form" onSubmit={(e) => { e.preventDefault(); save({ kind: k, url: u.trim(), apiKey }, "save"); }}>
        <fieldset disabled={locked}>
          <Field label="Type">
            <SegmentedControl label="Indexer type" value={k} options={INDEXERS} onChange={setKind} />
          </Field>
          <label className="set-label" htmlFor="tz-url">Address</label>
          <input id="tz-url" className="input" type="url" inputMode="url" autoCapitalize="off" spellCheck={false} value={u} onChange={(e) => setUrl(e.target.value)}
            placeholder={k === "jackett" ? "http://jackett:9117" : k === "prowlarr" ? "http://prowlarr:9696" : "http://host/api/v2.0/indexers/all/results/torznab"} aria-describedby="tz-url-desc" />
          <p className="set-desc" id="tz-url-desc">{k === "jackett" ? "The Jackett base address. StreamPlay adds the all-indexers path itself." : k === "prowlarr" ? "The Prowlarr base address." : "The full Torznab feed address."}</p>
          <label className="set-label" htmlFor="tz-key">API key</label>
          <input id="tz-key" className="input" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
            placeholder={info?.hasKey ? "Saved. Leave empty to keep it." : ""} />
          <div className="set-actions">
            <Button type="submit" variant="solid" loading={busy === "save"} disabled={!u.trim()}>Save indexer</Button>
            <Button onClick={test} loading={busy === "test"} disabled={!info}>Test</Button>
            {info && <Button variant="danger" loading={busy === "clear"} onClick={() => setConfirm(true)}>Remove</Button>}
          </div>
        </fieldset>
      </form>
      {locked && <p className="set-desc">Unlock with the admin token above to change the indexer.</p>}
      {confirm && <ConfirmDialog title="Remove the torrent indexer?" body="Torrent providers go back to their built-in sources for everyone on this server."
        confirm="Remove indexer" cancel="Keep indexer" onClose={() => setConfirm(false)} onConfirm={() => save({ kind: "jackett", url: "", apiKey: "" }, "clear")} />}
      {msg && <p className={msg.ok ? "set-ok" : "set-error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
    </Group>
  );
}
