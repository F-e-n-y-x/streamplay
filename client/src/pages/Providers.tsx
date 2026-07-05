import { useEffect, useMemo, useRef, useState } from "react";
import { api, type DiagInfo } from "../lib/api";
import type { ProviderHealth, ProviderInfo } from "../lib/types";
import { useProviders, useProvidersHealth } from "../lib/queries";
import { useSettings, updateSettings } from "../lib/settings";
import { Activity, Zap } from "../components/icons";

/** FlareSolverr + WARP connectivity panel — up/ping/version + the egress IP each
 *  uses, so you can confirm traffic really leaves through WARP (IP differs from the
 *  server's direct IP) and every solver is reachable. */
export function ConnectionsPanel() {
  const [diag, setDiag] = useState<DiagInfo | null>(null);
  const [testing, setTesting] = useState(false);
  const mounted = useRef(true);
  // Set true on (re)mount, not just once at init — otherwise React 18 StrictMode's
  // mount→cleanup→remount leaves it permanently false and every guarded setState is
  // skipped, freezing the panel on "Probing…" in dev.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = () => { setTesting(true); api.diag().then((d) => mounted.current && setDiag(d)).catch(() => mounted.current && setDiag(null)).finally(() => mounted.current && setTesting(false)); };
  useEffect(run, []);

  const Node = ({ n, kind }: { n: DiagInfo["flaresolverr"][number]; kind: string }) => {
    const proxied = !!(diag?.directIp && n.ip && n.ip !== diag.directIp);
    return (
      <div className="conn-row">
        <span className={`dot ${n.up ? "found" : "failed"}`} />
        <span className="mono conn-host">{n.host}</span>
        <span className="subtle">{kind}</span>
        <span className="grow" style={{ flex: 1 }} />
        {n.up ? <span className="mono subtle">{n.latencyMs}ms</span> : <span className="badge badge-error">{n.error || "down"}</span>}
        {n.version && <span className="badge">v{n.version}</span>}
        {n.ip && <span className={`badge ${proxied ? "badge-success" : "badge-warning"}`} title={proxied ? "egress via WARP (differs from server IP)" : "egress IP matches the server — NOT going through WARP"}>{n.ip}{proxied ? " ✓WARP" : " ⚠direct"}</span>}
      </div>
    );
  };

  return (
    <div className="conn-panel">
      <div className="toolbar" style={{ marginBottom: "var(--space-3)" }}>
        <h2 style={{ margin: 0, fontSize: "var(--text-lg)" }}>Connections</h2>
        <span className="grow" style={{ flex: 1 }} />
        {diag && <span className="badge">WARP: {diag.warpMode}</span>}
        {diag?.directIp && <span className="badge" title="Server's direct egress IP (no proxy)">server IP {diag.directIp}</span>}
        <button className="btn btn-sm" onClick={run} disabled={testing}>{testing ? "Testing…" : "Test connections"}</button>
      </div>
      {!diag ? (
        <div className="note">{testing ? "Probing FlareSolverr + WARP…" : "Click “Test connections”."}</div>
      ) : (!diag.flaresolverr.length && !diag.warpSocks.length) ? (
        <div className="note">No FlareSolverr or WARP configured (set <code>FLARESOLVERR_URL</code> / <code>WARP_*</code>).</div>
      ) : (
        <div className="conn-list">
          {diag.flaresolverr.map((n) => <Node key={"fs" + n.host} n={n} kind="FlareSolverr" />)}
          {diag.warpSocks.map((n) => <Node key={"warp" + n.host} n={n} kind="WARP socks" />)}
          <div className="note" style={{ marginTop: "var(--space-2)" }}>
            A green <b>✓WARP</b> IP (different from the server IP) means that solver/proxy is really egressing through Cloudflare WARP. A yellow <b>⚠direct</b> means it's using the server's own IP — WARP isn't taking effect for it.
          </div>
        </div>
      )}
    </div>
  );
}

type SortKey = "name" | "kind" | "host" | "status" | "latency" | "rate" | "priority";
const DESC_DEFAULT: SortKey[] = ["rate", "priority"]; // higher-is-better → first click sorts desc

