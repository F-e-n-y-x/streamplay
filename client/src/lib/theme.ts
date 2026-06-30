// Theme toggle — flips data-theme on <html> and persists. Pre-paint script in index.html
// sets the initial value to avoid a flash.

export type Theme = "dark" | "light";

export function getTheme(): Theme {
  return (document.documentElement.getAttribute("data-theme") as Theme) || "dark";
}

export function setTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
  try {
    localStorage.setItem("sp.theme", t);
  } catch {
    /* ignore */
  }
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}
