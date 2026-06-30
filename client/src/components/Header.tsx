import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { api, type HealthInfo } from "../lib/api";
import { getTheme, toggleTheme, type Theme } from "../lib/theme";
import { Activity, Bookmark, Clapperboard, Globe, Home, MonitorPlay, Moon, Play, Search, Settings as SettingsIcon, Sparkles, Sun, X } from "./icons";
import SettingsModal from "./SettingsModal";

const NAV = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/movies", label: "Movies", icon: Clapperboard },
  { to: "/series", label: "Series", icon: MonitorPlay },
  { to: "/anime", label: "Anime", icon: Sparkles },
  { to: "/asian", label: "Asian", icon: Globe },
  { to: "/watchlist", label: "Library", icon: Bookmark },
  { to: "/providers", label: "Providers", icon: Activity },
];

export default function Header() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const overlayInput = useRef<HTMLInputElement>(null);

  useEffect(() => { api.health().then(setHealth).catch(() => setHealth(null)); }, []);
  useEffect(() => { if (searchOpen) overlayInput.current?.focus(); }, [searchOpen]);

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
        <button className="btn btn-icon btn-ghost" aria-label="Toggle theme" onClick={() => setThemeState(toggleTheme())}>
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button className="btn btn-icon btn-ghost" aria-label="Settings" onClick={() => setShowSettings(true)}>
          <SettingsIcon size={18} />
        </button>
      </header>

      {searchOpen && (
        <div className="search-overlay">
          <form className="search-overlay-form" onSubmit={onSearch} role="search">
            <Search size={18} />
            <input ref={overlayInput} className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search movies & TV…" aria-label="Search" />
            <button type="submit" className="btn btn-primary btn-sm">Search</button>
          </form>
        </div>
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </>
  );
}
