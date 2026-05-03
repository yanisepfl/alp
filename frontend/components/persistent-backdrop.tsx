"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";

// Backdrop at the panel rect on the landing page. Rendered in
// layout.tsx so it persists across / ↔ /app navigation. On /app it's
// hidden — the bento panels render their own surface. Positioning
// keys off the shared --panel-* CSS variables in globals.css.

export function PersistentBackdrop() {
  const pathname = usePathname();
  if (pathname === "/app") return null;

  return (
    <div
      aria-hidden
      style={{
        position: "fixed",
        left: "var(--panel-left)",
        top: "var(--panel-top)",
        width: "var(--panel-w)",
        height: "var(--panel-h)",
        borderRadius: "calc(20px * var(--shell-scale))",
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
          filter: "saturate(0.85) brightness(0.7)",
        }}
      />
    </div>
  );
}
