import { useMemo, useState } from "react";
import type { DiagInfo } from "../lib/api";
import { useDocTitle } from "../lib/useDocTitle";
import type { ProviderHealth, ProviderInfo } from "../lib/types";
import { useDiag, useProviders, useProvidersHealth } from "../lib/queries";
import { useSettings } from "../lib/settings";
import { warpLabel } from "./settings/Server";
import { Button, StateMessage, StatusDot } from "../components/ui";
import { ChevronLeft } from "../components/icons";
import "../styles/settings.css";

type DiagNode = DiagInfo["flaresolverr"][number];

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** FlareSolverr + WARP: reachable, latency, version, and the egress IP each one uses
 *  (a different IP from the server's means traffic really leaves through WARP). */
function Connections() {
  const { data: diag, isFetching, isError, refetch } = useDiag();
  const { warp } = useSettings();
  const nodes: (DiagNode & { kind: string })[] = diag ? [
    ...diag.flaresolverr.map((n) => ({ ...n, kind: "FlareSolverr" })),
    ...diag.warpSocks.map((n) => ({ ...n, kind: "WARP proxy" })),
  ] : [];
  return (
    <section className="ph-section" aria-labelledby="conn-h">
      <div className="ph-head">
        <h2 id="conn-h" className="t-h2">Connections</h2>
        <Button size="sm" variant="ghost" loading={isFetching} onClick={() => refetch()}>Check again</Button>
      </div>
      {!diag ? (
        isError ? <StateMessage kind="error" title="Couldn't run the connection test." body="Check that the server is running, then check again." />
          : <p className="set-desc" role="status">Testing FlareSolverr and WARP…</p>
      ) : !nodes.length ? (
        <p className="set-desc">No FlareSolverr or WARP is set up on this server (FLARESOLVERR_URL, WARP_*).</p>
      ) : (
        <>
          <p className="set-desc">WARP: {warp === "off" ? `${warpLabel(diag.warpMode)} (server default)` : `${warpLabel(warp)} on this device · server default ${warpLabel(diag.warpMode)}`}{diag.directIp && <> · server address <span className="mono">{diag.directIp}</span></>}</p>
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>Host</th><th>Type</th><th>Status</th><th>Latency</th><th>Version</th><th>Leaves through</th></tr></thead>
              <tbody>
                {nodes.map((n) => {
                  const viaWarp = !!(diag.directIp && n.ip && n.ip !== diag.directIp);
                  return (
                    <tr key={n.kind + n.host}>
                      <td className="mono">{n.host}</td>
                      <td>{n.kind}</td>
                      <td><span className="dot-text" title={n.error}><StatusDot tone={n.up ? "success" : "error"} />{n.up ? "Up" : n.error === "ECONNREFUSED" ? "Down (refused)" : "Down"}</span></td>
                      <td className="mono">{n.up ? `${n.latencyMs} ms` : "–"}</td>
                      <td className="mono">{n.version ?? "–"}</td>
                      <td>{n.ip ? <span className="dot-text"><StatusDot tone={viaWarp ? "success" : "warning"} /><span className="mono">{n.ip}</span>&nbsp;{viaWarp ? "WARP" : "direct"}</span> : "–"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <details className="flag-help">
            <summary>What do these mean?</summary>
            <p className="set-desc">“Leaves through WARP” means the address differs from the server's own, so that solver or proxy really goes out through Cloudflare WARP. “Direct” means it uses the server's address and WARP isn't taking effect for it.</p>
          </details>
        </>
      )}
    </section>
  );
}

type SortKey = "name" | "kind" | "host" | "status" | "latency" | "rate" | "priority";
const DESC_FIRST: SortKey[] = ["rate", "priority"];   // higher is better → first click sorts descending

function Th({ k, sort, onSort, children }: { k: SortKey; sort: { key: SortKey; dir: "asc" | "desc" }; onSort: (k: SortKey) => void; children: React.ReactNode }) {
  const on = sort.key === k;
  return (
    <th aria-sort={on ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button type="button" className="th-sort" onClick={() => onSort(k)}>{children}<span aria-hidden="true">{on ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}</span></button>
    </th>
  );
}

/** Settings › Server › Provider health (/settings/providers). For the server owner. */
export default function Providers() {
  useDocTitle("Provider health");
  const providersQ = useProviders();
  const healthQ = useProvidersHealth();
  const providers = providersQ.data ?? [];
  const health = useMemo<Record<string, ProviderHealth>>(() => Object.fromEntries((healthQ.data ?? []).map((h) => [h.id, h])), [healthQ.data]);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "status", dir: "asc" });
  const onSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: DESC_FIRST.includes(key) ? "desc" : "asc" }));

  const statusRank = (p: ProviderInfo) => { const h = health[p.id]; return !h ? 2 : h.status === "up" ? 0 : 1; };
  const latency = (p: ProviderInfo) => { const h = health[p.id]; return h?.status === "up" ? h.latencyMs : Infinity; };
  const sorted = [...providers].sort((a, b) => {
    let r = 0;
    switch (sort.key) {
      case "name": r = a.name.localeCompare(b.name); break;
      case "kind": r = a.kind.localeCompare(b.kind); break;
      case "host": r = a.host.localeCompare(b.host); break;
      case "status": r = statusRank(a) - statusRank(b) || latency(a) - latency(b); break;
      case "latency": r = latency(a) - latency(b); break;
      case "rate": r = (a.stats.successRate || 0) - (b.stats.successRate || 0); break;
      case "priority": r = a.priorityScore - b.priorityScore; break;
    }
    return (sort.dir === "asc" ? r : -r) || a.name.localeCompare(b.name);
  });
  const up = Object.values(health).filter((h) => h.status === "up").length;
  const p = { sort, onSort };

  return (
    <div className="container provider-health">
      <div className="settings-head">
        <Button className="ph-back" variant="ghost" size="sm" to="/settings/server" icon={<ChevronLeft size={20} />}>Server settings</Button>
        <h1 className="t-h1">Provider health</h1>
      </div>
      <p className="ph-summary" role="status">
        {healthQ.data ? <>{up} of {providers.length} providers reachable · checked {ago(healthQ.dataUpdatedAt)}</>
          : healthQ.isError ? "Couldn't check the providers." : "Checking every provider…"}
        <Button size="sm" variant="ghost" loading={healthQ.isFetching} onClick={() => healthQ.refetch()}>Check again</Button>
      </p>

      <Connections />

      <section className="ph-section" aria-labelledby="prov-h">
        <h2 id="prov-h" className="t-h2">Providers</h2>
        <p className="set-desc">Reachable means the provider's site answered a ping. It doesn't promise every title plays.</p>
        {providersQ.isError ? (
          <StateMessage kind="error" title="Couldn't load the provider list." body="Check that the server is running, then try again." actions={<Button variant="solid" onClick={() => providersQ.refetch()}>Try again</Button>} />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <Th k="name" {...p}>Provider</Th><Th k="kind" {...p}>Kind</Th><Th k="host" {...p}>Host</Th><Th k="status" {...p}>Status</Th>
                  <Th k="latency" {...p}>Latency</Th><Th k="rate" {...p}>Success</Th><Th k="priority" {...p}>Priority</Th>
                </tr>
              </thead>
              <tbody aria-busy={providersQ.isPending || undefined}>
                {providersQ.isPending ? Array.from({ length: 8 }, (_, i) => <tr key={i}><td colSpan={7}><div className="skeleton skeleton-text" /></td></tr>)
                  : sorted.map((pr) => {
                    const h = health[pr.id];
                    const tries = pr.stats.successCount + pr.stats.failureCount;
                    return (
                      <tr key={pr.id}>
                        <td>{pr.name}{pr.needsToken && <span className="subtle"> (needs token)</span>}</td>
                        <td>{pr.kind}</td>
                        <td className="mono">{pr.host.replace(/^https?:\/\//, "")}</td>
                        <td>{h ? <span className="dot-text"><StatusDot tone={h.status === "up" ? "success" : "error"} />{h.status === "up" ? "Up" : "Down"}</span> : <span className="subtle">–</span>}</td>
                        <td className="mono">{h?.status === "up" ? `${h.latencyMs} ms` : "–"}</td>
                        <td className="mono">{tries ? `${Math.round(pr.stats.successRate * 100)}%` : "–"}</td>
                        <td className="mono">{pr.stats.isCircuitBroken ? <span className="dot-text"><StatusDot tone="error" />Paused</span> : Math.round(pr.priorityScore)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
