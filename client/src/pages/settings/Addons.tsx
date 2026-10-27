import { useEffect, useId, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAddonCatalog, useScrapers } from "../../lib/queries";
import type { AddonKind, AddonPreview, CatalogEntry, ScraperRepo } from "../../lib/types";
import ConfirmDialog from "../../components/ConfirmDialog";
import { Button, FilterChip, IconButton, ListGroup, ListRow, Panel, Skeleton, SkeletonText, StateMessage, StatusDot, toast } from "../../components/ui";
import { AlertCircle, Check, ChevronDown, Shield, Trash2 } from "../../components/icons";
import { AdminGate, Group, adminMessage, useAdmin } from "./shared";

const MAX_PER_KIND = 20;
const TRUST = "Nuvio scrapers are code that runs on your server. They run in a separate worker, but that isn't a security sandbox, so add only repos you trust as much as the server itself.";
const FLAG_HELP = {
  obfuscated: "The code is deliberately scrambled, so nobody can easily check what it does. It still runs on your server.",
  debrid: "Returns nothing without a paid debrid account (Real-Debrid, AllDebrid and similar).",
  setup: "Set it up on the addon's own site first, then paste the personal link it gives you.",
  stale: "No updates for over 6 months. Sites it scrapes may have changed.",
};

const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };
const isLan = (u: string) => {
  try {
    const h = new URL(u).hostname;
    return !h.includes(".") || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /\.(local|lan|home|internal)$/.test(h);
  } catch { return false; }
};
const TAG_LABEL: Record<string, string> = { tv: "Series", http: "Direct links", "multi-language": "Many languages" };
const tagLabel = (t: string) => TAG_LABEL[t] ?? t.charAt(0).toUpperCase() + t.slice(1);
const MONTH = 30 * 86400_000;
const isStale = (iso?: string) => !!iso && Date.now() - Date.parse(iso) > 6 * MONTH;
function ago(iso: string): string {
  const days = Math.round((Date.now() - Date.parse(iso)) / 86400_000);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (days < 1) return "today";
  if (days < 45) return rtf.format(-days, "day");
  if (days < 365) return rtf.format(-Math.round(days / 30), "month");
  return rtf.format(-Math.round(days / 365), "year");
}
const TYPES = (t: string[]) => {
  const n = t.map((x) => (x === "movie" ? "movies" : x === "tv" || x === "series" ? "series" : x === "anime" ? "anime" : x));
  const s = [...new Set(n)].join(" and ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** What the preview Panel is showing. `entry` = opened from the catalog. */
type Preview = { url: string; entry?: CatalogEntry; setup?: boolean };

/** Settings › Addons: installed addons (with per-scraper toggles), the catalog, add by URL. */
export default function AddonsSection() {
  const { unlocked, lock } = useAdmin();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [url, setUrl] = useState("");
  const [urlErr, setUrlErr] = useState("");

  const check = (e: React.FormEvent) => {
    e.preventDefault();
    const u = url.trim();
    try { if (!/^https?:$/.test(new URL(u).protocol)) throw 0; } catch { return setUrlErr("Enter a full URL starting with https:// or http://."); }
    setUrlErr("");
    setPreview({ url: u });
  };

  return (
    <>
      <p className="set-intro">Addons are extra places to find streams. They run on your StreamPlay server, so every device gets them.</p>
      <p className="set-note" data-tone="warning"><Shield size={20} aria-hidden="true" /><span>{TRUST} Stremio addons only send back links.</span></p>
      <AdminGate why="Adding addons changes the sources for everyone on this server."
        offText="Adding and changing addons is turned off on this server. To turn it on, set ADMIN_TOKEN in the server's environment and restart it." />

      <Installed />

      <Catalog canAdd={unlocked} onAdd={(entry) => setPreview({ url: entry.manifestUrl, entry, setup: entry.needsConfig })} />

      <Group title="Add by URL" desc="Paste the manifest URL of a Nuvio repo or a Stremio addon. You'll see what it contains before anything is added.">
        <form className="inline-form" onSubmit={check} noValidate>
          <input className="input" type="url" inputMode="url" autoCapitalize="off" autoComplete="off" spellCheck={false} aria-label="Manifest URL"
            placeholder="https://…/manifest.json" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!unlocked}
            aria-invalid={urlErr ? true : undefined} aria-describedby={urlErr ? "addon-url-err" : undefined} />
          <Button type="submit" disabled={!unlocked || !url.trim()}>Check</Button>
        </form>
        {urlErr && <p className="set-error" id="addon-url-err" role="alert">{urlErr}</p>}
        {lock && !unlocked && <p className="set-desc">Unlock with the admin token above to add addons.</p>}
      </Group>

      {preview && <PreviewPanel p={preview} onClose={() => setPreview(null)} onAdded={() => { setPreview(null); setUrl(""); }} />}
    </>
  );
}

/** Adds `url` to its list: reads the full current list (admin), appends, saves. */
function useAddAddon() {
  const { token } = useAdmin();
  const qc = useQueryClient();
  return async (kind: AddonKind, url: string, name: string) => {
    const cur = (await api.config(undefined, token))[kind].urls;
    if (cur.includes(url)) return;
    if (cur.length >= MAX_PER_KIND) throw new Error(`You can have up to ${MAX_PER_KIND} ${kind === "nuvio" ? "Nuvio repos" : "Stremio addons"}. Remove one first.`);
    await api.setAddons(kind, [...cur, url], token);
    await Promise.all([qc.invalidateQueries({ queryKey: ["config"] }), qc.invalidateQueries({ queryKey: ["addons"] }), qc.invalidateQueries({ queryKey: ["providers"] })]);
    toast(`Added ${name}`, { tone: "success" });
  };
}

// ── Installed ────────────────────────────────────────────────────────────────────

function Installed() {
  const { token, cfg, unlocked } = useAdmin();
  const repos = useScrapers(token);
  const catalog = useAddonCatalog().data;
  const qc = useQueryClient();
  const [removing, setRemoving] = useState<{ kind: AddonKind; url: string; name: string } | null>(null);
  const c = cfg.data;

  // Stremio names: catalog match by URL (or by origin while URLs are masked), else the host.
  const stremioName = (u: string) => catalog?.find((e) => e.manifestUrl === u || (u.endsWith("/…") && e.manifestUrl.startsWith(u.slice(0, -2))))?.name ?? host(u);

  const remove = async ({ kind, url, name }: { kind: AddonKind; url: string; name: string }) => {
    try {
      const cur = (await api.config(undefined, token))[kind].urls;
      await api.setAddons(kind, cur.filter((u) => u !== url), token);
      await Promise.all([qc.invalidateQueries({ queryKey: ["config"] }), qc.invalidateQueries({ queryKey: ["addons"] }), qc.invalidateQueries({ queryKey: ["providers"] })]);
      toast(`Removed ${name}`);
    } catch (e) { toast(adminMessage(e), { tone: "error" }); }
  };

  if (cfg.isError || repos.isError) {
    return <Group title="Installed"><StateMessage kind="error" title="Couldn't load your addons." body="Check that the server is running, then try again."
      actions={<Button variant="solid" onClick={() => { cfg.refetch(); repos.refetch(); }}>Try again</Button>} /></Group>;
  }
  if (!c || !repos.data) return <Group title="Installed"><div aria-busy="true" className="addon-list"><Skeleton height={64} radius="var(--radius-lg)" /><Skeleton height={64} radius="var(--radius-lg)" /></div></Group>;

  const fromEnv = [c.nuvio.source, c.stremio.source].includes("env");
  const empty = !repos.data.length && !c.stremio.urls.length;
  return (
    <Group title="Installed" desc={fromEnv ? "Some of these come from the server's environment (NUVIO_PLUGINS or STREMIO_ADDONS). Changing the list here replaces that setting." : undefined}>
      {empty ? <p className="set-desc">No addons yet. Add one from the catalog below.</p> : (
        <ul className="addon-list" role="list">
          {/* masked (non-admin) URLs can repeat: key by index */}
          {repos.data.map((r, i) => <RepoRow key={`${i}-${r.manifest}`} repo={r} canEdit={unlocked} onRemove={() => setRemoving({ kind: "nuvio", url: r.manifest, name: r.name ?? host(r.manifest) })} />)}
          {c.stremio.urls.map((u, i) => (
            <li key={`${i}-${u}`} className="addon-item">
              <div className="addon-item-head">
                <div className="addon-item-text">
                  <span className="addon-name">{stremioName(u)}</span>
                  <span className="addon-meta">Stremio addon · <span className="mono" title={unlocked ? u : "Full address hidden. It can contain a private key."}>{unlocked ? host(u) : u}</span></span>
                </div>
                {unlocked && <IconButton label={`Remove ${stremioName(u)}`} onClick={() => setRemoving({ kind: "stremio", url: u, name: stremioName(u) })}><Trash2 size={20} /></IconButton>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {removing && <ConfirmDialog title={`Remove ${removing.name}?`} confirm="Remove addon" cancel="Keep addon"
        body={removing.kind === "nuvio" ? "Its scrapers stop running and their sources disappear for everyone." : "Its sources stop appearing for everyone. A personal link you pasted would need pasting again."}
        onClose={() => setRemoving(null)} onConfirm={() => remove(removing)} />}
    </Group>
  );
}

/** One Nuvio repo: summary line, then an expandable list of per-scraper switches. */
function RepoRow({ repo, canEdit, onRemove }: { repo: ScraperRepo; canEdit: boolean; onRemove: () => void }) {
  const { token } = useAdmin();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const on = repo.scrapers.filter((s) => s.enabled).length;
  const name = repo.name ?? host(repo.manifest);
  const panelId = useId();

  const apply = async (changes: Record<string, boolean | null>, key: string) => {
    setBusy(key);
    try {
      const repos = await api.setScrapers(changes, token);
      qc.setQueryData(["addons", "scrapers", token], repos);
      qc.invalidateQueries({ queryKey: ["providers"] });
    } catch (e) { toast(adminMessage(e), { tone: "error" }); }
    setBusy(null);
  };
  const all = (v: boolean) => apply(Object.fromEntries(repo.scrapers.map((s) => [s.id, v])), v ? "all-on" : "all-off");

  return (
    <li className="addon-item" data-open={open ? "" : undefined}>
      <div className="addon-item-head">
        <button type="button" className="addon-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
          <span className="addon-item-text">
            <span className="addon-name">{name}</span>
            <span className="addon-meta">
              {repo.ok ? `Nuvio repo · ${on} of ${repo.scrapers.length} scrapers on`
                : <span className="addon-err"><AlertCircle size={16} aria-hidden="true" /> Couldn't refresh it: {repo.error || "no answer"}.{repo.scrapers.length ? " Using the last copy." : ""}</span>}
            </span>
          </span>
          <ChevronDown size={20} className="addon-chev" aria-hidden="true" />
        </button>
        {canEdit && <IconButton label={`Remove ${name}`} onClick={onRemove}><Trash2 size={20} /></IconButton>}
      </div>
      {open && (
        <div id={panelId} className="addon-body">
          {canEdit && repo.scrapers.length > 1 && (
            <div className="addon-bulk">
              <Button size="sm" variant="ghost" loading={busy === "all-on"} disabled={on === repo.scrapers.length} onClick={() => all(true)}>Turn all on</Button>
              <Button size="sm" variant="ghost" loading={busy === "all-off"} disabled={on === 0} onClick={() => all(false)}>Turn all off</Button>
            </div>
          )}
          <ListGroup divided label={`${name} scrapers`}>
            {repo.scrapers.map((s) => (
              <ListRow key={s.id} kind="toggle" checked={s.enabled} disabled={!canEdit || !!busy} onClick={() => apply({ [s.id]: !s.enabled }, s.id)}
                title={s.name}
                description={[TYPES(s.supportedTypes), s.contentLanguage?.length ? s.contentLanguage.join(", ").toUpperCase() : "", s.manifestEnabled ? "" : "Off by default"].filter(Boolean).join(" · ")} />
            ))}
          </ListGroup>
          {!canEdit && <p className="set-desc">Unlock with the admin token to turn scrapers on or off.</p>}
        </div>
      )}
    </li>
  );
}

// ── Catalog ──────────────────────────────────────────────────────────────────────

function Flags({ e }: { e: CatalogEntry }) {
  const flags: { text: string; help: string; warn?: boolean }[] = [];
  if (e.obfuscated) flags.push({ text: e.obfuscatedCount && e.scraperCount ? `Obfuscated code (${e.obfuscatedCount} of ${e.scraperCount})` : "Obfuscated code", help: FLAG_HELP.obfuscated, warn: true });
  if (e.needsDebrid) flags.push({ text: "Debrid required", help: FLAG_HELP.debrid });
  if (e.needsConfig) flags.push({ text: "Needs setup", help: FLAG_HELP.setup });
  if (isStale(e.lastUpdated)) flags.push({ text: `Not updated since ${new Date(e.lastUpdated!).toLocaleDateString("en", { month: "short", year: "numeric" })}`, help: FLAG_HELP.stale, warn: true });
  if (!flags.length) return null;
  return (
    <ul className="flags" role="list">
      {flags.map((f) => <li key={f.text} className="flag" data-tone={f.warn ? "warning" : undefined} title={f.help}>{f.warn && <AlertCircle size={16} aria-hidden="true" />}{f.text}<span className="sr-only">. {f.help}</span></li>)}
    </ul>
  );
}

function Catalog({ canAdd, onAdd }: { canAdd: boolean; onAdd: (e: CatalogEntry) => void }) {
  const q = useAddonCatalog();
  const [tag, setTag] = useState<string | null>(null);
  const tags = useMemo(() => {
    const n = new Map<string, number>();
    for (const e of q.data ?? []) for (const t of e.tags) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  }, [q.data]);
  const shown = (q.data ?? []).filter((e) => !tag || e.tags.includes(tag));

  return (
    <Group title="Find addons" desc="Checked by StreamPlay to answer with a valid manifest. Labels warn you about anything that needs a second look.">
      <details className="flag-help">
        <summary>What the labels mean</summary>
        <dl>
          <dt>Obfuscated code</dt><dd>{FLAG_HELP.obfuscated}</dd>
          <dt>Debrid required</dt><dd>{FLAG_HELP.debrid}</dd>
          <dt>Needs setup</dt><dd>{FLAG_HELP.setup}</dd>
          <dt>Not updated since…</dt><dd>{FLAG_HELP.stale}</dd>
        </dl>
      </details>
      {q.isError ? (
        <StateMessage kind="error" title="Couldn't load the catalog." body="Check that the server is running, then try again." actions={<Button variant="solid" onClick={() => q.refetch()}>Try again</Button>} />
      ) : !q.data ? (
        <div className="catalog" aria-busy="true">{Array.from({ length: 4 }, (_, i) => <div key={i} className="cat-card"><SkeletonText lines={3} /></div>)}</div>
      ) : (
        <>
          <div className="chip-row" role="group" aria-label="Filter by tag">
            <FilterChip selected={!tag} onClick={() => setTag(null)}>All</FilterChip>
            {tags.map((t) => <FilterChip key={t} selected={tag === t} onClick={() => setTag(tag === t ? null : t)}>{tagLabel(t)}</FilterChip>)}
          </div>
          {(["nuvio", "stremio"] as const).map((kind) => {
            const list = shown.filter((e) => e.kind === kind);
            if (!list.length) return null;
            return (
              <section key={kind} className="cat-kind" aria-labelledby={`cat-${kind}`}>
                <h4 id={`cat-${kind}`} className="cat-kind-title">{kind === "nuvio" ? "Nuvio repos" : "Stremio addons"}</h4>
                <p className="set-desc">{kind === "nuvio" ? "Bundles of scrapers that run on your server. You can turn single scrapers off after adding." : "Services that send back stream links. Some need an account or a debrid service."}</p>
                <ul className="catalog" role="list">
                  {list.map((e) => (
                    <li key={e.manifestUrl} className="cat-card">
                      <div className="cat-head">
                        <span className="addon-name">{e.name}</span>
                        {e.added ? <span className="cat-added"><Check size={16} aria-hidden="true" /> Added</span>
                          : <Button size="sm" disabled={!canAdd} onClick={() => onAdd(e)} aria-label={`${e.needsConfig ? "Set up" : "Add"} ${e.name}`}>{e.needsConfig ? "Set up" : "Add"}</Button>}
                      </div>
                      <Flags e={e} />
                      <p className="cat-desc">{e.description}</p>
                      <p className="addon-meta">
                        {[e.scraperCount ? `${e.scraperCount} scrapers` : "", e.lastUpdated ? `Updated ${ago(e.lastUpdated)}` : ""].filter(Boolean).join(" · ") || host(e.manifestUrl)}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </>
      )}
    </Group>
  );
}

// ── Preview (inspect → confirm) ──────────────────────────────────────────────────

function PreviewPanel({ p, onClose, onAdded }: { p: Preview; onClose: () => void; onAdded: () => void }) {
  const { token } = useAdmin();
  const add = useAddAddon();
  // needsConfig: the catalog URL is useless; the user pastes their personal one first.
  const [url, setUrl] = useState(p.setup ? "" : p.url);
  const [paste, setPaste] = useState("");
  const [state, setState] = useState<{ loading?: boolean; data?: AddonPreview; error?: string }>({});
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState("");

  const inspect = async (u: string) => {
    setUrl(u); setState({ loading: true }); setAddErr("");
    try { setState({ data: await api.inspectAddon(u, token) }); }
    catch (e) { setState({ error: adminMessage(e) }); }
  };
  // first open: inspect straight away (catalog entries without setup, pasted URLs)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!p.setup) inspect(p.url); }, []);

  const name = state.data?.name || p.entry?.name || host(url);
  const kind: AddonKind | undefined = state.data?.kind ?? p.entry?.kind;
  const doAdd = async (k: AddonKind) => {
    setAdding(true); setAddErr("");
    try { await add(k, url, name); onAdded(); }
    catch (e) { setAddErr(adminMessage(e)); }
    setAdding(false);
  };
  // preview failed: still allow adding a catalog entry (already checked) or a LAN plugin server (not previewable)
  const canForce = !!state.error && !!kind && (!!p.entry || isLan(url));

  const footer = (
    <div className="panel-actions">
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      {state.data ? (
        <Button variant="solid" loading={adding} disabled={state.data.added} onClick={() => doAdd(state.data!.kind)}>
          {state.data.added ? "Already added" : state.data.kind === "nuvio" ? "Add repo" : "Add addon"}
        </Button>
      ) : canForce ? (
        <Button variant="solid" loading={adding} onClick={() => doAdd(kind!)}>Add without preview</Button>
      ) : null}
    </div>
  );

  return (
    <Panel open onClose={onClose} className="addon-panel" title={p.setup ? `Set up ${p.entry?.name}` : `Add ${name}`} footer={footer}>
      <div className="preview">
        {p.setup && p.entry && (
          <ol className="setup-steps">
            <li>
              <span className="set-label">Set it up on {host(p.entry.configureUrl ?? p.entry.manifestUrl)}</span>
              <p className="set-desc">Sign in or pick your options there. It then gives you a personal manifest URL. Keep that link private: it can contain your account key.</p>
              {p.entry.configureUrl && <Button size="sm" onClick={() => window.open(p.entry!.configureUrl, "_blank", "noopener,noreferrer")}>Open {host(p.entry.configureUrl)}</Button>}
            </li>
            <li>
              <label className="set-label" htmlFor="setup-url">Paste your personal manifest URL</label>
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (paste.trim()) inspect(paste.trim()); }}>
                <input id="setup-url" className="input" type="url" inputMode="url" autoCapitalize="off" autoComplete="off" spellCheck={false}
                  placeholder="https://…/manifest.json" value={paste} onChange={(e) => setPaste(e.target.value)} />
                <Button type="submit" disabled={!paste.trim()} loading={state.loading}>Check</Button>
              </form>
            </li>
          </ol>
        )}

        {state.loading && <div aria-busy="true" className="preview-loading"><SkeletonText lines={2} /><Skeleton height={48} /><Skeleton height={48} /><Skeleton height={48} /></div>}

        {state.error && (
          <StateMessage kind="error" align="start" title="Couldn't preview this addon." body={state.error}
            details={canForce ? (isLan(url) ? "Addresses on your local network can't be previewed. You can still add them." : undefined) : undefined} />
        )}

        {state.data && <PreviewBody d={state.data} entry={p.entry} />}
        {addErr && <p className="set-error" role="alert">{addErr}</p>}
      </div>
    </Panel>
  );
}

function PreviewBody({ d, entry }: { d: AddonPreview; entry?: CatalogEntry }) {
  return (
    <>
      <div className="preview-head">
        <p className="addon-name">{d.name}{d.version && <span className="addon-meta"> · version {d.version}</span>}</p>
        {d.description && <p className="cat-desc">{d.description}</p>}
        {entry && <Flags e={entry} />}
      </div>
      {d.kind === "nuvio" && <p className="set-note" data-tone="warning"><Shield size={20} aria-hidden="true" /><span>{TRUST}</span></p>}
      {entry?.obfuscated && <p className="set-note" data-tone="warning"><AlertCircle size={20} aria-hidden="true" /><span>{entry.obfuscatedCount && entry.scraperCount ? `${entry.obfuscatedCount} of its ${entry.scraperCount} scrapers are obfuscated. ` : ""}{FLAG_HELP.obfuscated}</span></p>}
      {d.warnings.map((w) => <p key={w} className="set-note"><AlertCircle size={20} aria-hidden="true" /><span>{w}</span></p>)}
      {d.kind === "nuvio" ? (
        <>
          <h3 className="set-group-title">Scrapers ({d.scrapers.length})</h3>
          <ListGroup divided label="Scrapers">
            {d.scrapers.map((s) => (
              <ListRow key={s.id} title={s.name} value={s.enabled ? undefined : "Off by default"}
                description={[TYPES(s.supportedTypes), s.contentLanguage?.length ? s.contentLanguage.join(", ").toUpperCase() : ""].filter(Boolean).join(" · ")} />
            ))}
          </ListGroup>
        </>
      ) : (
        <ListGroup divided label="What it provides">
          {d.stream && <ListRow title="Streams" description={TYPES(d.stream.types)} leading={<StatusDot tone="success" />} />}
          {d.subtitles && <ListRow title="Subtitles" description={TYPES(d.subtitles.types)} leading={<StatusDot tone="success" />} />}
        </ListGroup>
      )}
    </>
  );
}
