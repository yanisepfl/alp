"use client";

import { useEffect, useState } from "react";
import { Scenery } from "./scenery";
import { LandingFace } from "./landing-face";

// Landing canvas — fixed 2300×1300 design surface. The outer wrapper
// scales it via the `--shell-scale` CSS variable defined in
// globals.css, so every percentage / px position inside resolves
// against a stable pixel box. Above the scale-ref viewport the canvas
// renders at native size and any overflow is clipped by the parent's
// overflow-hidden; below it, it shrinks proportionally so nothing
// gets cut off.
const REF_W = 2300;
const REF_H = 1300;

export function Shell() {
  const [learnMore, setLearnMore] = useState(false);

  // Mark the entry choreography as seen on this browser. An inline
  // script in app/layout.tsx reads this flag on the next load (before
  // React hydrates) and injects a style that disables the lockup glide
  // and word-by-word reveal animations.
  useEffect(() => {
    try {
      localStorage.setItem("alps:intro-played", "1");
    } catch {
      /* localStorage unavailable; intro will replay. */
    }
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-obsidian flex items-center justify-center">
      <main
        className="relative overflow-hidden bg-obsidian"
        style={{
          width: REF_W,
          height: REF_H,
          transform: "scale(var(--shell-scale))",
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
