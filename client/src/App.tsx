import { lazy, Suspense, useEffect, useState } from "react";
import { Routes, Route, useLocation, Navigate } from "react-router-dom";
import Header from "./components/Header";
import ErrorBoundary from "./components/ErrorBoundary";
import { useAuthNeeded } from "./lib/api";
import { useDocTitle } from "./lib/useDocTitle";
import { Lock } from "./components/icons";
import { Button, StateMessage, Toaster } from "./components/ui";
import "./styles/shell.css";

// Route-level code splitting: each page (and its heavy deps — Watch pulls in
// shaka-player + hls.js) loads on demand.
const Home = lazy(() => import("./pages/Home"));
const Search = lazy(() => import("./pages/Search"));
const Title = lazy(() => import("./pages/Title"));
const Browse = lazy(() => import("./pages/Browse"));
const Watch = lazy(() => import("./pages/Watch"));
const Providers = lazy(() => import("./pages/Providers"));
const Watchlist = lazy(() => import("./pages/Watchlist"));
const Settings = lazy(() => import("./pages/Settings"));
// Design-system catalogue for reviewers (unlinked; its chunk only loads when visited).
const UiShowcase = lazy(() => import("./components/ui/Showcase"));

const RouteFallback = () => (
  <div className="container" aria-busy="true">
    <div className="skeleton" style={{ height: 28, width: 220, marginBottom: "var(--space-5)" }} />
    <div className="grid">{Array.from({ length: 12 }).map((_, i) => <div className="skeleton" key={i} style={{ aspectRatio: "2/3" }} />)}</div>
  </div>
);

function NotFound() {
  useDocTitle("Not found");
  return (
    <div className="container">
      <StateMessage kind="notFound" page align="center" title="This page doesn’t exist" body="The link may be old, or the title was removed."
        actions={<><Button variant="solid" to="/">Go home</Button><Button variant="ghost" to="/search">Search</Button></>} />
    </div>
  );
}

/** STREAMPLAY_PASSWORD gate: `/?key=<pw>` makes the server set an HttpOnly cookie and
 *  redirect back without the key, so a `key` still in the URL means it was wrong. */
function PasswordScreen() {
  const [pw, setPw] = useState("");
  const wrong = new URLSearchParams(location.search).has("key");
  useDocTitle("Locked");
  return (
    <main id="main" className="lock-screen">
      <form className="lock-card" onSubmit={(e) => { e.preventDefault(); if (pw) location.href = `/?key=${encodeURIComponent(pw)}`; }}>
        <span className="mark"><Lock size={22} /></span>
        <h1>This StreamPlay is private</h1>
        <p className="subtle">Enter the server password to continue. This browser will stay signed in.</p>
        <label htmlFor="pw" className="sr-only">Password</label>
        <input id="pw" className="input" type="password" autoComplete="current-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" aria-invalid={wrong || undefined} aria-describedby={wrong ? "pw-err" : undefined} />
        {wrong && <p id="pw-err" className="err" role="alert">That password didn't work.</p>}
        <Button type="submit" variant="solid" size="lg" disabled={!pw}>Unlock</Button>
      </form>
    </main>
  );
}

// ── TV / keyboard spatial navigation ────────────────────────────────────────────
const FOCUSABLE = 'a[href], button:not(:disabled), input:not([type="hidden"]):not(:disabled), select, textarea, [tabindex="0"]';
const CHROME = ".header, .search-overlay, .tabbar";

/** Nearest focusable in the arrow's direction. Left/Right stay on the same line
 *  (row/grid/toolbar); Up/Down pick the nearest line, then the closest x. Page content
 *  is preferred over the sticky chrome so Up doesn't jump to the header while rows
 *  remain above. */
function spatialTarget(from: HTMLElement, key: string): HTMLElement | null {
  const r = from.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const fromChrome = !!from.closest(CHROME);
  // Inside an open popover menu, arrows stay in the menu (it overlays the page).
  const scope: ParentNode = from.closest(".menu") ?? document;
  const all = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) =>
    el !== from && !el.closest("[inert], [aria-hidden='true'], .vp") && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden");
  const pick = (els: HTMLElement[]) => {
    let best: HTMLElement | null = null, bestMain = Infinity, bestCross = Infinity;
    for (const el of els) {
      const b = el.getBoundingClientRect();
      let main: number, cross: number;
      if (key === "ArrowRight" || key === "ArrowLeft") {
        if (b.bottom <= r.top + 2 || b.top >= r.bottom - 2) continue;   // not on this line
        main = key === "ArrowRight" ? b.left - r.right : r.left - b.right;
        cross = Math.abs(b.top + b.height / 2 - (r.top + r.height / 2));
      } else {
        main = key === "ArrowDown" ? b.top - r.bottom : r.top - b.bottom;
        cross = Math.abs(b.left + b.width / 2 - cx);
      }
      if (main < -2) continue;
      // Up/Down: lines within 24px count as the same line → closest x wins there.
      const band = key === "ArrowDown" || key === "ArrowUp" ? 24 : 0;
      if (main < bestMain - band || (Math.abs(main - bestMain) <= band && cross < bestCross)) { best = el; bestMain = Math.min(main, bestMain); bestCross = cross; }
    }
    return best;
  };
  if (fromChrome) return pick(all);
  return pick(all.filter((el) => !el.closest(CHROME))) ?? (key === "ArrowUp" ? pick(all) : null);
}

function useSpatialNav() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const t = e.target as HTMLElement;
      if (t.closest?.(".vp")) return;                                   // the player owns its keys
      if (document.querySelector("dialog[open], [aria-modal='true']")) return;
      const typing = t.matches?.("input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable='true']");
      if (e.key === "Escape" || e.key === "Backspace" || e.key === "GoBack" || e.key === "BrowserBack") {
        if (typing || !(history.state?.idx > 0)) return;
        e.preventDefault();
        history.back();
        return;
      }
      if (typing || t.matches?.("input[type=range]") || !e.key.startsWith("Arrow")) return;
      const from = t === document.body || !t.matches?.(FOCUSABLE) ? null : t;
      if (!from) return;                                                // nothing focused: let the page scroll
      const next = spatialTarget(from, e.key);
      if (!next) return;
      e.preventDefault();
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: "nearest", inline: "nearest" });
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

export default function App() {
  const location = useLocation();
  const locked = useAuthNeeded();
  useSpatialNav();
  if (locked) return <PasswordScreen />;
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <Header />
      <main id="main" tabIndex={-1}>
        <ErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/search" element={<Search />} />
              <Route path="/title/:type/:id" element={<Title />} />
              {/* keyed so each section starts from its own defaults (no shared instance) */}
              <Route path="/movies" element={<Browse key="movies" section="movies" />} />
              <Route path="/series" element={<Browse key="series" section="series" />} />
              <Route path="/anime" element={<Browse key="anime" section="anime" />} />
              <Route path="/asian" element={<Browse key="asian" section="asian" />} />
              <Route path="/watch/:type/:id" element={<Watch />} />
              <Route path="/watch/:type/:id/:season/:episode" element={<Watch />} />
              <Route path="/providers" element={<Navigate to="/settings/providers" replace />} />
              <Route path="/watchlist" element={<Watchlist />} />
              <Route path="/mylist" element={<Navigate to="/watchlist" replace />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/settings/providers" element={<Providers />} />
              <Route path="/settings/:section" element={<Settings />} />
              <Route path="/__ui" element={<UiShowcase />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
      <Toaster />
    </>
  );
}
