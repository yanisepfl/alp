import { Scenery } from "./scenery";
import { LandingFace } from "./landing-face";
import { MagneticCursor } from "./magnetic-cursor";

export function Shell() {
  return (
    <main className="relative h-dvh min-h-screen w-full overflow-hidden bg-obsidian">
      <Scenery />
      <LandingFace />
      {/* Global grain overlay — 1:1 with Alphix marketing landing */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-[100]"
        style={{
          background: "url(/noise.png)",
          opacity: 0.012,
        }}
      />
      <MagneticCursor />
    </main>
  );
}
