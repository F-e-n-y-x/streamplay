import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useStore, continueWatching, recentHistory, listFavs, removeHistory, clearHistory, toggleFav, watchHref, getSyncCode, type FavEntry, type HistoryEntry } from "../lib/store";
import { useDocTitle } from "../lib/useDocTitle";
import PosterCard from "../components/PosterCard";
import ContinueCard from "../components/ContinueCard";
import { epLabel, remaining } from "../components/playAction";
import ConfirmDialog from "../components/ConfirmDialog";
import { Button, IconButton, Menu, StateMessage, Tabs, toast } from "../components/ui";
import { ChevronDown, X } from "../components/icons";
import "../styles/mylist.css";

type Tab = "saved" | "continue" | "history";
type Sort = "added" | "title" | "year";
const SORTS: { value: Sort; label: string }[] = [{ value: "added", label: "Recently added" }, { value: "title", label: "Title" }, { value: "year", label: "Release year" }];

/** "Today" / "Yesterday" / "This week" / "October 2026" */
function dayGroup(ts: number): string {
  const d = new Date(ts), now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This week";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
const progressText = (h: HistoryEntry) => (h.duration > 0 && h.position >= h.duration * 0.97 ? "Watched" : remaining(h));

/** My List (route /watchlist): Saved · Continue watching · History. */
export default function Watchlist() {
  useStore();
  useDocTitle("My List");
  const [params, setParams] = useSearchParams();
  const tab = (["saved", "continue", "history"].includes(params.get("tab") ?? "") ? params.get("tab") : "saved") as Tab;
  const setTab = (t: Tab) => setParams(t === "saved" ? {} : { tab: t }, { replace: true });
  const favs = listFavs();
  const cont = continueWatching();
  const hist = recentHistory();
  const [sort, setSort] = useState<Sort>("added");

  return (
    <div className="container mylist">
      <div className="mylist-head">
        <h1 className="t-h1">My List</h1>
        {tab === "saved" && favs.length > 1 && (
          <Menu label="Sort by" align="end" items={SORTS.map((s) => ({ label: s.label, checked: sort === s.value, onSelect: () => setSort(s.value) }))}
            trigger={(p) => <Button {...p} variant="secondary">{SORTS.find((s) => s.value === sort)!.label}<ChevronDown size={16} aria-hidden="true" /></Button>} />
        )}
      </div>
      <Tabs id="mylist" label="My List" value={tab} onChange={setTab} className="mylist-tabs" items={[
        { value: "saved", label: favs.length ? <>Saved <span className="tab-count">{favs.length}</span></> : "Saved" },
        { value: "continue", label: cont.length ? <>Continue watching <span className="tab-count">{cont.length}</span></> : "Continue watching" },
        { value: "history", label: hist.length ? <>History <span className="tab-count">{hist.length}</span></> : "History" },
      ]} />
      <div role="tabpanel" id={`mylist-panel-${tab}`} aria-labelledby={`mylist-tab-${tab}`} className="mylist-panel">
        {tab === "saved" ? <Saved favs={favs} sort={sort} /> : tab === "continue" ? <Continue items={cont} /> : <History items={hist} />}
      </div>
    </div>
  );
}

function Saved({ favs, sort }: { favs: FavEntry[]; sort: Sort }) {
  if (!favs.length) {
    return <StateMessage kind="empty" title="Nothing saved yet" body="Tap + My List on any title to keep it here."
      actions={<Button variant="solid" to="/movies">Browse popular</Button>} />;
  }
  const list = sort === "title" ? [...favs].sort((a, b) => a.title.localeCompare(b.title))
    : sort === "year" ? [...favs].sort((a, b) => (b.year ?? "").localeCompare(a.year ?? "")) : favs;
  const remove = (f: FavEntry) => { toggleFav(f); toast(`Removed ${f.title} from My List`, { action: { label: "Undo", onClick: () => toggleFav(f) } }); };
  return (
    <ul className="grid mylist-grid" role="list">
      {list.map((f) => (
        <li key={f.key} className="saved-item">
          <PosterCard card={f} showType />
          <IconButton className="saved-remove" variant="media" size="sm" label={`Remove ${f.title} from My List`} onClick={() => remove(f)}><X size={16} /></IconButton>
        </li>
      ))}
    </ul>
  );
}

function Continue({ items }: { items: HistoryEntry[] }) {
  if (!items.length) {
    return <StateMessage kind="empty" title="Nothing in progress" body="Start a movie or an episode and it shows up here, so you can pick up where you left off."
      actions={<Button variant="solid" to="/">Find something to watch</Button>} />;
  }
  return <ul className="mylist-wide" role="list">{items.map((h) => <li key={h.key}><ContinueCard h={h} /></li>)}</ul>;
}

function History({ items }: { items: HistoryEntry[] }) {
  const [confirm, setConfirm] = useState(false);
  if (!items.length) {
    return <StateMessage kind="empty" title="You haven't watched anything on this device yet."
      body={getSyncCode() ? "What you watch on your linked devices shows up here too." : <>To see what you watched on other devices, link them in <Link to="/settings/sync" className="text-link">Settings › Sync</Link>.</>} />;
  }
  const groups: { label: string; rows: HistoryEntry[] }[] = [];
  for (const h of items.slice(0, 200)) {
    const label = dayGroup(h.updatedAt);
    if (groups[groups.length - 1]?.label !== label) groups.push({ label, rows: [] });
    groups[groups.length - 1].rows.push(h);
  }
  return (
    <>
      {groups.map((g) => (
        <section key={g.label} className="hist-group" aria-label={g.label}>
          <h2 className="hist-day">{g.label}</h2>
          <ul className="hist-list" role="list">
            {g.rows.map((h) => {
              const art = h.backdropUrl || h.posterUrl;
              const pct = h.duration > 0 ? Math.min(100, (h.position / h.duration) * 100) : 0;
              return (
                <li key={h.key} className="hist-row">
                  <Link to={watchHref(h)} className="hist-link" aria-label={`${progressText(h) === "Watched" ? "Play" : "Resume"} ${h.title} ${epLabel(h)}`}>
                    <span className="hist-thumb">
                      {art ? <img src={art} alt="" width={120} height={68} loading="lazy" decoding="async" /> : null}
                      {pct > 0 && pct < 97 && <span className="hist-bar"><span style={{ width: `${pct}%` }} /></span>}
                    </span>
                    <span className="hist-text">
                      <span className="hist-title">{h.title}</span>
                      <span className="hist-meta">{[epLabel(h), progressText(h)].filter(Boolean).join(" · ")}</span>
                    </span>
                  </Link>
                  <IconButton label={`Remove ${h.title} ${epLabel(h)} from history`} onClick={() => removeHistory(h.key)}><X size={20} /></IconButton>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <div className="hist-foot"><Button variant="danger" onClick={() => setConfirm(true)}>Clear history</Button></div>
      {confirm && <ConfirmDialog title="Clear watch history?" body={`This removes progress for all titles on this device${getSyncCode() ? " and your linked devices" : ""}.`}
        confirm="Clear history" cancel="Keep history" onClose={() => setConfirm(false)} onConfirm={() => { clearHistory(); toast("History cleared"); }} />}
    </>
  );
}
