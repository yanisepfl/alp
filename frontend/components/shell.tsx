"use client";

import { useEffect, useState } from "react";
import { Scenery } from "./scenery";
import { LandingFace } from "./landing-face";

// "Subwebsite" canvas. The whole design lives at a fixed 2300×1300, so
// every percentage position inside resolves against a stable pixel box —
// nothing inside is dynamic. Scaling only kicks in when the viewport
// drops below SCALE_REF — above that the canvas stays at native size and
// any overflow is clipped by the outer wrapper's overflow-hidden.
const REF_W = 2300;
const REF_H = 1300;
const SCALE_REF_W = 1800;
const SCALE_REF_H = (SCALE_REF_W * REF_H) / REF_W;

export function Shell() {
  const [learnMore, setLearnMore] = useState(false);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const compute = () => {
      setScale(
        Math.min(1, window.innerWidth / SCALE_REF_W, window.innerHeight / SCALE_REF_H),
      );
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  // Mark the entry choreography as seen on this browser. An inline script
  // in app/layout.tsx reads this flag on the next load (synchronously,
  // before React hydrates) and sets `data-intro-played` on <html>, which
  // globals.css uses to skip the lockup glide and word-by-word reveal.
  // Set on first mount — even a partial first view counts as "seen".
  // localStorage (not sessionStorage) so the flag survives new tabs and
  // browser restarts; clear it via DevTools to rewatch the intro.
  useEffect(() => {
    try {
      localStorage.setItem("alp:intro-played", "1");
    } catch {
      /* localStorage unavailable (privacy mode) — intro will replay, fine. */
    }
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-obsidian flex items-center justify-center">
      <main
        className="relative overflow-hidden bg-obsidian"
        style={{
          width: REF_W,
          height: REF_H,
          transform: `scale(${scale})`,
          transformOrigin: "center center",
          flexShrink: 0,
        }}
      >
        <Scenery muted={learnMore} />
        <LandingFace learnMore={learnMore} onToggleLearnMore={() => setLearnMore((v) => !v)} />
      </main>
    </div>
  );
}
