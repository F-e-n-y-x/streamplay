/** Minutes → "2 h 28 min" / "2 h" / "49 min" ("" when unknown). The one runtime format. */
export const formatRuntime = (min?: number | null): string => {
  if (!min || min <= 0) return "";
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
};
