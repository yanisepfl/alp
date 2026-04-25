"use client";

import { useEffect, useRef } from "react";

const SIZE = 28;        // idle diameter
const PROX = 64;        // proximity (px) that triggers snap
const PAD = 14;         // padding around the magnet rect when snapped
const SNAP_RX = 18;     // fallback border-radius when snapped
const PULL = 0.1;       // how strongly the magnet element follows the cursor
const LERP_POS = 0.22;
const LERP_BOX = 0.2;
const LERP_OP = 0.18;
const LERP_PULL = 0.18;

type Box = { x: number; y: number; w: number; h: number; rx: number; opacity: number };

export function MagneticCursor() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(pointer: coarse)").matches) return;

    const el = ref.current!;
    const target: Box = { x: -200, y: -200, w: SIZE, h: SIZE, rx: SIZE / 2, opacity: 0 };
    const cur: Box = { ...target };

    // Magnet pull state — for translating the snapped element toward the cursor
    let magnetEl: HTMLElement | null = null;
    const magnetCenter = { x: 0, y: 0 }; // captured at snap time, before transform
    const pullTarget = { x: 0, y: 0 };
    const pullCur = { x: 0, y: 0 };

    const releaseMagnet = () => {
      if (magnetEl) {
        magnetEl.style.transform = "";
        magnetEl.style.willChange = "";
      }
      magnetEl = null;
      pullTarget.x = 0;
      pullTarget.y = 0;
      pullCur.x = 0;
      pullCur.y = 0;
    };

    const findMagnet = (x: number, y: number): HTMLElement | null => {
      const els = document.querySelectorAll<HTMLElement>("[data-magnet]");
      for (const m of els) {
        const r = m.getBoundingClientRect();
        const cx = Math.max(r.left, Math.min(x, r.right));
        const cy = Math.max(r.top, Math.min(y, r.bottom));
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy < PROX * PROX) return m;
      }
      return null;
    };

    const onMove = (e: MouseEvent) => {
      const m = findMagnet(e.clientX, e.clientY);

      if (m !== magnetEl) {
        // Snap state changed — release old, capture new natural center
        releaseMagnet();
        if (m) {
          magnetEl = m;
          const r = m.getBoundingClientRect();
          magnetCenter.x = r.left + r.width / 2;
          magnetCenter.y = r.top + r.height / 2;
          m.style.willChange = "transform";
        }
      }

      if (m) {
        const r = m.getBoundingClientRect();
        const cs = getComputedStyle(m);
        const baseRx = parseFloat(cs.borderRadius) || SNAP_RX;
        target.x = r.left + r.width / 2;
        target.y = r.top + r.height / 2;
        target.w = r.width + PAD * 2;
        target.h = r.height + PAD * 2;
        target.rx = baseRx + PAD;
        // Pull the element toward the cursor
        pullTarget.x = (e.clientX - magnetCenter.x) * PULL;
        pullTarget.y = (e.clientY - magnetCenter.y) * PULL;
      } else {
        target.x = e.clientX;
        target.y = e.clientY;
        target.w = SIZE;
        target.h = SIZE;
        target.rx = SIZE / 2;
      }
      target.opacity = 1;
    };

    const onLeave = () => {
      target.opacity = 0;
      releaseMagnet();
    };
    const onEnter = () => {
      target.opacity = 1;
    };

    let raf = 0;
    const tick = () => {
      cur.x += (target.x - cur.x) * LERP_POS;
      cur.y += (target.y - cur.y) * LERP_POS;
      cur.w += (target.w - cur.w) * LERP_BOX;
      cur.h += (target.h - cur.h) * LERP_BOX;
      cur.rx += (target.rx - cur.rx) * LERP_BOX;
      cur.opacity += (target.opacity - cur.opacity) * LERP_OP;
      el.style.transform = `translate3d(${cur.x - cur.w / 2}px, ${cur.y - cur.h / 2}px, 0)`;
      el.style.width = `${cur.w}px`;
      el.style.height = `${cur.h}px`;
      el.style.borderRadius = `${cur.rx}px`;
      el.style.opacity = `${cur.opacity}`;

      if (magnetEl) {
        pullCur.x += (pullTarget.x - pullCur.x) * LERP_PULL;
        pullCur.y += (pullTarget.y - pullCur.y) * LERP_PULL;
        magnetEl.style.transform = `translate3d(${pullCur.x}px, ${pullCur.y}px, 0)`;
      }

      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("mousemove", onMove);
    document.documentElement.addEventListener("mouseleave", onLeave);
    document.documentElement.addEventListener("mouseenter", onEnter);
    raf = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("mousemove", onMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      document.documentElement.removeEventListener("mouseenter", onEnter);
      cancelAnimationFrame(raf);
      releaseMagnet();
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed left-0 top-0 z-[200]"
      style={{
        width: SIZE,
        height: SIZE,
        borderRadius: "50%",
        backgroundColor: "rgba(255, 255, 255, 0.18)",
        opacity: 0,
        willChange: "transform, width, height, border-radius, opacity",
      }}
    />
  );
}
