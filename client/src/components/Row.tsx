import { useRef } from "react";
import type { Card } from "../lib/types";
import PosterCard from "./PosterCard";
import { ChevronLeft, ChevronRight } from "./icons";

export default function Row({ title, items }: { title: string; items: Card[] }) {
  const track = useRef<HTMLDivElement>(null);
  if (!items.length) return null;

  const scroll = (dir: number) => track.current?.scrollBy({ left: dir * 600, behavior: "smooth" });

  return (
    <section className="section row">
      <div className="section-head">
        <h2>{title}</h2>
      </div>
      <button className="row-nav left" aria-label="Scroll left" onClick={() => scroll(-1)}><ChevronLeft /></button>
      <button className="row-nav right" aria-label="Scroll right" onClick={() => scroll(1)}><ChevronRight /></button>
      <div className="row-track" ref={track}>
        {items.map((c) => (
          <PosterCard key={`${c.type}-${c.id}`} card={c} />
        ))}
      </div>
    </section>
  );
}
