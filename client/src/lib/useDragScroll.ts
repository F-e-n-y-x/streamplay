/**
 * Callback ref: click-and-drag horizontal scrolling for a card rail (mouse only —
 * touch/pen scroll natively). A drag past a few pixels swallows the trailing click
 * so dragging never opens the card under the cursor. Use as `ref={dragScroll}`
 * (React 19 runs the returned cleanup when the element unmounts).
 */
export function dragScroll(el: HTMLElement | null) {
  if (!el) return;
  let down = false, startX = 0, startLeft = 0, moved = false;
  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    e.preventDefault();   // stop native image/link drag from hijacking the gesture
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
}
