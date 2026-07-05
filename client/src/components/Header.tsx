import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, useNavigate, useLocation } from "react-router-dom";
import { api, type HealthInfo } from "../lib/api";
import { getTheme, toggleTheme, type Theme } from "../lib/theme";
import { Activity, Bookmark, Clapperboard, Globe, Home, MonitorPlay, Moon, Play, Search, Settings as SettingsIcon, Sparkles, Sun, X } from "./icons";

const NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/movies", label: "Movies", icon: Clapperboard },
  { to: "/series", label: "Series", icon: MonitorPlay },
  { to: "/anime", label: "Anime", icon: Sparkles },
  { to: "/asian", label: "Asian", icon: Globe },
  { to: "/watchlist", label: "Library", icon: Bookmark },
];

export default function Header() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [q, setQ] = useState("");
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [navMinimized, setNavMinimized] = useState(false);
  const overlayInput = useRef<HTMLInputElement>(null);

  // Hide-on-scroll for the SECOND bar applies ONLY on the player page.
  const onWatch = pathname.startsWith("/watch");

  // Poll health so the Live/Fallback pill reflects TMDB going down (or recovering)
  // instead of freezing at whatever it was on first mount.
  useEffect(() => {
    let alive = true;
    const load = () => api.health().then((h) => { if (alive) setHealth(h); }).catch(() => { if (alive) setHealth(null); });
    load();
    const t = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  useEffect(() => { if (searchOpen) overlayInput.current?.focus(); }, [searchOpen]);

  // Both bars behave like this:
  //   • TOP edge bar (logo/search/settings): pinned & visible ALWAYS, every page.
  //   • SECOND bar (Movies/Anime/…):
  //       – on browse/home/search pages → ALWAYS visible (never hides on scroll);
  //       – ONLY on the player page → visible at the top, hides when you scroll DOWN
  //         and reappears when you scroll UP (so the player/sources get the room).
  // The window is the scroll container now (app.css uses overflow-x:clip).
  useEffect(() => { setNavMinimized(false); }, [pathname]);
  useEffect(() => {
    if (!onWatch) { setNavMinimized(false); return; }   // never hide off the player page
    const st = () => window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    let last = st();
    const onScroll = () => {
      const y = st();
      if (y < 60) setNavMinimized(false);            // topmost section: always visible
      else if (y > last + 6) setNavMinimized(true);  // scrolling down: hide
      else if (y < last - 6) setNavMinimized(false); // scrolling up: reveal
      last = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [onWatch]);

  function onSearch(e: FormEvent) {
    e.preventDefault();
    if (q.trim()) { nav(`/search?q=${encodeURIComponent(q.trim())}`); setSearchOpen(false); }
  }

  return (
    <>
      <header className="header">
        <Link to="/" className="brand" aria-label="StreamPlay home">
          <span className="mark"><Play size={16} /></span>
          <span className="brand-name">StreamPlay</span>
        </Link>

        <nav className="nav-links" aria-label="Primary">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`} title={n.label}>
              <n.icon size={16} /> <span className="nav-text">{n.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="grow" />

        {/* desktop: inline search */}
        <form className="header-search" onSubmit={onSearch} role="search">
          <Search size={16} />
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search movies & TV…" aria-label="Search" />
        </form>

        {/* mobile: search toggles an overlay */}
        <button className="btn btn-icon btn-ghost search-toggle" aria-label="Search" onClick={() => setSearchOpen((v) => !v)}>
          {searchOpen ? <X size={18} /> : <Search size={18} />}
        </button>

        {health && (
          <span className={`badge live-pill ${health.tmdb === "live" ? "badge-success" : "badge-warning"}`} title={health.tmdb === "live" ? "Live TMDB data" : "Fallback data (no TMDB key)"}>
            {health.tmdb === "live" ? "Live" : "Fallback"}
          </span>
        )}
        <NavLink to="/providers" className={({ isActive }) => `btn btn-icon btn-ghost ${isActive ? "active" : ""}`} title="Providers" aria-label="Providers">
          <Activity size={18} />
        </NavLink>
        <button className="btn btn-icon btn-ghost" aria-label="Toggle theme" onClick={() => setThemeState(toggleTheme())}>
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <NavLink to="/settings" className={({ isActive }) => `btn btn-icon btn-ghost ${isActive ? "active" : ""}`} aria-label="Settings" title="Settings">
          <SettingsIcon size={18} />
        </NavLink>
      </header>

      {/* mobile/tablet: a secondary section bar under the top bar (the primary
          nav-links are hidden at that width). Hidden while the search overlay is open
          so the two don't both stick at top:header-height and paint over each other. */}
      {!searchOpen && (
        <nav className={`nav-mobile ${navMinimized ? "minimized" : ""}`} aria-label="Sections">
          {/* Home omitted here — the brand logo in the top bar already goes home. */}
          {NAV.filter((n) => n.to !== "/").map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-mobile-link ${isActive ? "active" : ""}`}>
              <n.icon size={16} /> <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
      )}

      {searchOpen && (
        <div className="search-overlay">
          <form className="search-overlay-form" onSubmit={onSearch} role="search">
            <Search size={18} />
            <input ref={overlayInput} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search movies & TV…" aria-label="Search" />
            <button type="submit" className="btn btn-primary btn-sm">Search</button>
          </form>
        </div>
      )}

    </>
  );
}
