import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import SearchBox from "./SearchBox";
import { Bookmark, Clapperboard, Globe, Home, MonitorPlay, Play, Search, Settings as SettingsIcon, Sparkles, X } from "./icons";
import { IconButton } from "./ui";

const SECTIONS = [
  { to: "/movies", label: "Movies", icon: Clapperboard },
  { to: "/series", label: "Series", icon: MonitorPlay },
  { to: "/anime", label: "Anime", icon: Sparkles },
  { to: "/asian", label: "Asian", icon: Globe },
];
const NAV: { to: string; label: string; end?: boolean }[] = [{ to: "/", label: "Home", end: true }, ...SECTIONS, { to: "/watchlist", label: "My List" }];
const BROWSE = SECTIONS.map((s) => s.to);

/**
 * App chrome (CSS in styles/shell.css decides what shows):
 *   ≥1100     logo · text nav · search field · settings
 *   768–1099  logo mark · text nav (scrolls, edge fade) · search icon (opens a bar) · settings
 *   <768      slim bar: logo · search icon  +  bottom tab bar; no top bar on Watch
 * On Home and Title the bar floats transparent over the art until the page scrolls 8px.
 */
export default function Header() {
  const nav = useNavigate();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const urlQ = pathname === "/search" ? params.get("q") ?? "" : "";
  const [q, setQ] = useState(urlQ);
  const [searchOpen, setSearchOpen] = useState(false);
  const overlayInput = useRef<HTMLInputElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const onWatch = pathname.startsWith("/watch/");   // not "/watchlist"
  // Home and Title start with full-bleed art: the bar floats over it until the page scrolls
  const onArt = pathname === "/" || pathname.startsWith("/title/");
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => { setQ(urlQ); }, [urlQ]);   // header field mirrors the results page query
  useEffect(() => { if (searchOpen) overlayInput.current?.focus(); }, [searchOpen]);
  useEffect(() => { setSearchOpen(false); }, [pathname]);

  useEffect(() => {
    if (!onArt) return;
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [onArt]);

  // Tablet: the text nav scrolls sideways when it doesn't fit; fade the edge that has more.
  useLayoutEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const sync = () => {
      el.toggleAttribute("data-fade-start", el.scrollLeft > 1);
      el.toggleAttribute("data-fade-end", el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    };
    // keep the active link in view, sideways only (scrollIntoView could move the page)
    const a = el.querySelector<HTMLElement>(".active");
    if (a && (a.offsetLeft < el.scrollLeft || a.offsetLeft + a.offsetWidth > el.scrollLeft + el.clientWidth)) el.scrollLeft = a.offsetLeft - 24;
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    el.addEventListener("scroll", sync, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener("scroll", sync); };
  }, [pathname]);

  const onSearch = (v: string) => { if (v.trim()) nav(`/search?q=${encodeURIComponent(v.trim())}`); };
  const overHero = onArt && !scrolled && !searchOpen;

  return (
    <>
      <header className={overHero ? "header media-dark" : "header"} data-over-art={onArt ? "" : undefined} data-over-hero={overHero ? "" : undefined} data-watch={onWatch ? "" : undefined}>
        <div className="header-inner">
          <Link to="/" className="brand" aria-label="StreamPlay home">
            <span className="mark" aria-hidden="true"><Play size={16} fill="currentColor" /></span>
            <span className="brand-name">StreamPlay</span>
          </Link>

          <nav ref={navRef} className="nav-links" aria-label="Primary">
            {NAV.map((n) => <NavLink key={n.to} to={n.to} end={n.end} className="nav-link">{n.label}</NavLink>)}
          </nav>

          <span className="grow" />

          <SearchBox className="header-search" value={q} onChange={setQ} onSubmit={onSearch} />
          <IconButton className="search-toggle" label={searchOpen ? "Close search" : "Search"} aria-expanded={searchOpen}
            onClick={() => setSearchOpen((v) => !v)}>
            {searchOpen ? <X size={20} /> : <Search size={20} />}
          </IconButton>
          {pathname !== "/search" && <IconButton className="search-link" label="Search" to="/search"><Search size={20} /></IconButton>}
          <NavLink to="/settings" className="icon-btn header-settings" aria-label="Settings" title="Settings"><SettingsIcon size={20} /></NavLink>
        </div>
      </header>

      {searchOpen && (
        <div className="search-overlay" onKeyDown={(e) => { if (e.key === "Escape") setSearchOpen(false); }}>
          <SearchBox className="search-overlay-form" value={q} onChange={setQ} onSubmit={onSearch} inputRef={overlayInput} />
        </div>
      )}

      {!onWatch && (
        <nav className="tabbar" aria-label="Primary">
          <NavLink to="/" end className="tab-item"><Home size={24} /><span>Home</span></NavLink>
          <NavLink to="/movies" className={() => `tab-item${BROWSE.some((b) => pathname.startsWith(b)) ? " active" : ""}`}
            aria-current={BROWSE.some((b) => pathname.startsWith(b)) ? "page" : undefined}><Clapperboard size={24} /><span>Browse</span></NavLink>
          <NavLink to="/search" className="tab-item"><Search size={24} /><span>Search</span></NavLink>
          <NavLink to="/watchlist" className="tab-item"><Bookmark size={24} /><span>My List</span></NavLink>
          <NavLink to="/settings" className="tab-item"><SettingsIcon size={24} /><span>Settings</span></NavLink>
        </nav>
      )}
    </>
  );
}

export { SECTIONS };
