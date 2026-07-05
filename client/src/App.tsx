import { lazy, Suspense } from "react";
import { Routes, Route, useLocation } from "react-router-dom";
import Header from "./components/Header";
import ErrorBoundary from "./components/ErrorBoundary";

// Route-level code splitting: each page (and its heavy deps — the Watch page pulls
// in shaka-player + hls.js) loads on demand, shrinking the initial bundle.
const Home = lazy(() => import("./pages/Home"));
const Search = lazy(() => import("./pages/Search"));
const Title = lazy(() => import("./pages/Title"));
const Browse = lazy(() => import("./pages/Browse"));
const Watch = lazy(() => import("./pages/Watch"));
const Providers = lazy(() => import("./pages/Providers"));
const Watchlist = lazy(() => import("./pages/Watchlist"));
const Settings = lazy(() => import("./pages/Settings"));

const RouteFallback = () => <div className="container"><div className="empty">Loading…</div></div>;

export default function App() {
  const location = useLocation();
  return (
    <>
      <Header />
      <main>
        <ErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/search" element={<Search />} />
          <Route path="/title/:type/:id" element={<Title />} />
          <Route path="/movies" element={<Browse section="movies" />} />
          <Route path="/series" element={<Browse section="series" />} />
          <Route path="/anime" element={<Browse section="anime" />} />
          <Route path="/asian" element={<Browse section="asian" />} />
          <Route path="/watch/:type/:id" element={<Watch />} />
          <Route path="/watch/:type/:id/:season/:episode" element={<Watch />} />
          <Route path="/providers" element={<Providers />} />
          <Route path="/watchlist" element={<Watchlist />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
        </Suspense>
        </ErrorBoundary>
      </main>
    </>
  );
}
