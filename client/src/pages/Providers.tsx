import { useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ProviderHealth, ProviderInfo } from "../lib/types";
import { Activity } from "../components/icons";

type SortKey = "name" | "kind" | "host" | "status" | "latency" | "rate" | "priority";
const DESC_DEFAULT: SortKey[] = ["rate", "priority"]; // higher-is-better → first click sorts desc

export default function Providers() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [health, setHealth] = useState<Record<string, ProviderHealth>>({});
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  // default: status → latency → name
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [dir, setDir] = useState<"asc" | "desc">("asc");

  useEffect(() => {
    api.providers().then(setProviders).catch(() => {}).finally(() => setLoading(false));
    runHealth();
  }, []);

  function runHealth() {
    setChecking(true);
    api.providersHealth()
      .then((list) => setHealth(Object.fromEntries(list.map((h) => [h.id, h]))))
      .catch(() => {})
      .finally(() => setChecking(false));
  }

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
        <button className="btn btn-sm" onClick={runHealth} disabled={checking}>{checking ? "Pinging…" : "Re-check health"}</button>
      </div>

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
