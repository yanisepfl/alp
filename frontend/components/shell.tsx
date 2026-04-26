"use client";

import { useState } from "react";
import { Scenery } from "./scenery";
import { LandingFace } from "./landing-face";

export function Shell() {
  const [learnMore, setLearnMore] = useState(false);

  return (
    <main className="relative h-dvh min-h-screen w-full overflow-hidden bg-obsidian">
      <Scenery muted={learnMore} />
      <LandingFace learnMore={learnMore} onToggleLearnMore={() => setLearnMore((v) => !v)} />
    </main>
  );
}
