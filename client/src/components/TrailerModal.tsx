import { useEffect, useRef } from "react";
import { IconButton } from "./ui";
import { X } from "./icons";
import "../styles/title.css";

/** Trailer video dialog (§8.12: max-width 1100, 16:9, no padding). Esc / scrim / ✕ close.
 *  Kept apart from Player so Title doesn't pull in hls.js. */
export default function TrailerModal({ title, youtubeKey, onClose }: { title: string; youtubeKey: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();   // top layer: focus trap + inert page + Esc for free
    return () => d?.close();
  }, []);

  return (
    <dialog ref={ref} className="trailer" aria-label={title} onClose={onClose}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="trailer-frame">
        <iframe src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeKey)}?autoplay=1&rel=0`} title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
      </div>
      <IconButton variant="media" label="Close trailer" className="trailer-close" onClick={onClose} autoFocus><X size={20} /></IconButton>
    </dialog>
  );
}
