"use client";

import { useEffect, useState } from "react";

// Responsive breakpoint hook. Returns false on the first render
// (mobile-first) so server/client markup stay in sync, then tracks
// the live matchMedia state on the client.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const apply = () => setMatches(mql.matches);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, [query]);

  return matches;
}
