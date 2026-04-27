"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

// Same canvas math as landing's Shell + Scenery so the backdrop sits at
// the exact viewport rect of the LMC's panel. Rendered in layout.tsx so
// it persists across / ↔ /app route changes (no bg reload).
const REF_W = 2300;
const REF_H = 1300;
const SCALE_REF_W = 1800;
const SCALE_REF_H = (SCALE_REF_W * REF_H) / REF_W;
const PANEL_INSET = 0.20;

const FILTER = "saturate(0.85) brightness(0.7)";

type Layout = { left: number; top: number; width: number; height: number; scale: number };

export function PersistentBackdrop() {
  const pathname = usePathname();
  const [layout, setLayout] = useState<Layout | null>(null);

  useEffect(() => {
    const compute = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const scale = Math.min(1, vw / SCALE_REF_W, vh / SCALE_REF_H);
      const canvasW = REF_W * scale;
      const canvasH = REF_H * scale;
      const canvasLeft = (vw - canvasW) / 2;
      const canvasTop = (vh - canvasH) / 2;
      setLayout({
        left: canvasLeft + canvasW * PANEL_INSET,
        top: canvasTop + canvasH * PANEL_INSET,
        width: canvasW * (1 - 2 * PANEL_INSET),
        height: canvasH * (1 - 2 * PANEL_INSET),
        scale,
      });
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  if (!layout) return null;
  // On /app the page scrolls; hide so the gap between the main and
  // activity panels falls back to the obsidian body bg.
  if (pathname === "/app") return null;

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        left: layout.left,
        top: layout.top,
        width: layout.width,
        height: layout.height,
        borderRadius: 20 * layout.scale,
        overflow: "hidden",
        zIndex: 0,
        pointerEvents: "none",
      }}
    >
      <Image
        src="/landscape.png"
        alt=""
        fill
        priority
        sizes="100vw"
        style={{
          objectFit: "cover",
          filter: FILTER,
        }}
      />
    </div>
  );
}
