import { useEffect, useRef } from "react";

/**
 * Click-and-drag horizontal scrolling for a card rail (desktop). Touch devices
 * already scroll natively, so we only hijack MOUSE drags. A drag past a few pixels
 * is suppressed from the trailing click so dragging the rail never navigates into
 * whatever card the mouse happened to be over.
 *
 * Attach the returned ref to the scroll container (e.g. `.row-track`). While dragging
 * it gets a `dragging` class (see app.css: grab/grabbing cursor + no smooth-scroll).
 */
export function useDragScroll<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let down = false, startX = 0, startLeft = 0, moved = false;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;  // touch/pen scroll natively
      down = true; moved = false; startX = e.clientX; startLeft = el.scrollLeft;
      el.classList.add("dragging");
    };
    const onMove = (e: PointerEvent) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 4) moved = true;
      el.scrollLeft = startLeft - dx;
    };
    const onUp = () => { if (!down) return; down = false; el.classList.remove("dragging"); };
    // Capture-phase click swallow: if the pointer moved, cancel the click so a card
    // Link doesn't fire (React's synthetic click won't run either — the native event
    // is stopped before it reaches the root).
    const onClick = (e: MouseEvent) => { if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; } };
    el.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    el.addEventListener("click", onClick, true);
    return () => {
      el.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      el.removeEventListener("click", onClick, true);
    };
  }, []);
  return ref;
}
