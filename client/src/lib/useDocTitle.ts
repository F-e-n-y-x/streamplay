import { useEffect } from "react";

/** Sets document.title to "<title> – StreamPlay" (or just "StreamPlay"). */
export function useDocTitle(title?: string | null) {
  useEffect(() => { document.title = title ? `${title} – StreamPlay` : "StreamPlay"; }, [title]);
}
