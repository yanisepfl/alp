// Lightweight toast surface. Style matches the page's card
// vocabulary: same dark `#0c0c10` surface, same `rgba(255,255,255,
// 0.08)` border, same `var(--sans-stack)` typography, same
// 12px radius. Status is signalled by a small colored dot on the
// left rather than a heavy left-border, so the toast reads as a
// quiet sibling of the bento cards instead of a foreign component.
//
// Usage:
//   import { toast, ToastViewport } from "@/lib/toast";
//   toast("error",   "Transaction failed");
//   toast("success", "Deposit confirmed");
//   <ToastViewport />   // mount once at the app root
//
// Module-level subscriber pattern (same shape as
// onApiAuthInvalid in lib/api/hooks.ts) so any handler can fire
// a toast without prop-drilling.

"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export type ToastKind = "success" | "error" | "info";

export type Toast = {
  id: string;
  kind: ToastKind;
  text: string;
};

const _listeners = new Set<(t: Toast) => void>();
let _counter = 0;

export function toast(kind: ToastKind, text: string): void {
  const t: Toast = { id: `t_${++_counter}`, kind, text };
  for (const fn of _listeners) fn(t);
}

// Status-dot accents reuse the colour vocabulary already in the
// app: KvRow uses 134/239/172 for positive PnL and 248/113/113 for
// negative; toasts inherit the same so success/error feel native.
const ACCENT: Record<ToastKind, string> = {
  success: "rgb(134, 239, 172)",
  error:   "rgb(248, 113, 113)",
  info:    "rgba(255, 255, 255, 0.55)",
};

const TTL_MS = 4000;

export function ToastViewport(): React.JSX.Element | null {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const onToast = (t: Toast) => {
      setToasts((prev) => [...prev, t]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, TTL_MS);
    };
    _listeners.add(onToast);
    return () => { _listeners.delete(onToast); };
  }, []);

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div
      aria-live="polite"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          style={{
            pointerEvents: "auto",
            minWidth: 240,
            maxWidth: 360,
            padding: "11px 14px",
            borderRadius: 12,
            background: "#0c0c10",
            border: "1px solid rgba(255,255,255,0.08)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontFamily: "var(--sans-stack)",
            fontSize: 12.5,
            fontWeight: 500,
            lineHeight: 1.35,
            letterSpacing: "-0.005em",
            color: "rgba(255,255,255,0.92)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.45)",
            animation: "toast-in 180ms ease-out",
          }}
        >
          <span
            aria-hidden
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: ACCENT[t.kind],
              flexShrink: 0,
              // Sans glyphs sit slightly below the line-box centre,
              // so a visually-centred row needs the dot nudged down
              // by 1px against the text's optical midpoint.
              transform: "translateY(1px)",
            }}
          />
          <span>{t.text}</span>
        </div>
      ))}
      <style>{`
        @keyframes toast-in {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>,
    document.body,
  );
}
