import { useState } from "react";
import { copyText } from "../../lib/clipboard";
import { updateSettings, useSettings } from "../../lib/settings";
import { browserOk, isDirect, qualityLabel, type SourceLink, type Sources } from "../../lib/useSources";
import { Badge, Button, ListGroup, ListRow, StateMessage, StatusDot, toast } from "../ui";
import { Check, ChevronDown, RotateCcw } from "../icons";

type Tone = "success" | "warning" | "error" | "neutral";
const MIN = 60_000;
const ago = (t: number) => { const m = Math.round((Date.now() - t) / MIN); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

/** One status vocabulary for a source: the dot and the words always agree. */
export function statusOf(l: SourceLink, failedHere?: number): { tone: Tone; text: string } {
  if (failedHere) return { tone: "error", text: `Didn’t play ${ago(failedHere)}` };
  if (l.verified === false) {
    if (l.failures?.lastReason === "geo") return { tone: "error", text: "Blocked in your region" };
    return { tone: "error", text: l.failures?.lastAt ? `Failed ${ago(l.failures.lastAt)}` : "Not responding" };
  }
  if (l.hidden) return { tone: "error", text: "Server keeps failing" };
  if (l.type === "iframe") return { tone: "neutral", text: "Plays in the site’s own player" };
  const fresh = l.verified === true && (!l.verifiedAt || Date.now() - l.verifiedAt < 30 * MIN);
  if (!fresh) return { tone: "neutral", text: "Not checked yet" };
  const ms = l.startupMs ?? l.latencyMs;
  if (ms != null && ms > 3000) return { tone: "warning", text: "Working · slow to start" };
  if (ms != null && ms < 1500) return { tone: "success", text: "Working · starts fast" };
  return { tone: "success", text: "Working" };
}

/** Audio badge text, only when it tells the user something (not their main language). */
export function audioOf(l: SourceLink, primary: string | undefined, anime: boolean): string {
  const t = l.audioTracks ?? [];
  if (anime && t.some((a) => a.dub === true)) return "Dub";
  if (anime && t.some((a) => a.dub === false)) return "Sub";
  const a = l.audio || t[0]?.label || "";
  if (!a) return "";
  if (/multi/i.test(a)) return "Multi-audio";
  if (/dual/i.test(a)) return "Dual audio";
  return primary && a.toLowerCase() === primary.toLowerCase() ? "" : a;
}

const GROUPS = [
  { key: "4K", test: (q: number) => q >= 2160 },
  { key: "1080p", test: (q: number) => q >= 1080 && q < 2160 },
  { key: "720p and lower", test: (q: number) => q > 0 && q < 1080 },
  { key: "Unknown quality", test: (q: number) => !q },
];

/**
 * Change source: the curated escape hatch. Rows grouped by quality, working ones first,
 * one row per provider + quality + audio (duplicates fold into "N more"), failures and
 * external-player-only streams tucked away. Server codenames only ever appear as tooltips.
 */
export default function ChangeSourceView({ sources, anime, onPicked }: { sources: Sources; anime: boolean; onPicked: () => void }) {
  const S = useSettings();
  const { links, current, failed, progress, name, hiddenPids } = sources;
  const [showBad, setShowBad] = useState(false);
  const [showExt, setShowExt] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const primary = S.audioLanguages[0] ?? "English";
  const recent = (l: SourceLink) => !!l.failures?.lastAt && Date.now() - l.failures.lastAt < 10 * MIN;

  const visible = links.filter((l) => !hiddenPids.includes(l.providerId));
  const bad = visible.filter((l) => failed[l.url] || l.verified === false || l.hidden || recent(l));
  const ext = visible.filter((l) => !bad.includes(l) && isDirect(l) && !browserOk(l));
  const good = visible.filter((l) => !bad.includes(l) && !ext.includes(l))
    .sort((a, b) => Number(b.verified === true) - Number(a.verified === true) || (b.score ?? -999) - (a.score ?? -999)
      || (a.startupMs ?? a.latencyMs ?? 9e9) - (b.startupMs ?? b.latencyMs ?? 9e9));

  const pick = (l: SourceLink) => {
    onPicked();
    if (l.url === current?.url) return;
    sources.pick(l);
    toast(`Switched to ${[name(l), qualityLabel(l.quality)].filter(Boolean).join(" · ")}`);
  };
  const remaining = Math.max(0, progress.total - progress.settled);

  // one row per (provider, quality, audio): the best-scored one leads, the rest fold under it
  const fold = (list: SourceLink[]) => {
    const m = new Map<string, SourceLink[]>();
    for (const l of list) {
      const k = `${l.providerId}|${l.quality || 0}|${audioOf(l, primary, anime)}|${l.type === "iframe"}`;
      m.set(k, [...(m.get(k) ?? []), l]);
    }
    return [...m.entries()];
  };

  const row = (l: SourceLink, label: string) => {
    const st = statusOf(l, failed[l.url]);
    const on = l.url === current?.url;
    const audio = audioOf(l, primary, anime);
    return (
      <ListRow key={l.url} className="cs-row" kind="choice" checked={on} title={label} description={st.text} tooltip={l.variant || l.name}
        leading={<StatusDot tone={st.tone} />} onClick={() => pick(l)}
        trailing={<>
          {l.quality ? <Badge>{qualityLabel(l.quality)}</Badge> : null}
          {audio && <Badge>{audio}</Badge>}
        </>} />
    );
  };

  const groups = GROUPS.map((g) => ({ ...g, rows: fold(good.filter((l) => g.test(l.quality || 0))) })).filter((g) => g.rows.length);
  const cur = current;

  return (
    <div className="cs">
      {cur && (
        <div className="cs-now" role="status">
          <span className="cs-now-k">Playing</span>
          <span className="cs-now-v">{[name(cur), qualityLabel(cur.quality), audioOf(cur, undefined, anime)].filter(Boolean).join(" · ")}</span>
          <Check size={18} aria-hidden="true" />
        </div>
      )}

      {progress.done && !visible.length && (
        <StateMessage kind="empty" align="center" title="No streams found for this episode."
          actions={<>
            <Button variant="secondary" onClick={sources.rescan} icon={<RotateCcw size={18} />}>Search again</Button>
            {!S.torrentMode && <Button variant="ghost" onClick={() => updateSettings({ torrentMode: true })}>Use torrent sources</Button>}
          </>} />
      )}

      {groups.map((g) => (
        <section key={g.key} className="cs-group" aria-label={g.key}>
          <h3 className="cs-head">{g.key}</h3>
          <ListGroup role="radiogroup" label={`${g.key} sources`}>
            {g.rows.map(([k, ls]) => {
              const base = name(ls[0]) + (ls[0].type === "iframe" ? " (web player)" : "");
              return (
                <div key={k} className="cs-fold">
                  {row(ls[0], base)}
                  {ls.length > 1 && (open[k]
                    ? ls.slice(1).map((l, i) => row(l, `${base} · Server ${i + 2}`))
                    : <button type="button" className="cs-more btn-link" onClick={() => setOpen((o) => ({ ...o, [k]: true }))}>{ls.length - 1} more from {name(ls[0])}</button>)}
                </div>
              );
            })}
          </ListGroup>
        </section>
      ))}

      {(bad.length > 0 || ext.length > 0) && (
        <div className="cs-extra">
          {bad.length > 0 && (
            <>
              <button type="button" className="cs-toggle" aria-expanded={showBad} onClick={() => setShowBad((v) => !v)}>
                Show {bad.length} unavailable <ChevronDown size={16} aria-hidden="true" />
              </button>
              {showBad && <ListGroup role="radiogroup" label="Unavailable sources">{bad.map((l) => row(l, name(l)))}</ListGroup>}
            </>
          )}
          {ext.length > 0 && (
            <>
              <button type="button" className="cs-toggle" aria-expanded={showExt} onClick={() => setShowExt((v) => !v)}>
                For external players ({ext.length}) <ChevronDown size={16} aria-hidden="true" />
              </button>
              {showExt && (
                <>
                  <p className="cs-note">Your browser can’t decode these. Open them in VLC or another player.</p>
                  <ListGroup>{ext.map((l) => <ExternalRow key={l.url} l={l} label={name(l)} />)}</ListGroup>
                </>
              )}
            </>
          )}
        </div>
      )}

      <div className="cs-foot">
        {!progress.done
          ? <p className="cs-scan"><span className="spin spin-sm" aria-hidden="true" />{remaining ? `Searching ${remaining} more server${remaining === 1 ? "" : "s"}…` : "Searching…"}</p>
          : visible.length > 0 && <Button variant="ghost" size="sm" icon={<RotateCcw size={18} />} onClick={sources.rescan}>Search again</Button>}
        <ListGroup>
          <ListRow kind="toggle" checked={S.torrentMode} onClick={() => updateSettings({ torrentMode: !S.torrentMode })}
            title="Torrent sources" description="Slower to start; finds more anime and older titles. This device only." />
        </ListGroup>
      </div>
    </div>
  );
}

/** Decode the original stream URL from a /api/proxy?url=<b64url> link (for VLC). */
function originalUrl(proxied: string): string {
  try {
    const b = new URL(proxied, location.origin).searchParams.get("url");
    if (!b) return proxied;
    return decodeURIComponent(escape(atob(b.replace(/-/g, "+").replace(/_/g, "/"))));
  } catch { return proxied; }
}

function ExternalRow({ l, label }: { l: SourceLink; label: string }) {
  const [copied, setCopied] = useState(false);
  const url = originalUrl(l.url);
  return (
    <ListRow className="cs-row" title={label} tooltip={l.variant || l.name}
      description={[qualityLabel(l.quality), l.audio].filter(Boolean).join(" · ") || "Stream link"}
      trailing={<>
        <Button variant="ghost" size="sm" onClick={() => { copyText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copied" : "Copy link"}</Button>
        <a className="btn btn-ghost btn-sm" href={`vlc://${url}`}>Open in VLC</a>
      </>} />
  );
}
