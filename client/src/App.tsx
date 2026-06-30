import { Routes, Route } from "react-router-dom";
import Header from "./components/Header";
import Home from "./pages/Home";
import Search from "./pages/Search";
import Title from "./pages/Title";
import Browse from "./pages/Browse";
import Watch from "./pages/Watch";
import Providers from "./pages/Providers";
import Watchlist from "./pages/Watchlist";

export default function App() {
  return (
    <>
      <Header />
      <main>
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
        </Routes>
      </main>
    </>
  );
}