export default function Providers() {
  const { torrentMode } = useSettings();
  // TanStack Query handles fetch/cache/cancellation (no more hand-rolled `mounted` refs).
  const providersQ = useProviders();
  const healthQ = useProvidersHealth();
  const providers = providersQ.data ?? [];
  const loading = providersQ.isPending;
  const checking = healthQ.isFetching;
  const health = useMemo<Record<string, ProviderHealth>>(
    () => Object.fromEntries((healthQ.data ?? []).map((h) => [h.id, h])),
    [healthQ.data],
  );
  const runHealth = () => healthQ.refetch();
  // default: status → latency → name
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [dir, setDir] = useState<"asc" | "desc">("asc");

  function sortBy(key: SortKey) {
    if (key === sortKey) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setDir(DESC_DEFAULT.includes(key) ? "desc" : "asc"); }
  }

  const statusRank = (p: ProviderInfo) => { const h = health[p.id]; return !h ? 2 : h.status === "up" ? 0 : 1; };
  const latency = (p: ProviderInfo) => { const h = health[p.id]; return h && h.status === "up" ? h.latencyMs : Infinity; };

  const sorted = [...providers].sort((a, b) => {
    let r = 0;
    switch (sortKey) {
      case "name": r = a.name.localeCompare(b.name); break;
      case "kind": r = a.kind.localeCompare(b.kind); break;
      case "host": r = a.host.localeCompare(b.host); break;
      case "status": r = statusRank(a) - statusRank(b) || latency(a) - latency(b); break;
      case "latency": r = latency(a) - latency(b); break;
      case "rate": r = (a.stats.successRate || 0) - (b.stats.successRate || 0); break;
      case "priority": r = a.priorityScore - b.priorityScore; break;
    }
    if (r === 0) r = a.name.localeCompare(b.name); // stable tiebreak by name
    return dir === "asc" ? r : -r;
  });

  const upCount = Object.values(health).filter((h) => h.status === "up").length;

  const Th = ({ k, children, style }: { k: SortKey; children: React.ReactNode; style?: React.CSSProperties }) => (
    <th className={`sortable ${sortKey === k ? "sorted" : ""}`} onClick={() => sortBy(k)} style={style}>
      {children}<span className="sort-ind">{sortKey === k ? (dir === "asc" ? "↑" : "↓") : ""}</span>
    </th>
  );

  return (
    <div className="container">
      <div className="toolbar">
        <h1 className="page-title" style={{ margin: 0 }}>Providers</h1>
        <span className="grow" style={{ flex: 1 }} />
        <span className="badge"><Activity size={13} /> {providers.length} registered</span>
        {Object.keys(health).length > 0 && <span className="badge badge-success">{upCount} reachable</span>}
        <button
          className={`btn btn-sm ${torrentMode ? "btn-primary" : ""}`}
          onClick={() => updateSettings({ torrentMode: !torrentMode })}
          title="Resolve via torrents (anime: AnimeTosho/Nyaa · movies: YTS/TPB · TV: EZTV/TPB) streamed through WebTorrent, instead of the scraper providers. This device only."
        ><Zap size={14} /> Torrent mode: {torrentMode ? "ON" : "OFF"}</button>
        <button className="btn btn-sm" onClick={runHealth} disabled={checking}>{checking ? "Pinging…" : "Re-check health"}</button>
      </div>

      {torrentMode && (
        <div className="note" style={{ borderColor: "var(--accent)" }}>
          <b>Torrent mode is ON</b> (this device only). Everything resolves via torrents streamed through WebTorrent —
          anime from AnimeTosho/Nyaa, movies from YTS/The Pirate Bay, TV from EZTV/The Pirate Bay. The scraper
          providers below are <b>hidden</b> while this is on. Needs peers, so playback starts after a short buffer.
          Turn it off to use the normal providers.
        </div>
      )}

      <ConnectionsPanel />

      <div className="note">
        Health is determined by <b>pinging each provider's host</b> for reachability and latency. Click any column
        header to sort — the table defaults to <b>status → latency → name</b>.
      </div>

      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <Th k="name">Provider</Th>
              <Th k="kind">Kind</Th>
              <Th k="host">Host</Th>
              <Th k="status">Status</Th>
              <Th k="latency">Latency</Th>
              <Th k="rate">Success rate</Th>
              <Th k="priority">Priority</Th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="subtle" style={{ padding: "var(--space-6)" }}>Loading…</td></tr>
            ) : sorted.map((p) => {
              const h = health[p.id];
              const rate = Math.round((p.stats.successRate || 0) * 100);
              return (
                <tr key={p.id}>
                  <td>{p.name}{p.needsToken ? <span className="badge" style={{ marginLeft: 8 }}>token</span> : null}</td>
                  <td><span className="badge">{p.kind}</span></td>
                  <td className="mono">{p.host.replace(/^https?:\/\//, "")}</td>
                  <td>
                    {!h ? <span className="subtle">—</span> : (
                      <span className="statusdot"><span className={`dot ${h.status === "up" ? "found" : "failed"}`} />{h.status}</span>
                    )}
                  </td>
                  <td className="mono">{h && h.status === "up" ? `${h.latencyMs}ms` : "—"}</td>
                  <td>
                    <span className="bar-meter"><span style={{ width: `${rate}%` }} /></span>
                    <span className="subtle" style={{ marginLeft: 8 }}>{p.stats.successCount + p.stats.failureCount > 0 ? `${rate}%` : "n/a"}</span>
                  </td>
                  <td className="mono">{p.stats.isCircuitBroken ? <span className="badge badge-error">broken</span> : Math.round(p.priorityScore)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
