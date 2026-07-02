"use client";

import { useEffect, useState } from "react";

// Viewport width below which we treat the layout as "mobile" — matches the
// Tailwind `md` breakpoint the app uses to swap the desktop sidebar for the
// mobile Sheet drawer. Components read this to make JS-only positioning choices
// that Tailwind classes can't express (e.g. a Radix popover `side`).
const MOBILE_BREAKPOINT = 768;

export function useIsMobile(): boolean {
  // Start false so SSR / first paint matches the desktop default; the effect
  // corrects it after mount. The tunnel popover isn't open on first render, so
  // there's no visible flip.
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  return isMobile;
}
