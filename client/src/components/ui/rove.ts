import type { KeyboardEvent } from "react";

/** Arrow-key roving inside a composite widget (tabs, radiogroup, menu, list).
 *  Returns the item to move to (already focused), or null if the key isn't a move key. */
export function rove(e: KeyboardEvent<HTMLElement>, selector: string, axis: "x" | "y" | "both" = "x"): HTMLElement | null {
  const prev = (axis !== "y" && e.key === "ArrowLeft") || (axis !== "x" && e.key === "ArrowUp");
  const next = (axis !== "y" && e.key === "ArrowRight") || (axis !== "x" && e.key === "ArrowDown");
  if (!prev && !next && e.key !== "Home" && e.key !== "End") return null;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(selector)].filter((el) => !(el as HTMLButtonElement).disabled);
  if (!items.length) return null;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const to = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (next ? 1 : -1) + items.length) % items.length;
  e.preventDefault();
  e.stopPropagation();   // keep the app's spatial TV navigation out of it
  items[to].focus();
  return items[to];
}
