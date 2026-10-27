// /__ui: every primitive in every state, for review screenshots. Not linked from the app.
import { useRef, useState, type ReactNode } from "react";
import { useDocTitle } from "../../lib/useDocTitle";
import { ChevronDown, Filter, Globe, ListVideo, Maximize, MoreVertical, Play, Plus, Settings, Subtitles } from "../icons";
import {
  Badge, Button, EpisodeList, EpisodeListItem, EpisodeListSkeleton, FilterChip, IconButton, InputChip, ListGroup, ListRow,
  Menu, Panel, SegmentedControl, Skeleton, SkeletonText, SourceStatus, StateMessage, StatusDot, Switch, Tabs, Toaster, toast,
} from "./index";

const IMG = "https://image.tmdb.org/t/p/w300/";
const EPISODES = [
  { number: 1, title: "Pilot", still: IMG + "ydlY3iPfeOAvu8gVqrxPoMvzNCn.jpg", runtime: 59, watched: true, overview: "When an unassuming high school chemistry teacher discovers he has a rare form of lung cancer, he decides to team up with a former student and create a top of the line crystal meth in a used RV, to provide for his family once he is gone." },
  { number: 2, title: "Cat's in the Bag...", still: IMG + "AbMoecO0ZZio0LcgeLxlzdyGs6X.jpg", runtime: 49, watched: true, overview: "Walt and Jesse attempt to tie up loose ends. The desperate situation gets more complicated with the flip of a coin." },
  { number: 3, title: "...And the Bag's in the River", still: IMG + "n8Dah3Tc1vlc4i7bQ9zYPWaFO0e.jpg", runtime: 49, progress: 0.68, current: true, overview: "Walter fights with Jesse over his drug use, causing him to leave Walter alone with their captive, Krazy-8. Meanwhile, Hank has a scared straight moment with Walter Jr. after his aunt discovers he has been smoking pot." },
  { number: 4, title: "Cancer Man", still: IMG + "i5BAJVhuIWfkoSqDID6FnQNCTVc.jpg", runtime: 49, progress: 0.3, overview: "Walter finally tells his family that he has been stricken with cancer. Meanwhile, the DEA believes Albuquerque has a new, big time player to worry about." },
  { number: 5, title: "Gray Matter", runtime: 49, overview: "Walter and Skyler attend a former colleague's party. Jesse tries to free himself from the drugs, while Skyler organizes an intervention." },
  { number: 6, title: "Crazy Handful of Nothin'", still: IMG + "j5DgXgtZcA6fioFyaFzdqlt3t6.jpg", runtime: 47, airDate: new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10) },
];
const BACKDROP = "https://image.tmdb.org/t/p/w1280/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg";
const COLORS = ["background", "surface", "surface-2", "surface-3", "foreground", "muted-foreground", "subtle-foreground", "accent", "success", "warning", "error"];
const TYPE = [
  ["display", "Breaking Bad"], ["h1", "My List"], ["h2", "Continue watching"], ["title", "4  Cancer Man"],
  ["body", "Walter finally tells his family that he has been stricken with cancer."], ["label", "Change source"],
  ["meta", "2008 · Series · 5 seasons"], ["caption", "15:23"],
] as const;

function Sec({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="ui-sec" aria-labelledby={`ui-${title}`}>
      <h2 id={`ui-${title}`} className="t-h2">{title}</h2>
      {note && <p className="ui-note">{note}</p>}
      {children}
    </section>
  );
}
const Spec = ({ cap, children, wide }: { cap: string; children: ReactNode; wide?: boolean }) => (
  <figure className={`ui-spec${wide ? " wide" : ""}`}><div className="ui-spec-body">{children}</div><figcaption>{cap}</figcaption></figure>
);

