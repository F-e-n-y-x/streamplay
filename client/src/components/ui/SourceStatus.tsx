import { Button, StatusDot } from "./Button";

export type SourceState = "finding" | "starting" | "playing" | "switching" | "web" | "failed" | "offline";

/**
 * The one line that says what's playing, under the player:
 *   ● Playing from VidFast · 1080p · English   Change source
 * Phone shortens to "● VidFast · 1080p   Change". The text is a live region, so state changes
 * are announced ("Playing from VidFast, 1080p").
 */
export function SourceStatus({ state, provider, quality, audio, slow, checked, total, onChangeSource }: {
  state: SourceState;
  /** Display name only ("VidFast"), never a server codename */
  provider?: string;
  /** "1080p", "4K" */
  quality?: string;
  /** Only when known: "English" */
  audio?: string;
  /** Playing but slow to start → warning dot */
  slow?: boolean;
  /** Finding progress, pass after ~4s: "Still looking: checked 14 of 36 servers" */
  checked?: number;
  total?: number;
  onChangeSource?: () => void;
}) {
  const busy = state === "finding" || state === "starting" || state === "switching";
  const tone = state === "failed" ? "error" : state === "offline" ? "neutral" : slow ? "warning" : "success";
  const facts = [quality, audio].filter(Boolean) as string[];
  let text;
  if (state === "finding") text = <span className="ss-name">{checked != null && total ? `Still looking: checked ${checked} of ${total} servers` : "Finding a stream…"}</span>;
  else if (state === "starting") text = <><span className="ss-lead">Starting</span><span className="ss-name">{provider}</span>{facts.slice(0, 1).map((f) => <span key={f} className="ss-fact">{f}</span>)}</>;
  else if (state === "switching") text = <span className="ss-name">Switching to a working stream…</span>;
  else if (state === "playing") text = <><span className="ss-lead">Playing from</span><span className="ss-name">{provider}</span>{facts.map((f) => <span key={f} className="ss-fact">{f}</span>)}</>;
  else if (state === "web") text = <span className="ss-name">Playing in {provider}’s web player</span>;
  else if (state === "failed") text = <span className="ss-name">Couldn’t play this stream</span>;
  else text = <span className="ss-name">You’re offline</span>;
  return (
    <div className="source-status">
      {busy ? <span className="spin spin-sm" aria-hidden="true" /> : <StatusDot tone={tone} />}
      <span className="ss-text" role="status" data-quiet={busy ? "" : undefined}>{text}</span>
      {onChangeSource && state !== "finding" && state !== "switching" && (
        <Button variant="ghost" size="sm" onClick={onChangeSource}>
          <span className="ss-long">Change source</span><span className="ss-short">Change</span>
        </Button>
      )}
    </div>
  );
}
