import { useEffect, useId, useRef, useState } from "react";
import { useSeason } from "../../lib/queries";
import { getHistoryEntry, useStore } from "../../lib/store";
import type { Episode, MetaSource, SeasonStub } from "../../lib/types";
import { EpisodeList, EpisodeListItem, EpisodeListSkeleton, Panel, StateMessage, Tabs } from "../ui";

export type Ep = Episode & { runtime?: number };
const RANGE = 50;
const seasonLabel = (s: SeasonStub) => s.name || `Season ${s.seasonNumber}`;

/** Season switch: underline tabs for ≤6 seasons, a native select beyond that (or always,
 *  `select`, where tabs would clip: the 400px in-player panel). */
export function SeasonPicker({ seasons, value, onChange, accent, select }: { seasons: SeasonStub[]; value: number; onChange: (n: number) => void; accent?: boolean; select?: boolean }) {
  const id = useId();
  if (seasons.length <= 1) return null;
  if (seasons.length <= 6 && !select) {
    return <Tabs id={id} label="Season" accent={accent} value={String(value)} onChange={(v) => onChange(Number(v))}
      items={seasons.map((s) => ({ value: String(s.seasonNumber), label: seasonLabel(s) }))} />;
  }
  return (
    <select className="ep-select" aria-label="Season" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {seasons.map((s) => <option key={s.seasonNumber} value={s.seasonNumber}>{seasonLabel(s)}</option>)}
    </select>
  );
}

/**
 * One season's episodes as EpisodeListItem rows (still, number + title, runtime, progress,
 * synopsis). Loads the season itself; the current episode is highlighted and scrolled into
 * the middle of the nearest list scroller (never the page).
 */
export function EpisodeRows({ showId, season, src, current, playing, onPick }: {
  showId: number; season: number; src?: MetaSource;
  current?: { season: number; episode: number };
  /** The current episode is actually playing (equalizer + "Playing"), not finding/failed */
  playing?: boolean;
  /** Called when a row is chosen (e.g. close the panel); navigation is the row's link. */
  onPick?: () => void;
}) {
  useStore();   // progress markers follow history
  const { data, isPending, isError } = useSeason(showId, season, true, src);
  const eps = (data?.episodes ?? []) as Ep[];
  const curEp = current?.season === season ? current.episode : undefined;
  const [from, setFrom] = useState(1);
  useEffect(() => { setFrom(curEp ? Math.floor((curEp - 1) / RANGE) * RANGE + 1 : 1); }, [season, curEp]);
  const ref = useRef<HTMLDivElement>(null);

  // Current row already in view → leave the list alone. Else align the row before it to
  // the top (context above, current right below). The Panel then sees it visible: one scroll.
  useEffect(() => {
    const row = ref.current?.querySelector<HTMLElement>(".epi[data-current]");
    const box = row?.closest<HTMLElement>(".panel-body, [data-episodes-scroll]");
    if (!row || !box || box.scrollHeight <= box.clientHeight) return;
    const r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
    if (r.top >= b.top && r.bottom <= b.bottom) return;
    const anchor = (row.previousElementSibling as HTMLElement | null) ?? row;
    box.scrollTop += anchor.getBoundingClientRect().top - b.top - parseFloat(getComputedStyle(box).paddingTop);
  }, [eps.length, curEp, from]);

  if (isPending) return <EpisodeListSkeleton rows={4} />;
  if (isError || !eps.length) return <StateMessage kind="empty" align="center" title="Episode list isn’t available for this season." />;

  const shown = eps.length > RANGE ? eps.filter((e) => e.episodeNumber >= from && e.episodeNumber < from + RANGE) : eps;
  return (
    <div ref={ref} className="ep-rows">
      {eps.length > RANGE && (
        <select className="ep-select ep-range" aria-label="Episode range" value={from} onChange={(e) => setFrom(Number(e.target.value))}>
          {Array.from({ length: Math.ceil(eps.length / RANGE) }, (_, i) => i * RANGE + 1).map((s) =>
            <option key={s} value={s}>Episodes {s}–{Math.min(s + RANGE - 1, eps.length)}</option>)}
        </select>
      )}
      <EpisodeList label={`Season ${season} episodes`}>
        {shown.map((e) => {
          const h = getHistoryEntry("tv", showId, season, e.episodeNumber);
          const p = h && h.duration > 0 ? h.position / h.duration : 0;
          const isCur = e.episodeNumber === curEp;
          return (
            <EpisodeListItem key={e.episodeNumber} number={e.episodeNumber} title={e.name || `Episode ${e.episodeNumber}`}
              still={e.stillUrl} runtime={e.runtime} overview={e.overview} airDate={e.airDate}
              progress={p} watched={p >= 0.9 && !isCur} current={isCur} currentLabel={isCur && !playing ? "Current" : undefined}
              to={isCur ? undefined : `/watch/tv/${showId}/${season}/${e.episodeNumber}`} onSelect={onPick} />
          );
        })}
      </EpisodeList>
    </div>
  );
}

/** ☰ in the player: the season's episodes in a Panel inside the player (works in fullscreen). */
export default function EpisodesPanel({ open, onClose, container, showId, showTitle, seasons, src, season, episode, playing }: {
  open: boolean; onClose: () => void; container: HTMLElement | null;
  showId: number; showTitle: string; seasons: SeasonStub[]; src?: MetaSource; season: number; episode: number; playing?: boolean;
}) {
  const [view, setView] = useState(season);
  useEffect(() => { if (open) setView(season); }, [open, season]);
  const count = seasons.find((s) => s.seasonNumber === view)?.episodeCount;
  return (
    <Panel open={open} onClose={onClose} container={container} scrim={false} title="Episodes" className="ep-panel"
      subheader={<>
        <p className="ep-panel-meta">{showTitle}{count ? ` · ${count} episodes` : ""}</p>
        <SeasonPicker seasons={seasons} value={view} onChange={setView} select />
      </>}>
      <EpisodeRows showId={showId} season={view} src={src} current={{ season, episode }} playing={playing} onPick={onClose} />
    </Panel>
  );
}