export default function Showcase() {
  useDocTitle("Design system");
  const [chips, setChips] = useState<Record<string, boolean>>({ Action: true, Drama: false, Comedy: false });
  const [langs, setLangs] = useState(["English", "Hindi", "Japanese"]);
  const [audio, setAudio] = useState<"sub" | "dub">("sub");
  const [kind, setKind] = useState<"all" | "series" | "movies">("all");
  const [season, setSeason] = useState("3");
  const [sort, setSort] = useState("popular");
  const [ptab, setPtab] = useState("episodes");
  const [autoNext, setAutoNext] = useState(true);
  const [skip, setSkip] = useState(false);
  const [quality, setQuality] = useState("auto");
  const [sw, setSw] = useState(true);
  const [panel, setPanel] = useState(false);
  const [view, setView] = useState<"root" | "quality">("root");
  const [inPlayer, setInPlayer] = useState(false);
  const [playerToasts, setPlayerToasts] = useState(false);   // route toasts into the mock player
  const player = useRef<HTMLDivElement>(null);
  const SORTS = { popular: "Popular", rating: "Top rated", newest: "Newest", az: "A–Z" } as Record<string, string>;

  return (
    <div className="container ui-page">
      <style>{CSS}</style>
      <header className="ui-top">
        <h1 className="t-h1">Design system</h1>
        <p className="ui-note">Every primitive in <code>components/ui</code>, in every state. Tokens and rules: <code>styles/design-system.md</code>.</p>
      </header>

      <Sec title="Color" note="Neutral chrome; the picture carries the color. One red fill per view (the primary action) plus progress.">
        <div className="ui-swatches">
          {COLORS.map((c) => (
            <div key={c} className="ui-sw"><span style={{ background: `var(--${c})` }} /><code>--{c}</code></div>
          ))}
        </div>
      </Sec>

      <Sec title="Type" note="Plus Jakarta Sans, 400/500/600/700. Sentence case. Nothing below 12px.">
        <div className="ui-type">
          {TYPE.map(([k, s]) => (
            <div key={k} className="ui-type-row"><code>--type-{k}</code><span className={`t-${k}`}>{s}</span></div>
          ))}
        </div>
      </Sec>

      <Sec title="Button" note="Rectangles, radius 8. One primary per view. No outline variant.">
        <div className="ui-row">
          <Spec cap="primary · lg"><Button variant="primary" size="lg" icon={<Play size={20} />} meta="32 min left">Resume S1 · E3</Button></Spec>
          <Spec cap="primary"><Button variant="primary" icon={<Play size={20} />}>Play</Button></Spec>
          <Spec cap="secondary"><Button icon={<Plus size={20} />}>My List</Button></Spec>
          <Spec cap="solid"><Button variant="solid">Save</Button></Spec>
          <Spec cap="ghost"><Button variant="ghost">See all</Button></Spec>
          <Spec cap="danger"><Button variant="danger">Clear history</Button></Spec>
          <Spec cap="link"><Button variant="link">Start over</Button></Spec>
        </div>
        <div className="ui-row">
          <Spec cap="sm"><Button size="sm">Try again</Button></Spec>
          <Spec cap="loading"><Button variant="solid" loading>Saving</Button></Spec>
          <Spec cap="disabled"><Button variant="primary" disabled icon={<Play size={20} />}>Play</Button></Spec>
          <Spec cap="disabled"><Button disabled>Trailer</Button></Spec>
          <Spec cap="phone: full width" wide><Button variant="primary" size="lg" full icon={<Play size={20} />}>Play S1 · E1</Button></Spec>
        </div>
        <div className="ui-art media-dark" style={{ backgroundImage: `var(--scrim-media), url(${BACKDROP})` }}>
          <Button variant="primary" size="lg" icon={<Play size={20} />}>Play</Button>
          <Button variant="media" size="lg" icon={<Plus size={20} />}>My List</Button>
          <Button variant="media" size="lg">More info</Button>
          <span className="ui-art-cap">media · on artwork</span>
        </div>
      </Sec>

      <Sec title="IconButton" note="Circles. Always labelled (aria-label + tooltip).">
        <div className="ui-row">
          <Spec cap="ghost"><IconButton label="Settings"><Settings size={20} /></IconButton></Spec>
          <Spec cap="tonal"><IconButton label="More" variant="tonal"><MoreVertical size={20} /></IconButton></Spec>
          <Spec cap="pressed"><IconButton label="Subtitles" pressed><Subtitles size={20} /></IconButton></Spec>
          <Spec cap="sm"><IconButton label="Episodes" size="sm"><ListVideo size={16} /></IconButton></Spec>
          <Spec cap="lg"><IconButton label="Full screen" size="lg" variant="tonal"><Maximize size={20} /></IconButton></Spec>
          <Spec cap="disabled"><IconButton label="Settings" disabled><Settings size={20} /></IconButton></Spec>
          <Spec cap="media"><span className="ui-dark media-dark"><IconButton label="Play" variant="media" size="lg"><Play size={20} /></IconButton></span></Spec>
        </div>
      </Sec>

      <Sec title="Chips, segmented control, switch" note="Pills only for filters and removable values. Segmented = 2–4 options that change the view now.">
        <div className="ui-row">
          <Spec cap="FilterChip" wide>
            <div className="ui-flow">
              {Object.entries(chips).map(([k, on]) => (
                <FilterChip key={k} selected={on} count={k === "Action" ? 128 : 64} onClick={() => setChips({ ...chips, [k]: !on })}>{k}</FilterChip>
              ))}
            </div>
          </Spec>
          <Spec cap="Filter button + count">
            <Button icon={<Filter size={20} />}>Filters <Badge>2</Badge></Button>
          </Spec>
          <Spec cap="InputChip" wide>
            <div className="ui-flow">{langs.map((l) => <InputChip key={l} onRemove={() => setLangs(langs.filter((x) => x !== l))}>{l}</InputChip>)}</div>
          </Spec>
        </div>
        <div className="ui-row">
          <Spec cap="SegmentedControl"><SegmentedControl label="Audio" value={audio} onChange={setAudio} options={[{ value: "sub", label: "Sub" }, { value: "dub", label: "Dub" }]} /></Spec>
          <Spec cap="3 options"><SegmentedControl label="Show" value={kind} onChange={setKind} options={[{ value: "all", label: "All" }, { value: "series", label: "Series" }, { value: "movies", label: "Movies" }]} /></Spec>
          <Spec cap="Switch on / off / disabled">
            <div className="ui-flow"><Switch label="Autoplay" checked={sw} onChange={setSw} /><Switch label="Off" checked={false} onChange={() => {}} /><Switch label="Disabled" checked disabled onChange={() => {}} /></div>
          </Spec>
        </div>
      </Sec>

      <Sec title="Tabs" note="Text + underline. Overflow scrolls with an edge fade; never clipped mid-word. Arrow keys move.">
        <div className="ui-row">
          <Spec cap="page" wide>
            <Tabs id="ui-sort" label="Sort" value={sort} onChange={setSort} items={Object.entries(SORTS).map(([value, label]) => ({ value, label }))} />
          </Spec>
          <Spec cap="overflow (12 seasons, 320px)" wide>
            <div style={{ width: 320, maxWidth: "100%" }}>
              <Tabs id="ui-seasons" label="Season" value={season} onChange={setSeason}
                items={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: `Season ${i + 1}` }))} />
            </div>
          </Spec>
          <Spec cap="accent (inside player panels)">
            <div className="ui-dark media-dark ui-pad">
              <Tabs id="ui-ptab" label="Panel" accent value={ptab} onChange={setPtab} items={[{ value: "episodes", label: "Episodes" }, { value: "details", label: "Details" }]} />
            </div>
          </Spec>
        </div>
      </Sec>

      <Sec title="ListRow" note="Settings rows, choice lists, source rows. The whole row is the target; current value visible.">
        <div className="ui-row ui-lists">
          <Spec cap="nav · toggle rows" wide>
            <ListGroup label="Player settings" divided>
              <ListRow kind="nav" title="Quality" value="Auto (1080p)" onClick={() => {}} />
              <ListRow kind="nav" title="Subtitles" value="English" onClick={() => {}} />
              <ListRow kind="toggle" title="Autoplay next episode" checked={autoNext} onClick={() => setAutoNext(!autoNext)} />
              <ListRow kind="toggle" title="Skip intros and credits" description="Only when skip data exists" checked={skip} onClick={() => setSkip(!skip)} />
              <ListRow kind="nav" title="Torrent sources" value="Off" disabled onClick={() => {}} />
            </ListGroup>
          </Spec>
          <Spec cap="choice list (radiogroup)" wide>
            <ListGroup role="radiogroup" label="Quality">
              {[["auto", "Auto", "Adjusts to your connection · now 1080p"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"]].map(([v, t, d]) => (
                <ListRow key={v} kind="choice" title={t} description={d} checked={quality === v} onClick={() => setQuality(v)} />
              ))}
            </ListGroup>
          </Spec>
          <Spec cap="source rows" wide>
            <ListGroup role="radiogroup" label="Sources">
              <ListRow kind="choice" checked leading={<StatusDot tone="success" />} title="VidFast" description="Working · starts fast" trailing={<Badge>1080p</Badge>} onClick={() => {}} tooltip="Citadel 2" />
              <ListRow kind="choice" leading={<StatusDot tone="warning" />} title="RiveStream · Server 2" description="Working · slow to start" trailing={<><Badge>4K</Badge><Badge>Hindi</Badge></>} onClick={() => {}} />
              <ListRow kind="choice" leading={<StatusDot />} title="AllMovieLand" description="Not checked yet" trailing={<Badge>1080p</Badge>} onClick={() => {}} />
              <ListRow kind="choice" leading={<StatusDot tone="error" />} title="Vidlink" description="Failed 2 min ago" onClick={() => {}} />
            </ListGroup>
          </Spec>
        </div>
      </Sec>

      <Sec title="Menu" note="Anchored, arrow keys + typeahead, Esc returns focus. On phones a menu with more than 6 items opens as a sheet.">
        <div className="ui-row">
          <Spec cap="single choice">
            <Menu label="Sort by" items={Object.entries(SORTS).map(([v, l]) => ({ label: l, checked: sort === v, onSelect: () => setSort(v) }))}
              trigger={(p) => <Button {...p} variant="ghost">{SORTS[sort]}</Button>} />
          </Spec>
          <Spec cap="actions (overflow)">
            <Menu label="More actions" align="end" items={[
              { label: "Remove from Continue watching", onSelect: () => toast("Removed from Continue watching", { action: { label: "Undo", onClick: () => {} } }) },
              { label: "Mark as watched", onSelect: () => toast("Marked as watched", { tone: "success" }) },
              { label: "Open in VLC", group: "External player", onSelect: () => {} },
              { label: "Copy stream link", onSelect: () => {} },
            ]} trigger={(p) => <IconButton {...p} label="More actions" variant="tonal"><MoreVertical size={20} /></IconButton>} />
          </Spec>
          <Spec cap="season select (> 6 seasons)">
            <Menu label="Season" items={Array.from({ length: 9 }, (_, i) => ({ label: `Season ${i + 1}`, meta: `${8 + i} episodes`, checked: season === String(i + 1), onSelect: () => setSeason(String(i + 1)) }))}
              trigger={(p) => <Button {...p}>Season {season} <ChevronDown size={16} /></Button>} />
          </Spec>
        </div>
      </Sec>

      <Sec title="Panel" note="One primitive: side panel on tablet/desktop/landscape, bottom sheet on phone portrait. Focus trapped, Esc and swipe-down close.">
        <div className="ui-row">
          <Spec cap="page panel (scrim)"><Button onClick={() => { setView("root"); setPanel(true); }} icon={<Settings size={20} />}>Open settings panel</Button></Spec>
          <Spec cap="inside the player (no scrim)"><Button onClick={() => setInPlayer(true)} icon={<ListVideo size={20} />}>Open episodes in player</Button></Spec>
        </div>
        <div ref={player} className="ui-player media-dark" style={{ backgroundImage: `var(--player-scrim-bottom), url(${BACKDROP})` }}>
          <div className="ui-player-bar">
            <IconButton label="Play" variant="media"><Play size={20} /></IconButton>
            <span className="t-caption">15:23</span>
            <span className="ui-seek"><span /></span>
            <span className="t-caption">−32:41</span>
            <IconButton label="Episodes" onClick={() => setInPlayer(true)}><ListVideo size={24} /></IconButton>
            <IconButton label="Settings"><Settings size={24} /></IconButton>
          </div>
          {playerToasts && <Toaster placement="top" />}
        </div>
        <SourceStatus state="playing" provider="VidFast" quality="1080p" audio="English" onChangeSource={() => { setPlayerToasts(true); toast("Switched to RiveStream · 1080p", { tone: "success", action: { label: "Change", onClick: () => {} } }); }} />

        <Panel open={panel} onClose={() => setPanel(false)} view={view} title={view === "root" ? "Settings" : "Quality"}
          onBack={view === "quality" ? () => setView("root") : undefined}>
          {view === "root" ? (
            <ListGroup label="Settings">
              <ListRow kind="nav" title="Quality" value="Auto (1080p)" onClick={() => setView("quality")} />
              <ListRow kind="nav" title="Audio" value="English" onClick={() => {}} />
              <ListRow kind="nav" title="Playback speed" value="Normal" onClick={() => {}} />
              <hr className="list-sep" />
              <ListRow kind="toggle" title="Autoplay next episode" checked={autoNext} onClick={() => setAutoNext(!autoNext)} />
              <ListRow kind="nav" title="Source" value="VidFast · 1080p" leading={<Globe size={20} />} onClick={() => {}} />
            </ListGroup>
          ) : (
            <ListGroup role="radiogroup" label="Quality">
              {[["auto", "Auto", "Adjusts to your connection · now 1080p"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"]].map(([v, t, d]) => (
                <ListRow key={v} kind="choice" title={t} description={d} checked={quality === v} onClick={() => setQuality(v)} />
              ))}
            </ListGroup>
          )}
        </Panel>
        <Panel open={inPlayer} onClose={() => setInPlayer(false)} title="Episodes" container={player.current} scrim={false}
          subheader={<Tabs id="ui-pseason" label="Season" accent value={season} onChange={setSeason} items={["1", "2", "3", "4", "5"].map((v) => ({ value: v, label: `Season ${v}` }))} />}>
          <EpisodeList label="Season 1">
            {EPISODES.map((e) => <EpisodeListItem key={e.number} {...e} onSelect={() => setInPlayer(false)} />)}
          </EpisodeList>
        </Panel>
      </Sec>

      <Sec title="SourceStatus" note="One line under the player says what is playing. Internals never reach it.">
        <div className="ui-stack">
          <SourceStatus state="finding" />
          <SourceStatus state="finding" checked={14} total={36} />
          <SourceStatus state="starting" provider="VidFast" quality="1080p" />
          <SourceStatus state="playing" provider="VidFast" quality="1080p" audio="English" onChangeSource={() => {}} />
          <SourceStatus state="playing" provider="RiveStream" quality="720p" slow onChangeSource={() => {}} />
          <SourceStatus state="switching" />
          <SourceStatus state="web" provider="VidSrc" onChangeSource={() => {}} />
          <SourceStatus state="failed" onChangeSource={() => {}} />
          <SourceStatus state="offline" />
        </div>
      </Sec>

      <Sec title="EpisodeListItem" note="Still, number, title, runtime, progress or watched, expandable synopsis. The current episode is tinted with a red bar.">
        <div className="ui-row ui-lists">
          <Spec cap="panel / Watch rail" wide>
            <EpisodeList label="Season 1">{EPISODES.map((e) => <EpisodeListItem key={e.number} {...e} />)}</EpisodeList>
          </Spec>
          <Spec cap="page (Title) · loading" wide>
            <EpisodeList label="Season 1">{EPISODES.slice(2, 4).map((e) => <EpisodeListItem key={e.number} {...e} size="page" current={false} />)}</EpisodeList>
            <EpisodeListSkeleton rows={2} size="page" />
          </Spec>
        </div>
      </Sec>

      <Sec title="Badge" note="Neutral only. Allowed: quality, audio language, a count, New, Watched.">
        <div className="ui-flow"><Badge>4K</Badge><Badge>1080p</Badge><Badge>Hindi</Badge><Badge>Dub</Badge><Badge>New</Badge><Badge>3</Badge></div>
      </Sec>

      <Sec title="Toast" note="One at a time; a newer one replaces the older. 4s, 8s with an action; pauses on hover/focus.">
        <div className="ui-flow">
          <Button onClick={() => { setPlayerToasts(false); toast("Added to My List", { tone: "success" }) }}>Success</Button>
          <Button onClick={() => { setPlayerToasts(false); toast("VidFast stopped working. Switched to VidEasy · 1080p.", { action: { label: "Change", onClick: () => {} } }) }}>With action</Button>
          <Button onClick={() => { setPlayerToasts(false); toast("Couldn't save settings. Check your connection.", { tone: "error" }) }}>Error</Button>
        </div>
      </Sec>

      <Sec title="Skeleton" note="Same shape as the final layout. Never “Loading…” on its own.">
        <div className="ui-row" aria-busy="true">
          {[0, 1, 2].map((i) => <div key={i} style={{ width: 120 }}><Skeleton aspect="2 / 3" /><div style={{ height: 8 }} /><SkeletonText lines={2} /></div>)}
          <div style={{ width: 260 }}><Skeleton aspect="16 / 9" /><div style={{ height: 8 }} /><SkeletonText lines={1} width="70%" /></div>
        </div>
      </Sec>

      <Sec title="StateMessage" note="Empty = what this is + how to fill it. Error = what failed + the fix. Left-aligned on pages, centred in panels and the player.">
        <div className="ui-row ui-states">
          <StateMessage kind="empty" title="Your list is empty" body="Add shows and movies with My List on any title page." actions={<Button variant="solid" to="/">Browse titles</Button>} />
          <StateMessage kind="error" title="Couldn't load this title" body="The server didn't answer. Try again in a moment." details="Error: API 504 for /title/tv/160803"
            actions={<><Button variant="solid">Try again</Button><Button variant="ghost">Go back</Button></>} />
          <StateMessage kind="offline" title="You're offline" body="Playback will resume when you're back online." actions={<Button>Try again</Button>} />
          <div className="ui-dark media-dark ui-stage">
            <StateMessage kind="error" align="center" title="Couldn't play S1 · E3" body="The streams we tried didn't start. Others may still work."
              actions={<><Button variant="solid">Choose a source</Button><Button variant="media">Try again</Button></>} />
          </div>
        </div>
      </Sec>
    </div>
  );
}

const CSS = `
.ui-page { max-width: 76rem; padding-bottom: var(--space-20); }
.ui-top { padding: var(--space-6) 0 var(--space-4); }
.ui-top h1 { margin: 0 0 var(--space-2); }
.ui-note { margin: 0 0 var(--space-5); font: var(--type-body); color: var(--muted-foreground); max-width: 68ch; }
.ui-note code, .ui-type-row code, .ui-sw code { font: 500 0.75rem/1.2 var(--font-mono); color: var(--subtle-foreground); }
.ui-sec { padding: var(--space-10) 0; border-top: 1px solid var(--border); }
.ui-sec > h2 { margin: 0 0 var(--space-2); }
.ui-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--space-6) var(--space-8); margin-bottom: var(--space-6); }
.ui-flow { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.ui-stack { display: flex; flex-direction: column; max-width: 40rem; }
.ui-spec { margin: 0; display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.ui-spec.wide { flex: 1 1 18rem; }
.ui-spec figcaption { font: var(--type-caption); color: var(--subtle-foreground); }
.ui-spec-body { display: flex; align-items: center; min-height: 3rem; min-width: 0; }
.ui-spec.wide .ui-spec-body { display: block; }
.ui-lists .ui-spec.wide { flex-basis: 22rem; }
.ui-swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr)); gap: var(--space-4); }
.ui-sw { display: flex; flex-direction: column; gap: var(--space-2); }
.ui-sw span { height: 3.5rem; border-radius: var(--radius-md); box-shadow: inset 0 0 0 1px var(--border); }
.ui-type { display: flex; flex-direction: column; gap: var(--space-4); }
.ui-type-row { display: grid; grid-template-columns: 9rem minmax(0, 1fr); align-items: baseline; gap: var(--space-4); }
.ui-art { position: relative; display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-3); min-height: 15rem; padding: var(--space-6); background-size: cover; background-position: center 30%; }
.ui-art-cap { position: absolute; top: var(--space-4); left: var(--space-6); font: var(--type-caption); color: var(--muted-foreground); }
.ui-dark { display: inline-flex; padding: var(--space-3); background: var(--background); border-radius: var(--radius-md); }
.ui-pad { display: block; padding: var(--space-2) var(--space-4) 0; }
.ui-player { position: relative; aspect-ratio: 16 / 9; max-height: 34rem; overflow: hidden; border-radius: var(--radius-xl); background-color: #000; background-size: cover; background-position: center; display: flex; align-items: flex-end; }
.ui-player-bar { flex: 1; display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); }
.ui-seek { flex: 1; height: 4px; border-radius: var(--radius-xs); background: rgba(255, 255, 255, 0.3); }
.ui-seek > span { display: block; width: 32%; height: 100%; border-radius: inherit; background: var(--accent); }
.ui-states { align-items: stretch; }
.ui-states > * { flex: 1 1 20rem; }
.ui-states .state-msg { padding: 0; }
.ui-stage { display: grid; place-items: center; min-height: 16rem; }
@media (max-width: 767px) {
  .ui-type-row { grid-template-columns: minmax(0, 1fr); gap: var(--space-1); }
  .ui-player-bar .t-caption { display: none; }
  .ui-art { min-height: 12rem; padding: var(--space-4); }
}
`;
