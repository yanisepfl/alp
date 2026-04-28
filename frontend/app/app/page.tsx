"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  clientId,
  subscribeAgentStream,
  type ActionCategory,
  type StreamHandle,
  type WireMessage,
  type WireSource,
} from "@/lib/agent-stream";
import { LearnMoreContent, SummaryText } from "@/components/landing-face";

/* ---------- Panel rect ---------- */

// The main panel is the same centered, scaled rectangle that the
// landing page renders — design size 1380×780, scaled to viewport
// by the `--shell-scale` CSS var in globals.css. The /app canvas
// matches the panel exactly: every chrome element (nav above,
// footer below, bento inside) positions against (0, 0, PANEL_W,
// PANEL_H) and rides the same outer transform.
//
// A single right-side sidebar (Sherpa agent OR vault stats, toggled
// by the tab pill above it) lives in raw viewport space — no
// transform. It stretches from the panel's right edge plus a gap to
// the viewport's right edge minus a margin, so on wider screens the
// sidebar gets more room. CSS clamps width at 0 on narrow viewports
// (negative calc result), letting the sidebar collapse without a JS
// breakpoint.
const PANEL_W = 1380;
const PANEL_H = 780;

// Floating nav design height — measured from the FloatingNav pill
// (8 + max(button=29, logo=22) + 8 inner padding + 1+1 border).
// Pulled out as a constant because the sidebar tab pill scales its
// height to this value via --shell-scale, so the two chrome strips
// share a baseline + height at every viewport.
const NAV_DESIGN_HEIGHT = 47;

type PanelLayout = { left: number; top: number; width: number; height: number; scale: number };
type SidebarTab = "agent" | "stats";

// Singleton: the main panel fills the canvas exactly. Passed to
// FloatingNav / FooterStrip so they can position relative to it.
const MAIN_PANEL: PanelLayout = { left: 0, top: 0, width: PANEL_W, height: PANEL_H, scale: 1 };

// Landscape filter — colour-preserving, just slightly desaturated and dimmed.
// Used on the main panel + nav pill so the colour reads through.
const LANDSCAPE_FILTER = "saturate(0.85) brightness(0.7)";

// LMC-style muted filter — exact match to landing's Scenery muted state
// (when learnMore = true). Applied to the agent chat sidebar so it
// reads as a recessed, greyscaled surface vs the colourful main panel.
const LANDSCAPE_FILTER_MUTED = "grayscale(0.85) saturate(0.35) contrast(0.85) brightness(0.55)";

/* ---------- Constants & sample data ---------- */

const SHARE_PRICE = 1.0427;

// Demo wallet position. Real backend: read from `/me/position` once a
// wallet is connected. Stable-token deposit so HODL value == principal,
// which makes outperformance the same as raw P&L.
const USER_DEPOSIT_TS = "2026-02-27T10:14:00";
const USER_DEPOSIT_AMT = 5000;
const USER_DEPOSIT_TX = "0x82a3…4d91";
const USER_ENTRY_SHARE_PRICE = 1.0184;
const USER_DAYS_HELD = 60;
const USER_SHARES = USER_DEPOSIT_AMT / USER_ENTRY_SHARE_PRICE;
const USER_VALUE = USER_SHARES * SHARE_PRICE;
const USER_PNL = USER_VALUE - USER_DEPOSIT_AMT;
const USER_PNL_PCT = (USER_PNL / USER_DEPOSIT_AMT) * 100;
const USER_REALIZED_APY = ((USER_VALUE / USER_DEPOSIT_AMT) ** (365 / USER_DAYS_HELD) - 1) * 100;

const SHARE_PRICE_30D = [
  1.0000, 0.9994, 1.0008, 1.0021, 1.0014, 1.0035, 1.0028, 1.0049, 1.0061, 1.0078,
  1.0090, 1.0089, 1.0103, 1.0118, 1.0127, 1.0145, 1.0162, 1.0179, 1.0184, 1.0202,
  1.0218, 1.0228, 1.0218, 1.0234, 1.0252, 1.0268, 1.0290, 1.0312, 1.0349, 1.0427,
];

const TVL_30D = [
  3.05, 3.07, 3.08, 3.06, 3.09, 3.11, 3.13, 3.12, 3.15, 3.16,
  3.18, 3.19, 3.17, 3.20, 3.22, 3.21, 3.24, 3.23, 3.25, 3.27,
  3.25, 3.26, 3.27, 3.28, 3.26, 3.27, 3.29, 3.28, 3.27, 3.26,
];

const APR_30D = [
  11.2, 11.5, 11.8, 12.1, 11.9, 12.3, 12.8, 12.6, 13.0, 13.2,
  13.5, 13.3, 13.4, 13.7, 13.9, 14.2, 14.0, 13.8, 13.6, 13.9,
  14.1, 14.3, 14.0, 13.8, 14.0, 14.2, 14.4, 14.1, 14.0, 14.2,
];

const MASK_STYLE = {
  backgroundColor: "#fff",
  WebkitMaskImage: "url(/logo.png)",
  maskImage: "url(/logo.png)",
  WebkitMaskSize: "contain",
  maskSize: "contain",
  WebkitMaskRepeat: "no-repeat",
  maskRepeat: "no-repeat",
  WebkitMaskPosition: "center",
  maskPosition: "center",
} as const;

type TokenEntry = { slug: string; kind: "svg" | "png"; src: string; color: string };
const TOKENS: Record<string, TokenEntry> = {
  USDC: { slug: "USDC", kind: "png", src: "/tokens/usdc.png",     color: "#2775CA" },
  ETH:  { slug: "ETH",  kind: "svg", src: "/tokens/svg/eth.svg",  color: "#627EEA" },
  BTC:  { slug: "BTC",  kind: "svg", src: "/tokens/svg/btc.svg",  color: "#F7931A" },
  USDT: { slug: "USDT", kind: "svg", src: "/tokens/svg/usdt.svg", color: "#26A17B" },
  UNI:  { slug: "UNI",  kind: "png", src: "/tokens/svg/uni.svg",  color: "#FF007A" },
};

const ICONS: Record<string, React.ReactNode> = {
  position:   (<><circle cx="12" cy="12" r="3" /><path d="M3 12h6M15 12h6" /></>),
  vault:      (<><path d="M5 9h14v9H5z" /><path d="M9 9V6a3 3 0 0 1 6 0v3" /></>),
  allocation: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="8" cy="7" r="0.8" fill="currentColor" />
      <circle cx="14" cy="12" r="0.8" fill="currentColor" />
      <circle cx="10" cy="17" r="0.8" fill="currentColor" />
    </>
  ),
  agent:      (<><circle cx="12" cy="12" r="8.5" /><polyline points="12 7 12 12 15.5 14" /></>),
  arrow:      (<path d="M5 12h14M12 5l7 7-7 7" />),
  external:   (<><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M19 13v6H5V5h6" /></>),
  pools:      (<><path d="M4 7h16M4 12h16M4 17h16" /></>),
  fees:       (<><circle cx="12" cy="12" r="9" /><path d="M14.5 9.5h-3a1.5 1.5 0 0 0 0 3h2a1.5 1.5 0 0 1 0 3h-3M12 7.5v9" /></>),
  clock:      (<><circle cx="12" cy="12" r="8.5" /><polyline points="12 7 12 12 15.5 14" /></>),
  flow:       (<><path d="M4 7h12M16 3l4 4-4 4" /><path d="M20 17H8M8 13l-4 4 4 4" /></>),
  range:      (<><path d="M3 8h18M3 16h18" /><path d="M7 12h10" /></>),
};

// Copy + check icons — user-supplied artwork on a 20×20 viewBox. Both
// stroke-only so they swap cleanly on `copied`. `currentColor` lets
// the surrounding button drive the fill.
function CopyIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden style={{ display: "inline-block", flexShrink: 0 }}>
      <path d="m13,7h2c1.105,0,2,.895,2,2v6c0,1.105-.895,2-2,2h-6c-1.105,0-2-.895-2-2v-2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
      <rect x="3" y="3" width="10" height="10" rx="2" ry="2" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function CheckIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden style={{ display: "inline-block", flexShrink: 0 }}>
      <polyline points="6.5 10.5 8.75 13 13.5 7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

// "New context" icon — user-supplied artwork for the signal card.
// Document-with-lines mark; opacity-0.4 body + solid corner fold and
// solid lines so it reads at small sizes against a dark grey panel.
function NewContextIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden style={{ display: "inline-block", flexShrink: 0 }}>
      <path d="M15.487 5.427L11.572 1.512C11.2442 1.1841 10.7996 1 10.336 1H4.75C3.2312 1 2 2.2312 2 3.75V14.25C2 15.7688 3.2312 17 4.75 17H13.25C14.7688 17 16 15.7688 16 14.25V6.6655C16 6.2009 15.8155 5.7553 15.487 5.427Z" fill="currentColor" fillOpacity="0.4" />
      <path d="M15.8691 6.00098H12C11.45 6.00098 11 5.55098 11 5.00098V1.13101C11.212 1.21806 11.4068 1.34677 11.572 1.512L15.487 5.427C15.6527 5.59266 15.7818 5.7882 15.8691 6.00098Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M5 6.75C5 6.33579 5.33579 6 5.75 6H7.75C8.16421 6 8.5 6.33579 8.5 6.75C8.5 7.16421 8.16421 7.5 7.75 7.5H5.75C5.33579 7.5 5 7.16421 5 6.75Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M5 9.75C5 9.33579 5.33579 9 5.75 9H12.25C12.6642 9 13 9.33579 13 9.75C13 10.1642 12.6642 10.5 12.25 10.5H5.75C5.33579 10.5 5 10.1642 5 9.75Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M5 12.75C5 12.3358 5.33579 12 5.75 12H12.25C12.6642 12 13 12.3358 13 12.75C13 13.1642 12.6642 13.5 12.25 13.5H5.75C5.33579 13.5 5 13.1642 5 12.75Z" fill="currentColor" />
    </svg>
  );
}

// Source icons — three rendered styles for the three source kinds.
// `vault` uses the alps logo (mask), `uniswap` is the unicorn glyph,
// `basescan` is the stylized B. All grayscale to match the chat. The
// `vault` kind reuses MASK_STYLE so it tracks logo.png changes.
type SourceKind = "vault" | "uniswap" | "basescan";

function SourceIcon({ kind, size = 12 }: { kind: SourceKind; size?: number }) {
  if (kind === "vault") {
    return (
      <span aria-hidden style={{ display: "inline-block", width: size, height: size, flexShrink: 0, ...MASK_STYLE, backgroundColor: "rgba(255,255,255,0.65)" }} />
    );
  }
  if (kind === "uniswap") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden style={{ display: "inline-block", flexShrink: 0 }}>
        <path d="M5.6 14.7c-.3-.7-.4-1.6-.2-2.5.2-.9.7-1.7 1.4-2.3.7-.6 1.6-1 2.5-1.1.6-.1 1.1 0 1.6.2.5.2.9.6 1.2 1.1.3.5.4 1.1.3 1.7-.1.6-.4 1.2-.9 1.6-.5.4-1.1.6-1.7.5-.6 0-1.1-.3-1.4-.7l.5-.4c.3.3.6.5 1 .5.4 0 .8-.1 1.1-.3.3-.2.5-.5.5-.9 0-.4-.1-.7-.4-1-.3-.3-.7-.4-1.1-.4-.6 0-1.2.2-1.7.6-.5.4-.8 1-1 1.6-.1.6-.1 1.3.1 1.9.2.6.6 1.1 1.1 1.5.5.4 1.1.6 1.8.6.8 0 1.6-.3 2.2-.8.6-.5 1-1.2 1.2-2 .2-.8.1-1.6-.1-2.4-.3-.8-.7-1.4-1.4-1.9-.6-.5-1.4-.8-2.2-.9-.9-.1-1.8 0-2.6.4-.8.4-1.5 1-2 1.7-.5.7-.8 1.6-.8 2.5 0 .9.2 1.7.6 2.5.4.7 1 1.4 1.7 1.8.7.4 1.5.7 2.4.7" stroke="currentColor" strokeWidth="0.6" fill="currentColor" opacity="0.85" />
        <circle cx="9.7" cy="11.6" r="0.6" fill="currentColor" />
      </svg>
    );
  }
  // basescan — minimal B/explorer mark
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden style={{ display: "inline-block", flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9.5" stroke="currentColor" strokeWidth="1.4" opacity="0.6" />
      <path d="M9 7.5h3.6c1.4 0 2.4.8 2.4 2.1 0 .9-.5 1.6-1.2 1.9.9.2 1.5 1 1.5 2 0 1.4-1.1 2.5-2.7 2.5H9V7.5Zm1.4 1.2v2.1h2c.7 0 1.2-.4 1.2-1.1 0-.6-.5-1-1.2-1h-2Zm0 3.2v2.4h2.2c.8 0 1.4-.5 1.4-1.2 0-.7-.6-1.2-1.4-1.2h-2.2Z" fill="currentColor" opacity="0.85" />
    </svg>
  );
}

function StrokeIcon({ kind, size = 11 }: { kind: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: "inline-block", flexShrink: 0 }}>
      {ICONS[kind]}
    </svg>
  );
}

// Filled-icon set used by `CardLabel` pills. Each path uses
// currentColor (inherited from the SVG `fill="currentColor"` wrapper
// in `<FilledIcon>`); `fillOpacity` introduces the soft tint passes.
const FILLED_ICONS: Record<string, React.ReactNode> = {
  // Deposit — filled card with a deposit-arrow / lines and chip dots.
  vault: (
    <>
      <path d="M4.75 2C3.23079 2 2 3.23079 2 4.75V13.25C2 14.7692 3.23079 16 4.75 16H13.25C14.7692 16 16 14.7692 16 13.25V4.75C16 3.23079 14.7692 2 13.25 2H4.75Z" fillOpacity="0.4" />
      <path fillRule="evenodd" clipRule="evenodd" d="M1 9C1 8.58579 1.33579 8.25 1.75 8.25H2.75C3.16421 8.25 3.5 8.58579 3.5 9C3.5 9.41421 3.16421 9.75 2.75 9.75H1.75C1.33579 9.75 1 9.41421 1 9Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M1 5.75C1 5.33579 1.33579 5 1.75 5H2.75C3.16421 5 3.5 5.33579 3.5 5.75C3.5 6.16421 3.16421 6.5 2.75 6.5H1.75C1.33579 6.5 1 6.16421 1 5.75Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M1 12.25C1 11.8358 1.33579 11.5 1.75 11.5H2.75C3.16421 11.5 3.5 11.8358 3.5 12.25C3.5 12.6642 3.16421 13 2.75 13H1.75C1.33579 13 1 12.6642 1 12.25Z" />
      <path d="M9.73278 9.83948C10.3331 9.56204 10.75 8.95441 10.75 8.25C10.75 7.284 9.966 6.5 9 6.5C8.034 6.5 7.25 7.284 7.25 8.25C7.25 8.95441 7.66688 9.56204 8.26722 9.83948C8.25594 9.89119 8.25 9.9449 8.25 10V11.75C8.25 12.1642 8.58579 12.5 9 12.5C9.41421 12.5 9.75 12.1642 9.75 11.75V10C9.75 9.9449 9.74406 9.89119 9.73278 9.83948Z" />
      <path d="M4 15.8965C4.2384 15.9639 4.48998 16 4.75 16H5.5V16.75C5.5 17.1642 5.16421 17.5 4.75 17.5C4.33579 17.5 4 17.1642 4 16.75V15.8965Z" />
      <path d="M12.5 16H13.25C13.51 16 13.7616 15.9639 14 15.8965V16.75C14 17.1642 13.6642 17.5 13.25 17.5C12.8358 17.5 12.5 17.1642 12.5 16.75V16Z" />
    </>
  ),
  // Position — three dim circles + a bright "add" circle (the user
  // adding a position to the basket).
  position: (
    <>
      <path d="M15.5001 12H13.7501V10.25C13.7501 9.8359 13.4142 9.5 13.0001 9.5C12.586 9.5 12.2501 9.8359 12.2501 10.25V12H10.5001C10.086 12 9.75012 12.3359 9.75012 12.75C9.75012 13.1641 10.086 13.5 10.5001 13.5H12.2501V15.25C12.2501 15.6641 12.586 16 13.0001 16C13.4142 16 13.7501 15.6641 13.7501 15.25V13.5H15.5001C15.9142 13.5 16.2501 13.1641 16.2501 12.75C16.2501 12.3359 15.9142 12 15.5001 12Z" />
      <path d="M5.00011 8.25C6.79503 8.25 8.25011 6.79493 8.25011 5C8.25011 3.20507 6.79503 1.75 5.00011 1.75C3.20518 1.75 1.75012 3.20507 1.75012 5C1.75012 6.79493 3.20518 8.25 5.00011 8.25Z" fillOpacity="0.4" />
      <path d="M13.0001 8.25C14.795 8.25 16.2501 6.79493 16.2501 5C16.2501 3.20507 14.795 1.75 13.0001 1.75C11.2052 1.75 9.75012 3.20507 9.75012 5C9.75012 6.79493 11.2052 8.25 13.0001 8.25Z" fillOpacity="0.4" />
      <path d="M5.00011 16.25C6.79503 16.25 8.25011 14.7949 8.25011 13C8.25011 11.2051 6.79503 9.75 5.00011 9.75C3.20518 9.75 1.75012 11.2051 1.75012 13C1.75012 14.7949 3.20518 16.25 5.00011 16.25Z" fillOpacity="0.4" />
    </>
  ),
  strategy: (
    <>
      <path opacity="0.4" d="M14.2501 8H3.75012C1.68212 8 0.00012207 9.682 0.00012207 11.75C0.00012207 13.818 1.68212 15.5 3.75012 15.5H14.2501C16.3181 15.5 18.0001 13.818 18.0001 11.75C18.0001 9.682 16.3181 8 14.2501 8Z" />
      <path d="M9.00011 6C8.58711 6 8.20211 5.79901 7.97111 5.46301L6.2141 2.909C5.9561 2.534 5.9291 2.05102 6.1451 1.65002C6.3611 1.24902 6.7821 0.999023 7.2441 0.999023H10.7561C11.2171 0.999023 11.6381 1.24802 11.8551 1.65002C12.0721 2.05202 12.0441 2.534 11.7861 2.909L10.0301 5.46198C9.79911 5.79798 9.4141 5.99902 9.0011 5.99902L9.00011 6Z" />
      <path d="M9.00012 12.5H3.75012C3.33612 12.5 3.00012 12.164 3.00012 11.75C3.00012 11.336 3.33612 11 3.75012 11H9.00012C9.41412 11 9.75012 11.336 9.75012 11.75C9.75012 12.164 9.41412 12.5 9.00012 12.5Z" />
    </>
  ),
  // Performance — chart card: a dim card with a sparkline-style line
  // crossing it and two dot markers.
  sparkles: (
    <>
      <path d="M3.75 2C2.23079 2 1 3.23079 1 4.75V13.25C1 14.7692 2.23079 16 3.75 16H14.25C15.7692 16 17 14.7692 17 13.25V4.75C17 3.23079 15.7692 2 14.25 2H3.75Z" fillOpacity="0.4" />
      <path fillRule="evenodd" clipRule="evenodd" d="M13.5854 5.07916C13.9559 5.2644 14.1061 5.71491 13.9208 6.08539L11.6708 10.5854C11.5484 10.8302 11.3023 10.9889 11.0288 10.9994C10.7553 11.0099 10.4977 10.8706 10.3569 10.6359L9.5158 9.23403L8.15119 11.6221C8.02796 11.8377 7.80594 11.9784 7.5583 11.9977C7.31066 12.017 7.06953 11.9125 6.91436 11.7185L6.47425 11.1684L5.31444 12.4939C5.04168 12.8056 4.56786 12.8372 4.25613 12.5644C3.9444 12.2917 3.91282 11.8178 4.18558 11.5061L5.93558 9.5061C6.0818 9.33899 6.29455 9.24527 6.51654 9.25016C6.73854 9.25506 6.94695 9.35807 7.08566 9.53146L7.39631 9.91978L8.84883 7.37788C8.98095 7.14667 9.22576 7.00286 9.49203 7.00002C9.75831 6.99719 10.0061 7.13577 10.1431 7.36411L10.9402 8.69256L12.5792 5.41457C12.7644 5.04409 13.2149 4.89392 13.5854 5.07916Z" />
      <path d="M4.25 6C4.664 6 5 5.664 5 5.25C5 4.836 4.664 4.5 4.25 4.5C3.836 4.5 3.5 4.836 3.5 5.25C3.5 5.664 3.836 6 4.25 6Z" />
      <path d="M6.75 6C7.164 6 7.5 5.664 7.5 5.25C7.5 4.836 7.164 4.5 6.75 4.5C6.336 4.5 6 4.836 6 5.25C6 5.664 6.336 6 6.75 6Z" />
    </>
  ),
  // Activity — calendar card with dotted entries.
  stack: (
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M1.5 4.75C1.5 3.23069 2.73128 2 4.25 2H13.75C15.2687 2 16.5 3.23069 16.5 4.75V13.25C16.5 14.7693 15.2687 16 13.75 16H4.25C2.73128 16 1.5 14.7693 1.5 13.25V4.75Z" fillOpacity="0.4" />
      <path fillRule="evenodd" clipRule="evenodd" d="M6.5 0.75C6.5 0.335786 6.16421 0 5.75 0C5.33579 0 5 0.335786 5 0.75V2H4.25C2.73079 2 1.5 3.23079 1.5 4.75V6H16.5V4.75C16.5 3.23079 15.2692 2 13.75 2H13V0.75C13 0.335786 12.6642 0 12.25 0C11.8358 0 11.5 0.335786 11.5 0.75V2H6.5V0.75Z" />
      <path d="M9 8C8.449 8 8 8.449 8 9C8 9.551 8.449 10 9 10C9.551 10 10 9.551 10 9C10 8.449 9.551 8 9 8Z" />
      <path d="M12.5 10C13.051 10 13.5 9.551 13.5 9C13.5 8.449 13.051 8 12.5 8C11.949 8 11.5 8.449 11.5 9C11.5 9.551 11.949 10 12.5 10Z" />
      <path d="M9 11.5C8.449 11.5 8 11.949 8 12.5C8 13.051 8.449 13.5 9 13.5C9.551 13.5 10 13.051 10 12.5C10 11.949 9.551 11.5 9 11.5Z" />
      <path d="M5.5 11.5C4.949 11.5 4.5 11.949 4.5 12.5C4.5 13.051 4.949 13.5 5.5 13.5C6.051 13.5 6.5 13.051 6.5 12.5C6.5 11.949 6.051 11.5 5.5 11.5Z" />
      <path d="M12.5 11.5C11.949 11.5 11.5 11.949 11.5 12.5C11.5 13.051 11.949 13.5 12.5 13.5C13.051 13.5 13.5 13.051 13.5 12.5C13.5 11.949 13.051 11.5 12.5 11.5Z" />
    </>
  ),
};

function FilledIcon({ kind, size = 12 }: { kind: keyof typeof FILLED_ICONS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="currentColor" aria-hidden style={{ display: "inline-block", flexShrink: 0 }}>
      {FILLED_ICONS[kind]}
    </svg>
  );
}

// User-supplied wallet artwork — stays in sync with the connect-wallet
// nav button on the floating top nav.
function WalletIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden style={{ display: "inline-block", flexShrink: 0 }}>
      <path d="M13.5028 2.07856C13.1582 1.38927 12.4027 1.0061 11.6429 1.13564L5.08061 2.25569C3.01253 2.60925 1.5 4.40138 1.5 6.49997C1.5 6.5286 1.50164 6.55704 1.50485 6.58519C1.59004 5.14276 2.78612 4 4.25 4H13.75C13.9233 4 14.0929 4.01603 14.2574 4.04668C14.2357 3.98275 14.2141 3.91867 14.1925 3.85451C13.9882 3.24883 13.7815 2.63594 13.5028 2.07856Z" fill="currentColor" fillOpacity="0.2" />
      <path d="M4.25 4C2.73079 4 1.5 5.23079 1.5 6.75V13.25C1.5 14.7692 2.73079 16 4.25 16H13.75C15.2692 16 16.5 14.7692 16.5 13.25V6.75C16.5 5.23079 15.2692 4 13.75 4H4.25Z" fill="currentColor" fillOpacity="0.4" />
      <path d="M16 11.75H13C12.034 11.75 11.25 10.966 11.25 10C11.25 9.033 12.034 8.25 13 8.25H16C16.552 8.25 17 8.698 17 9.25V10.75C17 11.302 16.552 11.75 16 11.75Z" fill="currentColor" />
    </svg>
  );
}

function Moon() {
  return <span aria-hidden style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", width: "85%", height: "85%", borderRadius: "50%", background: "white", pointerEvents: "none" }} />;
}

function Silhouette({ src, color }: { src: string; color: string }) {
  return (
    <span aria-hidden style={{
      position: "absolute", left: "50%", top: "50%",
      transform: "translate(-50%, -50%)", width: "62%", height: "62%",
      backgroundColor: color,
      WebkitMaskImage: `url(${src})`, maskImage: `url(${src})`,
      WebkitMaskSize: "contain", maskSize: "contain",
      WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
      WebkitMaskPosition: "center", maskPosition: "center",
      pointerEvents: "none",
    }} />
  );
}

function TokenChip({ entry, size = 18, radius }: { entry: TokenEntry; size?: number; radius?: number }) {
  const r = radius ?? Math.max(3, Math.round(size * 0.26));
  const withMoon = entry.kind === "png" && entry.src.endsWith("/uni.svg");
  // Inner mask sized as a percentage (not rounded px) so the padding
  // ring stays symmetric at every chip size — at 14px or 16px the
  // rounded-px version produced uneven sub-pixel offsets that read
  // as "icon shifted up-right".
  return (
    <span aria-hidden style={{
      width: size, height: size, borderRadius: r, background: entry.color,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      overflow: "hidden", flexShrink: 0, position: "relative",
      lineHeight: 0, verticalAlign: "middle",
    }}>
      {withMoon ? (
        <>
          <Moon />
          <Silhouette src={entry.src} color={entry.color} />
        </>
      ) : entry.kind === "svg" ? (
        <span style={{
          width: "62%", height: "62%", backgroundColor: "#fff",
          WebkitMaskImage: `url(${entry.src})`, maskImage: `url(${entry.src})`,
          WebkitMaskSize: "contain", maskSize: "contain",
          WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat",
          WebkitMaskPosition: "center", maskPosition: "center",
          display: "block",
        }} />
      ) : (
        <Image src={entry.src} alt="" width={size} height={size} style={{ display: "block" }} />
      )}
    </span>
  );
}

function AlpChip({ size = 18 }: { size?: number }) {
  return (
    <span aria-hidden style={{
      width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.26)),
      background: "#2a2b32",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0, lineHeight: 0, verticalAlign: "middle",
    }}>
      {/* Percentage-sized inner so the mask padding stays exactly
          symmetric at any chip size — same fix as TokenChip. */}
      <span style={{
        display: "block", width: "65%", height: "65%",
        ...MASK_STYLE,
        backgroundColor: "rgba(255,255,255,0.85)",
      }} />
    </span>
  );
}

function PoolPairChip({ left, right, size = 18 }: { left: TokenEntry; right: TokenEntry; size?: number }) {
  const OFFSET = Math.round(size * 0.6);
  return (
    <span aria-hidden style={{ position: "relative", width: size + OFFSET, height: size, display: "inline-block", flexShrink: 0 }}>
      <span style={{ position: "absolute", left: 0, top: 0, display: "flex", zIndex: 1 }}>
        <TokenChip entry={left} size={size} radius={4} />
      </span>
      <span style={{ position: "absolute", left: OFFSET, top: 0, display: "flex", zIndex: 2 }}>
        <TokenChip entry={right} size={size} radius={4} />
      </span>
    </span>
  );
}

function Card({ children, style, className }: { children: React.ReactNode; style?: React.CSSProperties; className?: string }) {
  // Mirrors landing-face's Card 1:1 — no backdrop blur, so segments
  // sit on a flat rgba surface like the How-it-works bento.
  return (
    <div className={className} style={{
      background: "rgba(255,255,255,0.04)",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 20,
      padding: "16px 20px 18px",
      ...style,
    }}>
      {children}
    </div>
  );
}

function CardLabel({ icon, children }: { icon: keyof typeof ICONS | keyof typeof FILLED_ICONS | string; children: React.ReactNode }) {
  const isFilled = icon in FILLED_ICONS;
  return (
    <span style={{
      display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 5,
      padding: "0 8px 0 6px", height: 20, borderRadius: 6,
      background: "rgba(255,255,255,0.08)",
      color: "rgba(255,255,255,0.92)",
      fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500,
      letterSpacing: "0.02em", lineHeight: 1, width: "max-content",
    }}>
      {isFilled ? <FilledIcon kind={icon} size={12} /> : <StrokeIcon kind={icon} size={11} />}
      {/* Inter at this size has its x-height-center below its
          line-box-center, so flex-center-aligned text reads as a
          touch low. A 1px upward nudge lines the visual mid-mark of
          the lowercase letters with the icon's pixel center. */}
      <span style={{ display: "inline-block", transform: "translateY(-1px)" }}>{children}</span>
    </span>
  );
}

function InlinePill({ icon, iconImage, children }: { icon?: keyof typeof ICONS | string; iconImage?: { src: string; alt: string }; children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      padding: "2px 8px 2px 6px", borderRadius: 999,
      background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.09)",
      verticalAlign: "-0.12em", margin: "0 0.12em",
      color: "#fff", fontFamily: "var(--font-radley)", fontSize: 13, fontWeight: 400, lineHeight: 1, whiteSpace: "nowrap",
    }}>
      {iconImage && (
        <span style={{ width: 14, height: 14, display: "inline-flex", flexShrink: 0 }}>
          <Image src={iconImage.src} alt={iconImage.alt} width={14} height={14} style={{ borderRadius: 999, display: "block" }} />
        </span>
      )}
      {icon && <StrokeIcon kind={icon} size={12} />}
      {children}
    </span>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{ color: "#fff", fontFamily: "var(--font-radley)", fontSize: 22, lineHeight: 1.1, letterSpacing: "-0.005em", margin: 0, fontWeight: 400 }}>
      {children}
    </h3>
  );
}

/* ---------- Gauge & sparkline ---------- */

function Gauge({ pct, color, ariaLabel, children }: { pct: number; color: string; ariaLabel: string; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  const SIZE = 56;
  const STROKE = 5;
  const r = (SIZE - STROKE) / 2;
  const c = 2 * Math.PI * r;
  const ARC_FRAC = 0.75;
  const trackLen = ARC_FRAC * c;
  const fillLen = Math.max(0, Math.min(trackLen, (pct / 100) * trackLen));
  const centreTransform = "translate(-50%, calc(-50% + 3px))";
  return (
    <div onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)} tabIndex={0} style={{ position: "relative", width: SIZE, height: SIZE, display: "flex", alignItems: "center", justifyContent: "center", outline: "none" }} aria-label={ariaLabel}>
      <svg width={SIZE} height={SIZE} aria-hidden style={{ display: "block" }}>
        <circle cx={SIZE/2} cy={SIZE/2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={STROKE} strokeLinecap="round" strokeDasharray={`${trackLen} ${c-trackLen}`} transform={`rotate(135 ${SIZE/2} ${SIZE/2})`} />
        <circle cx={SIZE/2} cy={SIZE/2} r={r} fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeDasharray={`${fillLen} ${c-fillLen}`} transform={`rotate(135 ${SIZE/2} ${SIZE/2})`} />
      </svg>
      <span style={{ position: "absolute", left: "50%", top: "50%", transform: centreTransform, opacity: hover ? 0 : 1, transition: "opacity 180ms ease-out", pointerEvents: "none" }}>
        {children}
      </span>
      <span style={{ position: "absolute", left: "50%", top: "50%", transform: centreTransform, fontFamily: "var(--sans-stack)", fontSize: 14, fontWeight: 500, color: "rgba(255,255,255,0.95)", fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", lineHeight: 1, opacity: hover ? 1 : 0, transition: "opacity 180ms ease-out", pointerEvents: "none" }}>
        {pct}
      </span>
    </div>
  );
}

function Sparkline({ values, lineColor, fillColor, height = 64 }: { values: number[]; lineColor: string; fillColor: string; height?: number }) {
  const W = 1000;
  const H = height;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = W / (values.length - 1);
  const points: Array<[number, number]> = values.map((v, i) => [i * stepX, H - ((v - min) / range) * H]);
  const polyline = points.map(([x, y]) => `${x},${y}`).join(" ");
  const area = `M0,${H} ${points.map(([x, y]) => `L${x},${y}`).join(" ")} L${W},${H} Z`;
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden style={{ display: "block" }}>
      <path d={area} fill={fillColor} />
      <polyline points={polyline} fill="none" stroke={lineColor} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 12, lineHeight: 1.2 }}>
      <span>{label}</span>
      <span style={{ color: "rgba(255,255,255,0.92)", fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

const fmtNum = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/* ---------- Data ---------- */

type AllocationEntry = TokenEntry & { pct: number };
const ALLOCATIONS: AllocationEntry[] = [
  { ...TOKENS.USDC, pct: 38 },
  { ...TOKENS.ETH,  pct: 24 },
  { ...TOKENS.BTC,  pct: 18 },
  { ...TOKENS.USDT, pct: 12 },
  { ...TOKENS.UNI,  pct:  8 },
];

type PoolEntry = {
  slug: string;
  pct: number;
  color: string;
  pair?: { left: TokenEntry; right: TokenEntry };
  single?: TokenEntry;
};
const POOLS: PoolEntry[] = [
  { slug: "ETH/USDC",     pct: 24, color: TOKENS.ETH.color,  pair: { left: TOKENS.ETH,  right: TOKENS.USDC } },
  { slug: "BTC/USDC",     pct: 18, color: TOKENS.BTC.color,  pair: { left: TOKENS.BTC,  right: TOKENS.USDC } },
  { slug: "USDC/USDT",    pct: 12, color: TOKENS.USDT.color, pair: { left: TOKENS.USDC, right: TOKENS.USDT } },
  { slug: "UNI/USDC",     pct:  8, color: TOKENS.UNI.color,  pair: { left: TOKENS.UNI,  right: TOKENS.USDC } },
  { slug: "Idle reserve", pct: 38, color: TOKENS.USDC.color, single: TOKENS.USDC },
];

const POSITIONS_SORTED: PoolEntry[] = [
  POOLS.find((p) => p.slug === "Idle reserve")!,
  ...POOLS
    .filter((p) => p.slug !== "Idle reserve")
    .sort((a, b) => b.pct - a.pct),
];

// Per-pool APR + 30d fees earned. Same eventual source as POOLS — a
// vault-state read on the backend; mocked here for the demo.
const POOL_APR: Record<string, number> = {
  "ETH/USDC":     18.4,
  "BTC/USDC":     14.2,
  "USDC/USDT":     8.6,
  "UNI/USDC":     22.1,
  "Idle reserve":  0.0,
};
const POOL_EARNED_30D: Record<string, number> = {
  "ETH/USDC":     1240.50,
  "BTC/USDC":      890.20,
  "USDC/USDT":     320.10,
  "UNI/USDC":      215.80,
  "Idle reserve":    0.00,
};
const BASKET_APR_30D = 14.2;
const BASKET_EARNED_30D = POOLS.reduce((a, p) => a + (POOL_EARNED_30D[p.slug] ?? 0), 0);

// Agent message feed:
//   signal  — raw incoming data (price/vol move, fee accrual, etc.).
//             Standalone: a signal may or may not get acted on.
//   action  — onchain tx (hash + chip + title). Carries an optional
//             `thought` lead-in; thoughts only exist tethered to the
//             action they triggered, never standalone.
// Plus user/reply for live chat.
type ActionChip =
  | { type: "single"; token: TokenEntry }
  | { type: "pair"; left: TokenEntry; right: TokenEntry };

type SourceRef = { kind: SourceKind; label: string; tx?: string; href?: string };

type AgentMessage =
  | { id: string; kind: "signal"; iso: string; text: string }
  | { id: string; kind: "action"; title: string; category: ActionCategory; chip: ActionChip; iso: string; tx: string; text: string; thought?: string }
  | { id: string; kind: "user";   iso: string; text: string }
  | { id: string; kind: "reply";  iso: string; text: string; sources?: SourceRef[]; replyTo?: string };

// Pulls the hour-of-day (0–23) from an iso label like "Apr 28 · 14:23".
// Returns null if the format is unexpected.
function parseHour(iso: string): number | null {
  const time = iso.split(" · ")[1];
  if (!time) return null;
  const hh = parseInt(time.slice(0, 2), 10);
  return Number.isFinite(hh) ? hh : null;
}

// Builds 24 hour buckets ending at the latest message's hour. Each
// bucket counts `signal` and `action` messages and dedupes the tokens
// touched by actions in that hour (used by the tooltip's chip row).
// User/reply chat is ignored — this is agent-side cadence.
type HourBucket = { signals: number; actions: number; tokens: TokenEntry[] };
function buildHourlyActivity(messages: AgentMessage[]): HourBucket[] {
  const buckets: HourBucket[] = Array.from({ length: 24 }, () => ({ signals: 0, actions: 0, tokens: [] }));
  if (messages.length === 0) return buckets;
  const lastHour = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const h = parseHour(messages[i].iso);
      if (h !== null) return h;
    }
    return 0;
  })();
  for (const m of messages) {
    if (m.kind !== "signal" && m.kind !== "action") continue;
    const h = parseHour(m.iso);
    if (h === null) continue;
    // Distance backward from lastHour, wrapping mod 24. Bucket index
    // is (23 - distance) so the latest hour sits at the right edge.
    const dist = (lastHour - h + 24) % 24;
    if (dist > 23) continue;
    const idx = 23 - dist;
    if (m.kind === "signal") buckets[idx].signals++;
    else {
      buckets[idx].actions++;
      const ts: TokenEntry[] = m.chip.type === "pair" ? [m.chip.left, m.chip.right] : [m.chip.token];
      for (const t of ts) {
        if (!buckets[idx].tokens.some((x) => x.slug === t.slug)) {
          buckets[idx].tokens.push(t);
        }
      }
    }
  }
  return buckets;
}

// "MMM D · HH:MM" — what the chat row + hover time render.
function formatDisplayIso(d: Date): string {
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${months[d.getMonth()]} ${d.getDate()} · ${hh}:${mm}`;
}

function nowIso(): string { return formatDisplayIso(new Date()); }

// Falls back to USDC if the backend ever sends an unknown symbol —
// keeps the chip from rendering undefined and crashing TokenChip.
const resolveToken = (sym: string): TokenEntry => TOKENS[sym] ?? TOKENS.USDC;

// Wire → view: resolves token symbols, reshapes WireSource → SourceRef,
// preserves id + replyTo so optimistic reconciliation can work.
function toAgentMessage(w: WireMessage): AgentMessage {
  const iso = formatDisplayIso(new Date(w.ts));
  switch (w.kind) {
    case "signal":
      return { id: w.id, kind: "signal", iso, text: w.text };
    case "action":
      return {
        id: w.id, kind: "action", iso,
        title: w.title,
        category: w.category,
        text: w.text,
        thought: w.thought,
        tx: w.tx,
        chip: w.chip.type === "pair"
          ? { type: "pair", left: resolveToken(w.chip.left), right: resolveToken(w.chip.right) }
          : { type: "single", token: resolveToken(w.chip.token) },
      };
    case "user":
      return { id: w.id, kind: "user", iso, text: w.text };
    case "reply":
      return {
        id: w.id, kind: "reply", iso, text: w.text,
        replyTo: w.replyTo,
        sources: w.sources?.map((s): SourceRef =>
          s.kind === "uniswap"
            ? { kind: "uniswap", label: s.label, href: s.url }
            : { kind: s.kind, label: s.label, tx: s.tx }
        ),
      };
  }
}

// Wire-shape demo seed. `ts` is local-time ISO (no Z) so the display
// stays stable across timezones; prod backend should emit UTC.
const ACTION_TITLE = "Action submitted";

const INITIAL_WIRE_MESSAGES: WireMessage[] = [
  { id: "evt_001", ts: "2026-04-28T05:18:00", kind: "signal", text: "USDC/USDT stable-pair fees: $890 accrued." },
  { id: "evt_002", ts: "2026-04-28T05:24:00", kind: "action", title: ACTION_TITLE, category: "claim_fees", chip: { type: "single", token: "USDT" }, tx: "0xc4e2…77f9",
    text: "Compounded $890 from USDC/USDT into LP." },
  { id: "evt_003", ts: "2026-04-28T08:11:00", kind: "signal", text: "ETH/USDC mid drifted to $4,124, +1.4% from band center." },
  { id: "evt_004", ts: "2026-04-28T08:24:00", kind: "action", title: ACTION_TITLE, category: "edit_position", chip: { type: "single", token: "ETH" }, tx: "0x9f15…c780",
    thought: "Drift exceeds the rebalance threshold. Recentering before fees decay further.",
    text: "Rebalanced ETH/USDC at $4,124 mid. New range ±1.0%." },
  // Standalone signal — TWAP divergence noted, but no action follows.
  { id: "evt_005", ts: "2026-04-28T09:55:00", kind: "signal", text: "TWAP divergence between USDC and USDT widening to 4 bps." },
  { id: "evt_006", ts: "2026-04-28T11:20:00", kind: "signal", text: "UNI/USDC price re-entered the inner range." },
  { id: "evt_007", ts: "2026-04-28T11:25:00", kind: "action", title: ACTION_TITLE, category: "edit_position", chip: { type: "single", token: "UNI" }, tx: "0x2e91…44ab",
    text: "Closed UNI/USDC outer band to reserve. Price action settled inside the inner range." },
  { id: "evt_008", ts: "2026-04-28T13:18:00", kind: "signal", text: "UNI 1h volume +43% post-governance vote." },
  { id: "evt_009", ts: "2026-04-28T13:25:00", kind: "action", title: ACTION_TITLE, category: "swap", chip: { type: "pair", left: "BTC", right: "UNI" }, tx: "0xa7d3…91f2",
    thought: "Volume regime shift on UNI looks structural, not a wick. Reallocating exposure.",
    text: "Rotated 5% from BTC/USDC into UNI/USDC." },
  { id: "evt_010", ts: "2026-04-28T14:01:00", kind: "signal", text: "Accrued fees on BTC/USDC: $1.21k." },
  { id: "evt_011", ts: "2026-04-28T14:08:00", kind: "action", title: ACTION_TITLE, category: "claim_fees", chip: { type: "single", token: "BTC" }, tx: "0xb1c2…8e4d",
    text: "Harvested $1.2k in fees from BTC/USDC and compounded back into the position." },
  { id: "evt_012", ts: "2026-04-28T14:15:00", kind: "signal", text: "ETH/USDC realized vol −22% over the last 4h." },
  { id: "evt_013", ts: "2026-04-28T14:23:00", kind: "action", title: ACTION_TITLE, category: "edit_position", chip: { type: "single", token: "ETH" }, tx: "0x4f8a…c3b1",
    thought: "Vol contracting cleanly. A tighter band captures more of the spread without raising rebalance frequency.",
    text: "Tightened ETH/USDC to ±0.8%. Realized vol dropped 22% in the last 4h, capturing more of the spread in a tighter band." },
];

// Pre-built dev replies. Sources are WireSource so the stub round-trips
// through the same adapter the real backend will feed.
const QUICK_REPLIES: { match: RegExp; text: string; sources?: WireSource[] }[] = [
  { match: /\b(position|stake|holding|holdings|share|shares|alp)\b/i,
    text: "You currently hold 0 ALP. Once you deposit, each ALP claims a slice of $3.26M of active liquidity across 5 pools, with 38% sitting in the idle reserve.",
    sources: [{ kind: "vault", label: "Vault state", tx: "0xa1b2…f9c8" }] },
  { match: /\b(apr|yield|earning|earnings|return|fee|fees)\b/i,
    text: "30-day rolling APR is 14.2%, slightly above the 90-day average (13.6%). Driven mostly by ETH/USDC fee capture this week.",
    sources: [
      { kind: "vault", label: "30d performance", tx: "0xa1b2…f9c8" },
      { kind: "uniswap", label: "ETH/USDC pool", url: "https://app.uniswap.org/" },
    ] },
  { match: /\b(rebalance|range|tighten|widen)\b/i,
    text: "Tightened ETH/USDC to ±0.8% two minutes ago after realized vol dropped. Fee yield projected up ~12% over the next 24h.",
    sources: [
      { kind: "basescan", label: "Rebalance tx", tx: "0x4f8a…c3b1" },
      { kind: "uniswap", label: "ETH/USDC pool", url: "https://app.uniswap.org/" },
    ] },
  { match: /\b(tvl|vault|value)\b/i,
    text: "Vault TVL is $3.26M, up 6.9% over 30 days. Four active pools and the idle reserve at 38%.",
    sources: [{ kind: "vault", label: "Vault state", tx: "0xa1b2…f9c8" }] },
  { match: /\b(risk|il|impermanent|drawdown)\b/i,
    text: "Impermanent loss is contained by continuous rebalancing. 30-day net APR (14.2%) sits well above estimated IL drag (~2.4%/y).",
    sources: [{ kind: "vault", label: "Risk model", tx: "0xa1b2…f9c8" }] },
  { match: /\b(idle|reserve|cash)\b/i,
    text: "Idle reserve is at 38% (target band 30 to 45%). It's USDC sitting in the vault, used for instant withdrawals and quick redeployments.",
    sources: [{ kind: "vault", label: "Vault state", tx: "0xa1b2…f9c8" }] },
  { match: /\b(pool|pools|pair|pairs)\b/i,
    text: "Active pools: ETH/USDC (24%), BTC/USDC (18%), USDC/USDT (12%), UNI/USDC (8%). Each is rebalanced independently based on its own vol and fee signals.",
    sources: [
      { kind: "vault", label: "Vault allocation", tx: "0xa1b2…f9c8" },
      { kind: "uniswap", label: "Uniswap pools", url: "https://app.uniswap.org/" },
    ] },
  { match: /\b(hi|hello|hey|sup|yo)\b/i,
    text: "Hey. I manage the active positions across the basket and rebalance them continuously. Try asking about position, APR, rebalances, TVL, risk, or pools." },
];

function getAgentReply(input: string): { text: string; sources?: WireSource[] } {
  for (const r of QUICK_REPLIES) {
    if (r.match.test(input)) return { text: r.text, sources: r.sources };
  }
  return { text: "I don't have a pre-built answer for that one. Try asking about position, APR, rebalances, TVL, risk, or pools." };
}

/* ---------- Backdrop ---------- */

function PanelLandscape({ muted = false }: { muted?: boolean }) {
  // zIndex: -1 (stays inside the section's `isolation: isolate`
  // context) so the panel-scroll above doesn't need its own stacking
  // context to layer over it — keeps backdrop-filter on cards inside
  // the scroll area free to sample this image as their backdrop.
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, zIndex: -1 }}>
      <Image src="/landscape.png" alt="" fill priority sizes="100vw" style={{
        objectFit: "cover",
        filter: muted ? LANDSCAPE_FILTER_MUTED : LANDSCAPE_FILTER,
      }} />
    </div>
  );
}

/* ---------- Floating nav pill — full main-panel width, sits just above it ---------- */

function FloatingNav({ layout, exiting, onBack }: { layout: PanelLayout; exiting: boolean; onBack: () => void }) {
  return (
    <div className={exiting ? "app-nav-exit" : "app-nav-enter"} style={{
      position: "fixed",
      left: layout.left,
      width: layout.width,
      top: layout.top - 14,
      // Below the main panel's z-index so the panel covers the nav
      // initially — the slide-up reveals the nav from behind it.
      zIndex: 1,
    }}>
      <div style={{
        position: "relative",
        borderRadius: 20 * layout.scale,
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.08)",
        isolation: "isolate",
      }}>
        <div aria-hidden style={{ position: "absolute", inset: 0, zIndex: 0 }}>
          <Image src="/landscape.png" alt="" fill priority sizes="100vw" style={{
            objectFit: "cover",
            filter: LANDSCAPE_FILTER,
          }} />
        </div>

        <div style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 10px 8px 18px",
        }}>
          <Link
            href="/"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              if (exiting) return;
              onBack();
            }}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              textDecoration: "none",
            }}
          >
            <span aria-hidden style={{ display: "block", width: 22, height: 22, ...MASK_STYLE }} />
            <span style={{ color: "#fff", fontFamily: "var(--font-radley)", fontSize: 20, lineHeight: 1, fontWeight: 400, letterSpacing: "-0.02em" }}>alps</span>
          </Link>

          <button type="button" className="bg-white/[0.20] transition-colors duration-300 ease-out hover:bg-white/[0.32]" style={{
            display: "inline-flex", alignItems: "center", gap: 7,
            padding: "8px 14px", borderRadius: 10 * layout.scale, border: "none",
            color: "#fff", fontFamily: "var(--sans-stack)",
            fontSize: 12, fontWeight: 600, letterSpacing: "-0.005em", lineHeight: 1,
          }}>
            Connect wallet
            <WalletIcon size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Hero ---------- */

function HeroTitle() {
  return (
    <h1 style={{
      color: "#fff", fontFamily: "var(--font-radley)",
      fontSize: 42, lineHeight: 1.08, letterSpacing: "-0.01em",
      margin: 0, fontWeight: 400,
      alignSelf: "center",
    }}>
      Start earning from onchain volume.
    </h1>
  );
}

// Empty visual segment used in the top-right of the bento until the
// real content lands (3D bluechip render, marquee, etc.).
function PlaceholderCard({ label }: { label: string }) {
  return (
    <Card style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 0 }}>
      <span style={{
        color: "rgba(255,255,255,0.30)",
        fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500,
        letterSpacing: "0.10em", textTransform: "uppercase",
      }}>
        {label}
      </span>
    </Card>
  );
}

/* ---------- User cards ---------- */

// Filled "i" — user-supplied artwork. Outer disc at 40% opacity,
// the glyph at full opacity, both via currentColor.
function InfoIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden style={{ display: "block", flexShrink: 0, verticalAlign: "middle" }}>
      <path opacity="0.4" d="M9 1C4.5889 1 1 4.5889 1 9C1 13.4111 4.5889 17 9 17C13.4111 17 17 13.4111 17 9C17 4.5889 13.4111 1 9 1Z" fill="currentColor" />
      <path d="M9.75 12.75C9.75 13.1641 9.4141 13.5 9 13.5C8.5859 13.5 8.25 13.1641 8.25 12.75V9.5H7.75C7.3359 9.5 7 9.1641 7 8.75C7 8.3359 7.3359 8 7.75 8H8.5C9.1895 8 9.75 8.5605 9.75 9.25V12.75ZM9 6.75C8.448 6.75 8 6.301 8 5.75C8 5.199 8.448 4.75 9 4.75C9.552 4.75 10 5.199 10 5.75C10 6.301 9.552 6.75 9 6.75Z" fill="currentColor" />
    </svg>
  );
}

// Hover tooltip wrapper. Renders the popover via `createPortal` to
// `document.body` so it escapes any ancestor `overflow: hidden` (the
// deposit sub-card has it for the dot-grid clip) and isn't cut off
// when expanding upward over the input area.
function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const onEnter = () => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: r.left + r.width / 2, top: r.top });
    setHover(true);
  };
  return (
    <span
      ref={wrapRef}
      onMouseEnter={onEnter}
      onMouseLeave={() => setHover(false)}
      style={{
        position: "relative", display: "inline-flex",
        alignItems: "center", justifyContent: "center",
        verticalAlign: "middle",
      }}
    >
      {children}
      {hover && pos && typeof document !== "undefined" && createPortal(
        <div
          aria-hidden
          style={{
            position: "fixed",
            left: pos.left,
            top: pos.top - 6,
            transform: "translate(-50%, -100%)",
            padding: "4px 7px",
            borderRadius: 6,
            background: "rgba(20,20,22,0.95)",
            backdropFilter: "blur(14px)",
            WebkitBackdropFilter: "blur(14px)",
            border: "1px solid rgba(255,255,255,0.10)",
            color: "rgba(255,255,255,0.92)",
            fontFamily: "var(--sans-stack)",
            fontSize: 11, fontWeight: 500,
            lineHeight: 1.45,
            whiteSpace: "normal",
            width: "max-content", maxWidth: 220,
            pointerEvents: "none",
            zIndex: 1000,
          }}
        >
          {label}
        </div>,
        document.body,
      )}
    </span>
  );
}

// User-supplied chevron-pair (up + down). Uses currentColor so it
// inherits the surrounding muted-text shade.
function SwapVerticalIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden style={{ display: "inline-block", flexShrink: 0, opacity: 0.85 }}>
      <path d="M9.53,2.22c-.293-.293-.768-.293-1.061,0l-3.5,3.5c-.293,.293-.293,.768,0,1.061s.768,.293,1.061,0l2.97-2.97,2.97,2.97c.146,.146,.338,.22,.53,.22s.384-.073,.53-.22c.293-.293,.293-.768,0-1.061l-3.5-3.5Z" fill="currentColor" />
      <path d="M11.97,11.22l-2.97,2.97-2.97-2.97c-.293-.293-.768-.293-1.061,0s-.293,.768,0,1.061l3.5,3.5c.146,.146,.338,.22,.53,.22s.384-.073,.53-.22l3.5-3.5c.293-.293,.293-.768,0-1.061s-.768-.293-1.061,0Z" fill="currentColor" />
    </svg>
  );
}

function VaultCard() {
  const [amount, setAmount] = useState("");
  const num = Number.parseFloat(amount.replace(/,/g, "")) || 0;
  const usdValue = num; // 1:1 since input is in USDC
  const inputRef = useRef<HTMLInputElement>(null);

  // Five-token row used by the Exposure detail. Leftmost on top,
  // each subsequent chip steps right with a lower z-index. Hovered
  // chip lifts + scales + reveals its slug; neighbours stay put.
  const exposureTokens: TokenEntry[] = [TOKENS.USDC, TOKENS.ETH, TOKENS.BTC, TOKENS.USDT, TOKENS.UNI];
  const TOK_SIZE = 16;
  const TOK_OFFSET = 10;
  const [hoveredTokIdx, setHoveredTokIdx] = useState<number | null>(null);

  return (
    <Card style={{
      display: "flex", flexDirection: "column", height: "100%",
      padding: 20,
      background: "#0c0c10",
      border: "1px solid rgba(255,255,255,0.08)",
      backdropFilter: "none",
      WebkitBackdropFilter: "none",
    }}>
      <CardLabel icon="vault">Deposit</CardLabel>
      <div style={{ marginTop: 12 }}>
        <H3>Start earning fees from onchain volume!</H3>
      </div>

      {/* Sub-card 1 — amount input + APY readout. The deposit area
          (top portion above the divider) carries the dot-grid bg
          that matches Sherpa's action-summary bubble. The APY row
          below the divider stays on a flat surface. */}
      <div style={{
        marginTop: 18,
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 12,
        overflow: "hidden",
        background: "rgba(255,255,255,0.03)",
      }}>
        {/* Whole grid segment is a click-target for the input — any
            blank area focuses it. The USDC chip + Max + input itself
            still handle their own events first via bubbling. */}
        <div
          onClick={() => inputRef.current?.focus()}
          style={{
            padding: 14,
            backgroundColor: "rgba(255,255,255,0.03)",
            backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.10) 0.7px, transparent 1.1px)",
            backgroundSize: "9px 9px",
            display: "flex", flexDirection: "column", gap: 10,
            cursor: "text",
          }}
        >
          <div style={{ color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500, lineHeight: 1 }}>
            Deposit
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input
              ref={inputRef}
              inputMode="decimal"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{
                flex: 1, minWidth: 0,
                background: "transparent", border: "none", outline: "none",
                color: "#fff", fontFamily: "var(--sans-stack)",
                fontSize: 28, fontWeight: 500, letterSpacing: "-0.015em", lineHeight: 1.05,
                fontVariantNumeric: "tabular-nums",
              }}
            />
            {/* Opaque bg ≈ Vault card #0c0c10 + 0.06 white tint, so
                the pill matches the Connect wallet button visually
                without the dot-grid behind sub-card 1 bleeding
                through a translucent rgba bg. */}
            <span style={{
              display: "inline-flex", alignItems: "center", gap: 7,
              padding: "4px 11px 4px 4px",
              border: "1px solid rgba(255,255,255,0.10)",
              background: "#1a1c20",
              borderRadius: 8,
              color: "#fff",
              fontFamily: "var(--sans-stack)",
              fontSize: 12.5, fontWeight: 600, letterSpacing: "-0.005em",
            }}>
              <TokenChip entry={TOKENS.USDC} size={22} radius={5} />
              <span style={{ display: "inline-block", position: "relative", top: 1, lineHeight: 1 }}>
                USDC
              </span>
            </span>
          </div>
          <div style={{
            display: "flex", justifyContent: "space-between", alignItems: "center",
            color: "rgba(255,255,255,0.55)",
            fontFamily: "var(--sans-stack)", fontSize: 12, fontWeight: 400, lineHeight: 1,
          }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <SwapVerticalIcon size={12} />
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                ${usdValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </span>
            {/* Click balance to MAX-fill — keeps the row chrome-free. */}
            <button
              type="button"
              onClick={() => setAmount("0")}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#fff"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.55)"; }}
              style={{
                background: "transparent", border: "none", padding: 0,
                color: "rgba(255,255,255,0.55)",
                fontFamily: "var(--sans-stack)", fontSize: 12, fontWeight: 400,
                fontVariantNumeric: "tabular-nums", lineHeight: 1,
                cursor: "pointer",
                transition: "color 200ms ease",
              }}
            >
              Balance: 0.00
            </button>
          </div>
        </div>
        <div aria-hidden style={{ height: 1, background: "rgba(255,255,255,0.05)" }} />
        <div style={{
          padding: "10px 14px",
          display: "flex", justifyContent: "space-between", alignItems: "center",
          fontFamily: "var(--sans-stack)", fontSize: 12,
        }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "rgba(255,255,255,0.55)" }}>
            Deposit APY
            <InfoTip label="30-day rolling realized yield from fees the agent has captured across the basket.">
              <InfoIcon size={12} />
            </InfoTip>
          </span>
          <span style={{ color: "rgb(134, 239, 172)", fontWeight: 600, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.005em" }}>
            {BASKET_APR_30D.toFixed(2)}%
          </span>
        </div>
      </div>

      {/* Sub-card 2 — vault details. Flat bg, no dot grid. */}
      <div style={{
        marginTop: 10,
        padding: "10px 14px",
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 12,
        display: "flex", flexDirection: "column", gap: 8,
        fontFamily: "var(--sans-stack)", fontSize: 12,
      }}>
        {/* Exposure — overlapping token chips. Hovered chip lifts +
            scales up, neighbours fan outward, tooltip reveals slug. */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "rgba(255,255,255,0.55)" }}>
            Exposure
            <InfoTip label="Tokens currently held by the vault across all active liquidity positions.">
              <InfoIcon size={12} />
            </InfoTip>
          </span>
          <span style={{
            position: "relative",
            display: "inline-block",
            width: TOK_SIZE + (exposureTokens.length - 1) * TOK_OFFSET,
            height: TOK_SIZE + 4,
          }}>
            {exposureTokens.map((t, i) => {
              const hovered = hoveredTokIdx === i;
              return (
                <span
                  key={t.slug}
                  onMouseEnter={() => setHoveredTokIdx(i)}
                  onMouseLeave={() => setHoveredTokIdx(null)}
                  style={{
                    position: "absolute",
                    left: i * TOK_OFFSET,
                    top: 2,
                    zIndex: hovered ? 100 : exposureTokens.length - i,
                    transition: "transform 180ms ease",
                    transform: hovered ? "scale(1.22)" : "none",
                    transformOrigin: "center center",
                    cursor: "default",
                  }}
                >
                  <TokenChip entry={t} size={TOK_SIZE} radius={4} />
                  {hovered && (
                    <span aria-hidden style={{
                      position: "absolute",
                      bottom: "calc(100% + 4px)",
                      left: "50%",
                      transform: "translateX(-50%)",
                      padding: "2px 5px",
                      borderRadius: 5,
                      background: "rgba(20,20,22,0.95)",
                      border: "1px solid rgba(255,255,255,0.10)",
                      color: "rgba(255,255,255,0.92)",
                      fontFamily: "var(--sans-stack)", fontSize: 10, fontWeight: 500,
                      lineHeight: 1, letterSpacing: "0.02em",
                      whiteSpace: "nowrap",
                      pointerEvents: "none",
                    }}>
                      {t.slug}
                    </span>
                  )}
                </span>
              );
            })}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "rgba(255,255,255,0.55)" }}>
            Share price
            <InfoTip label="Value of one ALP share. Grows as fees accrue into the vault.">
              <InfoIcon size={12} />
            </InfoTip>
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", color: "rgba(255,255,255,0.55)", fontVariantNumeric: "tabular-nums" }}>$1.0427</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "rgba(255,255,255,0.55)" }}>
            Withdraw delay
            <InfoTip label="Withdrawals settle in one block while the idle reserve covers them; larger asks queue against the next rebalance.">
              <InfoIcon size={12} />
            </InfoTip>
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", color: "rgba(255,255,255,0.55)" }}>Instant up to reserve</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "rgba(255,255,255,0.55)" }}>
            Vault TVL
            <InfoTip label="Total value across all active positions plus the idle reserve.">
              <InfoIcon size={12} />
            </InfoTip>
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", color: "rgba(255,255,255,0.55)", fontVariantNumeric: "tabular-nums" }}>$3.26M</span>
        </div>
      </div>

      {/* Full-width primary CTA — no inline margin so it sits flush
          with the card's uniform 20px padding (top = sides = bottom). */}
      <button
        type="button"
        className="transition-colors duration-200 ease-out"
        style={{
          marginTop: "auto", width: "100%",
          display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
          padding: "14px 16px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.10)",
          background: "rgba(255,255,255,0.06)",
          color: "rgba(255,255,255,0.78)", fontFamily: "var(--sans-stack)",
          fontSize: 13, fontWeight: 600, letterSpacing: "-0.005em", lineHeight: 1,
          cursor: "pointer",
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.10)"; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
      >
        Connect wallet
        <WalletIcon size={14} />
      </button>
    </Card>
  );
}

const fmtUsd2 = (n: number, signed = false) => {
  const sign = signed ? (n >= 0 ? "+" : "−") : "";
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

// Compact key/value row used in the user-side cards.
function KvRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      fontFamily: "var(--sans-stack)", fontSize: 12, lineHeight: 1.2,
    }}>
      <span style={{ color: "rgba(255,255,255,0.55)" }}>{label}</span>
      <span style={{ color: valueColor ?? "rgba(255,255,255,0.92)", fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

// Position: current value + ALP shares in a rounded dot-grid sub-
// card (mirrors the Deposit input field's surface), Deposited /
// Yield pinned to the card floor on plain dark surface. Outer
// frame matches VaultCard (dark + 0.08 border) so the segments
// read as one family.
function UserPositionCard({ onWithdraw }: { onWithdraw: () => void }) {
  const up = USER_PNL >= 0;
  const accent = up ? "rgb(134, 239, 172)" : "rgb(248, 113, 113)";
  return (
    <Card style={{
      height: "100%", display: "flex", flexDirection: "column",
      background: "#0c0c10",
      border: "1px solid rgba(255,255,255,0.08)",
      backdropFilter: "none",
      WebkitBackdropFilter: "none",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <CardLabel icon="position">Position</CardLabel>
        {/* Connect-wallet styling on the dark card surface, with the
            dot-grid overlay matching the hero sub-card below. No
            arrow — text reads as the full affordance. Muted at rest,
            lifts on hover. */}
        <button
          type="button"
          onClick={onWithdraw}
          className="transition-colors duration-200 ease-out"
          style={{
            display: "inline-flex", alignItems: "center",
            border: "1px solid rgba(255,255,255,0.10)",
            backgroundColor: "rgba(255,255,255,0.06)",
            backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.10) 0.7px, transparent 1.1px)",
            backgroundSize: "9px 9px",
            padding: "7px 12px", borderRadius: 8,
            color: "rgba(255,255,255,0.55)",
            fontFamily: "var(--sans-stack)", fontSize: 12, fontWeight: 600,
            lineHeight: 1, letterSpacing: "-0.005em",
            cursor: "pointer",
            transition: "color 200ms ease, background-color 200ms ease",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.92)";
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(255,255,255,0.10)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.55)";
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = "rgba(255,255,255,0.06)";
          }}
        >
          Withdraw
        </button>
      </div>

      {/* $ value + ALP chip, sitting directly on the dark Card
          surface — no wrapping container chrome. */}
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{
          color: "#fff", fontFamily: "var(--sans-stack)",
          fontSize: 26, fontWeight: 600, lineHeight: 1,
          letterSpacing: "-0.015em", fontVariantNumeric: "tabular-nums",
        }}>
          {fmtUsd2(USER_VALUE)}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <AlpChip size={20} />
          <span style={{
            color: "rgba(255,255,255,0.92)",
            fontFamily: "var(--sans-stack)", fontSize: 12.5, fontWeight: 500,
            fontVariantNumeric: "tabular-nums", lineHeight: 1,
          }}>
            {USER_SHARES.toLocaleString("en-US", { maximumFractionDigits: 2 })} ALP
          </span>
        </span>
      </div>

      {/* KvRows pinned to the card floor; Performance is the taller
          sibling so this just absorbs the height difference. */}
      <div style={{ marginTop: "auto", paddingTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
        <KvRow label="Deposited" value={fmtUsd2(USER_DEPOSIT_AMT)} />
        <KvRow label="Yield" value={fmtUsd2(USER_PNL, true)} valueColor={accent} />
      </div>
    </Card>
  );
}

// Performance: realized APY (Inter), hover-trackable sparkline. Date
// in top-right swaps to the hovered day so the value/header heights
// stay constant — no layout shift on hover.
function UserAprCard() {
  const data = APR_30D;
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    setHoverIdx(Math.round(ratio * (data.length - 1)));
  };

  // Day index → "MMM D". Last index is today; we walk backward by
  // (data.length - 1 - i) days from today.
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const today = new Date(USER_DEPOSIT_TS);
  today.setDate(today.getDate() + USER_DAYS_HELD);
  const dateForIdx = (i: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (data.length - 1 - i));
    return `${months[d.getMonth()]} ${d.getDate()}`;
  };

  const value = hoverIdx === null ? USER_REALIZED_APY : data[hoverIdx];
  const dateLabel = dateForIdx(hoverIdx === null ? data.length - 1 : hoverIdx);

  return (
    // Same dark family as the sibling cards, but tinted up to the
    // shade that an rgba(255,255,255,0.03) sub-card creates on top
    // of #0c0c10 (= rgb(19,19,23) ≈ #131317). Keeps Performance one
    // step lighter than its neighbours, like a "lifted" tile, while
    // the dot-grid wash tiles edge-to-edge over the whole surface
    // without touching any of the card's internal structure.
    <Card style={{
      height: "100%", display: "flex", flexDirection: "column",
      backgroundColor: "#131317",
      backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.10) 0.7px, transparent 1.1px)",
      backgroundSize: "9px 9px",
      border: "1px solid rgba(255,255,255,0.08)",
      backdropFilter: "none",
      WebkitBackdropFilter: "none",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <CardLabel icon="sparkles">Performance</CardLabel>
        <span style={{
          color: "rgba(255,255,255,0.55)",
          fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500,
          fontVariantNumeric: "tabular-nums", lineHeight: 1,
        }}>
          {dateLabel}
        </span>
      </div>
      <div style={{ marginTop: 14 }}>
        <span style={{
          color: "rgb(134, 239, 172)",
          fontFamily: "var(--sans-stack)",
          fontSize: 26, fontWeight: 600, lineHeight: 1,
          letterSpacing: "-0.015em", fontVariantNumeric: "tabular-nums",
        }}>
          {value.toFixed(1)}%
        </span>
      </div>
      {/* marginTop matches the gap from the value to the KvRows in
          Position (chip + gap + KvRow padding) so both cards' second
          block starts at the same Y. Rounded corners on the chart
          container so the sparkline's fill area doesn't end with a
          hard rectangular bottom-right. */}
      <div
        ref={containerRef}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
        style={{
          marginTop: 44, position: "relative", cursor: "default",
          borderRadius: 10, overflow: "hidden",
        }}
      >
        <Sparkline values={data} lineColor="rgba(134, 239, 172, 0.85)" fillColor="rgba(134, 239, 172, 0.10)" height={56} />
        {hoverIdx !== null && (
          <div aria-hidden style={{
            position: "absolute",
            left: `${(hoverIdx / (data.length - 1)) * 100}%`,
            top: 0, bottom: 0, width: 1,
            background: "rgba(255,255,255,0.30)",
            pointerEvents: "none",
          }} />
        )}
      </div>
    </Card>
  );
}

// Withdraw modal — overlays the main panel only (rendered as an
// absolute child of the panel <section>). backdrop-filter blurs
// just the panel content underneath, leaving the sidebar/tabs/nav
// unaffected. Structure mirrors the Deposit (VaultCard) segment 1:1
// — same outer dark frame, same sub-card with dot-grid input area
// + divider + summary row, same vault-details sub-card, same grey
// CTA — only the chip (ALP), the labels, and the math (shares →
// USDC) flip to withdraw semantics.
function WithdrawModal({ onClose }: { onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const num = Number.parseFloat(amount.replace(/,/g, "")) || 0;
  const usdcOut = num * SHARE_PRICE;
  const valid = num > 0 && num <= USER_SHARES;

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "absolute", inset: 0, zIndex: 10,
        background: "rgba(0,0,0,0.40)",
        backdropFilter: "blur(12px) saturate(120%)",
        WebkitBackdropFilter: "blur(12px) saturate(120%)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 20,
        animation: "withdraw-fade 160ms ease-out",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Withdraw"
        style={{
          width: "min(440px, 100%)",
          maxHeight: "100%",
          overflowY: "auto",
          background: "#0c0c10",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 20,
          padding: 20,
          color: "#fff",
          fontFamily: "var(--sans-stack)",
          display: "flex", flexDirection: "column",
          boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
          animation: "withdraw-pop 180ms ease-out",
        }}
      >
        {/* Header — CardLabel on the left (mirrors VaultCard's
            "Deposit" label) + a quiet close button on the right. */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <CardLabel icon="vault">Withdraw</CardLabel>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="transition-colors duration-200 ease-out"
            style={{
              width: 22, height: 22, borderRadius: 6,
              background: "transparent", border: "none",
              color: "rgba(255,255,255,0.55)",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              cursor: "pointer", padding: 0,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.92)"; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.55)"; }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M6 6l12 12M18 6l-12 12" />
            </svg>
          </button>
        </div>
        <div style={{ marginTop: 12 }}>
          <H3>We&rsquo;re sad to see you go.</H3>
        </div>

        {/* Sub-card 1 — withdraw amount + grid bg, mirroring the
            Deposit input field 1:1. ALP chip replaces USDC, balance
            is in shares, and the bottom row is "You receive" (USDC
            equivalent) instead of "Deposit APY". */}
        <div style={{
          marginTop: 18,
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 12,
          overflow: "hidden",
          background: "rgba(255,255,255,0.03)",
        }}>
          <div
            onClick={() => inputRef.current?.focus()}
            style={{
              padding: 14,
              backgroundColor: "rgba(255,255,255,0.03)",
              backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.10) 0.7px, transparent 1.1px)",
              backgroundSize: "9px 9px",
              display: "flex", flexDirection: "column", gap: 10,
              cursor: "text",
            }}
          >
            <div style={{ color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500, lineHeight: 1 }}>
              Withdraw
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                ref={inputRef}
                inputMode="decimal"
                placeholder="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={{
                  flex: 1, minWidth: 0,
                  background: "transparent", border: "none", outline: "none",
                  color: "#fff", fontFamily: "var(--sans-stack)",
                  fontSize: 28, fontWeight: 500, letterSpacing: "-0.015em", lineHeight: 1.05,
                  fontVariantNumeric: "tabular-nums",
                }}
              />
              {/* ALP chip — mirrors VaultCard's USDC chip exactly:
                  same opaque #1a1c20 bg, 0.10 border, padding,
                  radius, font sizing. */}
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 7,
                padding: "4px 11px 4px 4px",
                border: "1px solid rgba(255,255,255,0.10)",
                background: "#1a1c20",
                borderRadius: 8,
                color: "#fff",
                fontFamily: "var(--sans-stack)",
                fontSize: 12.5, fontWeight: 600, letterSpacing: "-0.005em",
              }}>
                <AlpChip size={22} />
                <span style={{ display: "inline-block", position: "relative", top: 1, lineHeight: 1 }}>
                  ALP
                </span>
              </span>
            </div>
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              color: "rgba(255,255,255,0.55)",
              fontFamily: "var(--sans-stack)", fontSize: 12, fontWeight: 400, lineHeight: 1,
            }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <SwapVerticalIcon size={12} />
                <span style={{ fontVariantNumeric: "tabular-nums" }}>
                  ${usdcOut.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </span>
              <button
                type="button"
                onClick={() => setAmount(USER_SHARES.toFixed(2))}
                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "#fff"; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "rgba(255,255,255,0.55)"; }}
                style={{
                  background: "transparent", border: "none", padding: 0,
                  color: "rgba(255,255,255,0.55)",
                  fontFamily: "var(--sans-stack)", fontSize: 12, fontWeight: 400,
                  fontVariantNumeric: "tabular-nums", lineHeight: 1,
                  cursor: "pointer",
                  transition: "color 200ms ease",
                }}
              >
                Balance: {USER_SHARES.toLocaleString("en-US", { maximumFractionDigits: 2 })}
              </button>
            </div>
          </div>
          <div aria-hidden style={{ height: 1, background: "rgba(255,255,255,0.05)" }} />
          <div style={{
            padding: "10px 14px",
            display: "flex", justifyContent: "space-between", alignItems: "center",
            fontFamily: "var(--sans-stack)", fontSize: 12,
          }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "rgba(255,255,255,0.55)" }}>
              You receive
              <InfoTip label="ALP shares are redeemed for their pro-rata slice of the vault, paid out in USDC at the current share price.">
                <InfoIcon size={12} />
              </InfoTip>
            </span>
            <span style={{ color: "#fff", fontWeight: 600, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.005em" }}>
              ${usdcOut.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>

        {/* Sub-card 2 — vault details. Mirrors VaultCard's second
            sub-card minus the Exposure row (Withdraw doesn't need
            to surface the vault's basket composition; the Share
            price + delay + TVL are the relevant context here). */}
        <div style={{
          marginTop: 10,
          padding: "10px 14px",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: 12,
          display: "flex", flexDirection: "column", gap: 8,
          fontFamily: "var(--sans-stack)", fontSize: 12,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "rgba(255,255,255,0.55)" }}>
              Share price
              <InfoTip label="Value of one ALP share. Grows as fees accrue into the vault.">
                <InfoIcon size={12} />
              </InfoTip>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", color: "rgba(255,255,255,0.55)", fontVariantNumeric: "tabular-nums" }}>$1.0427</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "rgba(255,255,255,0.55)" }}>
              Withdraw delay
              <InfoTip label="Withdrawals settle in one block while the idle reserve covers them; larger asks queue against the next rebalance.">
                <InfoIcon size={12} />
              </InfoTip>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", color: "rgba(255,255,255,0.55)" }}>Instant up to reserve</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "rgba(255,255,255,0.55)" }}>
              Vault TVL
              <InfoTip label="Total value across all active positions plus the idle reserve.">
                <InfoIcon size={12} />
              </InfoTip>
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", color: "rgba(255,255,255,0.55)", fontVariantNumeric: "tabular-nums" }}>$3.26M</span>
          </div>
        </div>

        {/* CTA — copy of VaultCard's Connect-wallet button (grey
            translucent + 0.10 border + 0.78 white text). When the
            input is invalid the text dims and the click is blocked;
            shape/colors stay so the button doesn't reflow. */}
        <button
          type="button"
          disabled={!valid}
          className="transition-colors duration-200 ease-out"
          style={{
            marginTop: 12, width: "100%",
            display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
            padding: "14px 16px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.06)",
            color: valid ? "rgba(255,255,255,0.92)" : "rgba(255,255,255,0.40)",
            fontFamily: "var(--sans-stack)",
            fontSize: 13, fontWeight: 600, letterSpacing: "-0.005em", lineHeight: 1,
            cursor: valid ? "pointer" : "default",
          }}
          onMouseEnter={(e) => { if (valid) (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.10)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = "rgba(255,255,255,0.06)"; }}
        >
          {valid ? `Withdraw ${fmtUsd2(usdcOut)}` : "Enter an amount"}
          <StrokeIcon kind="arrow" size={14} />
        </button>
      </div>
    </div>
  );
}

// Full-width log of the user's own deposits/withdrawals. Wire-shape
// extension once backend lands: filter by connected wallet, surface
// withdraw events, and group same-day transactions.
type UserActivityKind = "deposit" | "withdraw";
type UserActivityRow = {
  kind: UserActivityKind;
  amount: number;
  token: TokenEntry;
  ts: string;
  tx: string;
};
const USER_ACTIVITY: UserActivityRow[] = [
  { kind: "deposit", amount: USER_DEPOSIT_AMT, token: TOKENS.USDC, ts: USER_DEPOSIT_TS, tx: USER_DEPOSIT_TX },
];

function UserActivityCard() {
  return (
    // Dark frame matching VaultCard / Position. Each item gets its
    // own dot-grid surface (matching the Deposit input field); the
    // Card bg behind them stays plain dark.
    <Card style={{
      height: "100%", display: "flex", flexDirection: "column",
      background: "#0c0c10",
      border: "1px solid rgba(255,255,255,0.08)",
      backdropFilter: "none",
      WebkitBackdropFilter: "none",
    }}>
      <CardLabel icon="stack">Activity</CardLabel>
      <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 4 }}>
        {USER_ACTIVITY.length === 0 ? (
          <div style={{
            padding: "16px 14px",
            textAlign: "center",
            color: "rgba(255,255,255,0.45)",
            fontFamily: "var(--sans-stack)", fontSize: 12,
          }}>
            No activity yet — deposit to get started.
          </div>
        ) : USER_ACTIVITY.map((a, i) => {
          const d = new Date(a.ts);
          const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
          const dateLabel = `${months[d.getMonth()]} ${d.getDate()}`;
          return (
            <a
              key={i}
              href={`${TX_BASE_URL}${a.tx.replace(/…/g, "")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="chat-tx-link"
              style={{
                display: "grid",
                gridTemplateColumns: "auto minmax(0, 1fr) auto auto",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                borderRadius: 10,
                textDecoration: "none",
                color: "rgba(255,255,255,0.85)",
                // Dot-grid surface on each item — matches the Deposit
                // input sub-card. Border keeps the row's frame
                // legible against the dark Card background.
                backgroundColor: "rgba(255,255,255,0.03)",
                backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.10) 0.7px, transparent 1.1px)",
                backgroundSize: "9px 9px",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <TokenChip entry={a.token} size={18} radius={5} />
              <span style={{
                fontFamily: "var(--sans-stack)", fontSize: 12.5, fontWeight: 500,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {a.kind === "deposit" ? "Deposited" : "Withdrew"} {a.amount.toLocaleString("en-US")} {a.token.slug}
              </span>
              <span style={{
                color: "rgba(255,255,255,0.45)",
                fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500,
                fontVariantNumeric: "tabular-nums",
              }}>
                {dateLabel}
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>
                {a.tx}
                <StrokeIcon kind="external" size={10} />
              </span>
            </a>
          );
        })}
      </div>
    </Card>
  );
}


/* ---------- Agent chat sidebar ---------- */

// Stylised alps mark for the thinking indicator — a triangular peak with
// 5 streaks above. Mountain stays muted; streaks fade in one-by-one in a
// looping cycle (`thinking-streak` keyframe in the inline <style>).
function ThinkingMark({ size = 22 }: { size?: number }) {
  const mountain = "rgba(255,255,255,0.18)";
  const streak = "rgba(255,255,255,0.55)";
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden style={{ display: "block" }}>
      <line className="thinking-streak streak-1" x1="11.5" y1="4"  x2="13.5" y2="4"  stroke={streak} strokeWidth="1.4" strokeLinecap="round" />
      <line className="thinking-streak streak-2" x1="14"   y1="6"  x2="16"   y2="6"  stroke={streak} strokeWidth="1.4" strokeLinecap="round" />
      <line className="thinking-streak streak-3" x1="16.5" y1="4"  x2="18.5" y2="4"  stroke={streak} strokeWidth="1.4" strokeLinecap="round" />
      <line className="thinking-streak streak-4" x1="13"   y1="8"  x2="15"   y2="8"  stroke={streak} strokeWidth="1.4" strokeLinecap="round" />
      <line className="thinking-streak streak-5" x1="17"   y1="8"  x2="19"   y2="8"  stroke={streak} strokeWidth="1.4" strokeLinecap="round" />
      <path d="M5 27 L16 11 L27 27 Z" fill={mountain} />
    </svg>
  );
}

const TX_BASE_URL = "https://basescan.org/tx/";

// `iso` is "MMM D · HH:MM". When the message is on the same date as
// today's feed-top label we show only the time (HH:MM); otherwise only
// the date (MMM D). One value, never both.
function formatHoverIso(iso: string, todayLabel: string): string {
  const [date, time] = iso.split(" · ");
  return date === todayLabel ? (time ?? iso) : (date ?? iso);
}

// Solid grey rounded-square copy button overlaid on a bubble's
// top-right corner. Positioned absolute so it sits ON TOP of body text.
// Reveals on `.chat-msg:hover`. Click → write to clipboard, brief flash
// of brighter bg (no svg color change).
function BubbleCopy({ copyText }: { copyText: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(copyText).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  // Sized to match the inner content height of a single-line bubble
  // (≈line-height 19.4 + a bit of breathing room → 28×28). Stays the
  // same constant size on multi-line bubbles so it doesn't grow.
  // backdropFilter blurs whatever's behind the square (dot grid, body
  // text, etc.) so the icon stays readable on every surface — same
  // technique the main panel `Card`s use.
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : "Copy message"}
      className="chat-msg-copy"
      style={{
        position: "absolute",
        top: 6, right: 6,
        width: 28, height: 28, borderRadius: 7,
        background: copied ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)",
        backdropFilter: "blur(14px) saturate(140%)",
        WebkitBackdropFilter: "blur(14px) saturate(140%)",
        border: "1px solid rgba(255,255,255,0.10)",
        color: "rgba(255,255,255,0.88)",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        cursor: "pointer", padding: 0,
        transition: "background 180ms ease, opacity 160ms ease",
      }}
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

// Inline timestamp shown below the bubble on hover only. Renders
// absolutely so it doesn't reserve vertical space when hidden.
function BubbleTime({ iso, todayLabel }: { iso: string; todayLabel: string }) {
  return (
    <time className="chat-msg-time" style={{
      position: "absolute",
      right: 0, top: "100%",
      marginTop: 4,
      fontFamily: "var(--sans-stack)", fontSize: 10, fontWeight: 500,
      color: "rgba(255,255,255,0.40)",
      fontVariantNumeric: "tabular-nums",
      letterSpacing: "0.02em",
      pointerEvents: "none",
      whiteSpace: "nowrap",
    }}>
      {formatHoverIso(iso, todayLabel)}
    </time>
  );
}

// 24h micro-histogram of agent activity — one bar per hour, latest on
// the right. Each bar is two stacked sub-bars: actions at the bottom
// (dim) + signals on top (bright white). Tokens in the tooltip line
// up with the bottom (actions) row, matching the dim color. Empty
// hours render as a faint floor pin so the timeline reads even when
// sparse. The rightmost "now" bar gets a slow pulse. Hovering a bar
// reveals a small tooltip card above the histogram.
function ActivityHistogram({ messages, onSelectHour }: { messages: AgentMessage[]; onSelectHour: (hour: number) => void }) {
  const buckets = React.useMemo(() => buildHourlyActivity(messages), [messages]);
  const lastHour = React.useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const h = parseHour(messages[i].iso);
      if (h !== null) return h;
    }
    return null;
  }, [messages]);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [tipPos, setTipPos] = useState<{ top: number; right: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const max = Math.max(1, ...buckets.map((b) => b.signals + b.actions));
  const MAX_H = 18;
  const BAR_W = 4;
  const GAP = 2.5;
  const total = buckets.reduce((a, b) => a + b.signals + b.actions, 0);

  const hoveredHour = hoverIdx !== null && lastHour !== null
    ? (lastHour - (23 - hoverIdx) + 24) % 24
    : null;
  const hovered = hoverIdx !== null ? buckets[hoverIdx] : null;

  // Capture the histogram's bounding rect on hover so the portalled
  // tooltip can position itself in viewport space (escapes the chat
  // panel's `overflow: hidden`).
  const onEnterHisto = () => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setTipPos({ top: r.top, right: window.innerWidth - r.right });
  };

  return (
    <div
      ref={containerRef}
      aria-label={`24h activity, ${total} events`}
      style={{
        position: "relative",
        display: "inline-flex", alignItems: "flex-end", gap: GAP,
        height: MAX_H, flexShrink: 0,
      }}
      onMouseEnter={onEnterHisto}
      onMouseLeave={() => { setHoverIdx(null); setTipPos(null); }}
    >
      {buckets.map((b, i) => {
        const sum = b.signals + b.actions;
        const isNow = i === buckets.length - 1;
        const hourFor = lastHour !== null ? (lastHour - (23 - i) + 24) % 24 : null;
        const onEnter = () => setHoverIdx(i);
        const onClick = () => { if (sum > 0 && hourFor !== null) onSelectHour(hourFor); };
        const clickable = sum > 0;
        if (sum === 0) {
          return (
            <span
              key={i}
              onMouseEnter={onEnter}
              style={{
                width: BAR_W, height: MAX_H, alignSelf: "flex-end",
                display: "inline-flex", alignItems: "flex-end",
                cursor: "default",
              }}
            >
              <span aria-hidden style={{
                width: BAR_W, height: 1, borderRadius: 1,
                background: "rgba(255,255,255,0.10)",
              }} />
            </span>
          );
        }
        const h = Math.max(2, Math.round((sum / max) * MAX_H));
        const sigH = Math.round((b.signals / sum) * h);
        const actH = h - sigH;
        return (
          <span
            key={i}
            onMouseEnter={onEnter}
            onClick={onClick}
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
            onKeyDown={(e) => { if (clickable && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onClick(); } }}
            style={{
              width: BAR_W, height: MAX_H, alignSelf: "flex-end",
              display: "inline-flex", alignItems: "flex-end",
              cursor: clickable ? "pointer" : "default",
            }}
          >
            <span
              aria-hidden
              className={isNow ? "histo-now" : undefined}
              style={{
                display: "inline-flex", flexDirection: "column-reverse",
                width: BAR_W, height: h, borderRadius: 1,
                overflow: "hidden",
              }}
            >
              {actH > 0 && (
                <span style={{ height: actH, background: "rgba(255,255,255,0.30)" }} />
              )}
              {sigH > 0 && (
                <span style={{ height: sigH, background: "rgba(255,255,255,0.85)" }} />
              )}
            </span>
          </span>
        );
      })}

      {/* Tooltip is portalled to <body> with position: fixed so it
          escapes the chat panel's `overflow: hidden` clipping when it
          renders above the header. */}
      {hovered !== null && hoveredHour !== null && tipPos && typeof document !== "undefined" && createPortal(
        <div style={{
          position: "fixed",
          top: tipPos.top - 8,
          right: tipPos.right,
          transform: "translateY(-100%)",
          background: "rgba(20,20,22,0.92)",
          backdropFilter: "blur(14px) saturate(140%)",
          WebkitBackdropFilter: "blur(14px) saturate(140%)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 8,
          padding: "7px 9px",
          display: "flex", flexDirection: "column", gap: 4,
          minWidth: 132,
          fontFamily: "var(--sans-stack)",
          fontVariantNumeric: "tabular-nums",
          pointerEvents: "none",
          zIndex: 1000,
        }}>
          {/* Top row: signals (bright square) + count, hour pill on right. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.92)", fontSize: 11, fontWeight: 500 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: "rgba(255,255,255,0.85)", flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{hovered.signals} signal{hovered.signals === 1 ? "" : "s"}</span>
            <span style={{
              color: "rgba(255,255,255,0.50)",
              fontSize: 9, fontWeight: 600, letterSpacing: "0.10em",
              textTransform: "uppercase",
              flexShrink: 0,
            }}>
              {String(hoveredHour).padStart(2, "0")}:00
            </span>
          </div>
          {/* Bottom row: actions (dim square) + count, token chips + "+N"
              right-aligned. Tokens come from actions, so they align
              semantically with the action row's dim color. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.92)", fontSize: 11, fontWeight: 500 }}>
            <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: "rgba(255,255,255,0.30)", flexShrink: 0 }} />
            <span style={{ flex: 1 }}>{hovered.actions} action{hovered.actions === 1 ? "" : "s"}</span>
            {hovered.tokens.length > 0 && (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                {hovered.tokens.slice(0, 2).map((t, i) => (
                  <TokenChip key={i} entry={t} size={12} radius={3} />
                ))}
              </span>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

// Small grey rounded square used as a glyph holder for non-action
// message kinds (signal, etc.) — visually sibling to the agent header
// avatar but smaller/inline.
function GlyphSquare({ children, size = 22 }: { children: React.ReactNode; size?: number }) {
  return (
    <span aria-hidden style={{
      width: size, height: size, borderRadius: 6,
      background: "rgba(255,255,255,0.06)",
      color: "rgba(255,255,255,0.78)",
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      flexShrink: 0,
    }}>
      {children}
    </span>
  );
}

function MessageView({ m, todayLabel, flash }: { m: AgentMessage; todayLabel: string; flash: boolean }) {
  const wrapperClass = `chat-msg${flash ? " chat-msg-flash" : ""}`;
  if (m.kind === "signal") {
    // Same chassis as an action bubble (dark card, no dot grid). Header
    // is a "New context" label with a glyph square — no chip/no hash.
    return (
      <div className={wrapperClass} data-msg-id={m.id} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <GlyphSquare size={22}>
            <NewContextIcon size={13} />
          </GlyphSquare>
          <span style={{
            flex: 1, minWidth: 0,
            color: "rgba(255,255,255,0.92)",
            fontFamily: "var(--sans-stack)",
            fontSize: 12, fontWeight: 600,
            letterSpacing: "-0.005em",
          }}>
            New context
          </span>
        </div>
        <div style={{
          position: "relative",
          color: "rgba(255,255,255,0.85)",
          fontFamily: "var(--sans-stack)",
          fontSize: 12.5, lineHeight: 1.55, fontWeight: 400,
          padding: "10px 12px",
          borderRadius: 12,
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}>
          {m.text}
          <BubbleCopy copyText={m.text} />
        </div>
        <BubbleTime iso={m.iso} todayLabel={todayLabel} />
      </div>
    );
  }

  if (m.kind === "action") {
    return (
      <div className={wrapperClass} data-msg-id={m.id} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {/* Optional thought lead-in — italic Radley framed by curly
            quotes and a left divider. Always tethered to its action. */}
        {m.thought && (
          <div style={{
            color: "rgba(255,255,255,0.62)",
            fontFamily: "var(--font-radley)",
            fontSize: 13, lineHeight: 1.55, fontStyle: "italic",
            paddingLeft: 11,
            borderLeft: "1.5px solid rgba(255,255,255,0.12)",
          }}>
            <span aria-hidden style={{ marginRight: 2, color: "rgba(255,255,255,0.45)" }}>{"\u201C"}</span>
            {m.thought}
            <span aria-hidden style={{ marginLeft: 2, color: "rgba(255,255,255,0.45)" }}>{"\u201D"}</span>
          </div>
        )}
        {/* Header: chip + generic "Action submitted" title + tx hash. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {m.chip.type === "pair" ? (
            <PoolPairChip left={m.chip.left} right={m.chip.right} size={14} />
          ) : (
            <TokenChip entry={m.chip.token} size={14} radius={4} />
          )}
          <span style={{
            flex: 1, minWidth: 0,
            color: "rgba(255,255,255,0.92)",
            fontFamily: "var(--sans-stack)",
            fontSize: 12, fontWeight: 600,
            letterSpacing: "-0.005em",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {m.title}
          </span>
          <a
            href={`${TX_BASE_URL}${m.tx.replace(/…/g, "")}`}
            target="_blank"
            rel="noopener noreferrer"
            className="chat-tx-link"
            style={{
              display: "inline-flex", alignItems: "center", gap: 5,
              color: "rgba(255,255,255,0.55)",
              fontFamily: "var(--sans-stack)", fontSize: 10, fontWeight: 500,
              fontVariantNumeric: "tabular-nums",
              textDecoration: "none",
              flexShrink: 0,
              transition: "color 160ms ease",
            }}
          >
            {m.tx}
            <StrokeIcon kind="external" size={10} />
          </a>
        </div>
        {/* Body — static dot grid only on action bubbles */}
        <div style={{
          position: "relative",
          color: "rgba(255,255,255,0.92)",
          fontFamily: "var(--sans-stack)",
          fontSize: 12.5, lineHeight: 1.55, fontWeight: 400,
          padding: "10px 12px",
          borderRadius: 12,
          backgroundColor: "rgba(255,255,255,0.03)",
          backgroundImage: "radial-gradient(circle, rgba(255,255,255,0.10) 0.7px, transparent 1.1px)",
          backgroundSize: "9px 9px",
          border: "1px solid rgba(255,255,255,0.06)",
        }}>
          {m.text}
          <BubbleCopy copyText={m.thought ? `${m.thought}\n\n${m.text}` : m.text} />
        </div>
        <BubbleTime iso={m.iso} todayLabel={todayLabel} />
      </div>
    );
  }

  if (m.kind === "user") {
    return (
      <div className={wrapperClass} data-msg-id={m.id} style={{ display: "flex", flexDirection: "column", gap: 5, alignItems: "flex-end" }}>
        <div style={{
          position: "relative",
          maxWidth: "85%",
          color: "rgba(255,255,255,0.95)",
          fontFamily: "var(--sans-stack)",
          fontSize: 13, lineHeight: 1.5, fontWeight: 400,
          padding: "9px 12px",
          borderRadius: 12,
          background: "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.10)",
        }}>
          {m.text}
          <BubbleCopy copyText={m.text} />
        </div>
        <BubbleTime iso={m.iso} todayLabel={todayLabel} />
      </div>
    );
  }

  // reply — flat bubble, no dot grid (only actions get the grid bg)
  return (
    <div className={wrapperClass} data-msg-id={m.id} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      <div style={{
        position: "relative",
        color: "rgba(255,255,255,0.92)",
        fontFamily: "var(--sans-stack)",
        fontSize: 13, lineHeight: 1.5, fontWeight: 400,
        padding: "10px 12px",
        borderRadius: 12,
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}>
        {m.text}
        <BubbleCopy copyText={m.text} />
      </div>
      {m.sources && m.sources.length > 0 && (
        <div style={{
          padding: "9px 10px",
          borderRadius: 10,
          background: "rgba(255,255,255,0.02)",
          border: "1px solid rgba(255,255,255,0.06)",
          display: "flex", flexDirection: "column", gap: 6,
        }}>
          <div style={{ color: "rgba(255,255,255,0.45)", fontFamily: "var(--sans-stack)", fontSize: 10, fontWeight: 500, letterSpacing: "0.04em" }}>
            {m.sources.length} source{m.sources.length === 1 ? "" : "s"} found
          </div>
          {m.sources.map((s, i) => {
            // basescan tx → explorer URL; everything else uses an
            // explicit href (Uniswap pool page, vault detail, etc.)
            const href = s.tx ? `${TX_BASE_URL}${s.tx.replace(/…/g, "")}` : (s.href ?? "#");
            return (
              <a
                key={i}
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex", alignItems: "center", gap: 7,
                  color: "rgba(255,255,255,0.85)",
                  fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500,
                  textDecoration: "none",
                }}
              >
                <SourceIcon kind={s.kind} size={12} />
                {s.label}
                <StrokeIcon kind="external" size={10} />
              </a>
            );
          })}
        </div>
      )}
      <BubbleTime iso={m.iso} todayLabel={todayLabel} />
    </div>
  );
}

const WSS_URL = process.env.NEXT_PUBLIC_SHERPA_WSS_URL;
const IS_DEV_STUB = !WSS_URL;

/* ---------- Dashboard sidebar (left) ---------- */

const fmtUsd = (n: number) => {
  if (n === 0) return "$0";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: n < 1000 ? 2 : 0, maximumFractionDigits: n < 1000 ? 2 : 0 })}`;
};

const fmtPct = (n: number) => n === 0 ? "0%" : `${n.toFixed(1)}%`;

const CATEGORY_LABEL: Record<ActionCategory, string> = {
  swap: "Swap",
  edit_position: "Edit position",
  claim_fees: "Claim fees",
};

const ALPS_USERS = 247;

// Hover-interactive mini sparkline. Tooltip is portalled to <body>
// so it escapes the sidebar's overflow:hidden when it sits near the
// edge.
function MiniSparkline({ data, width = 60, height = 18, stroke = "rgba(255,255,255,0.85)", label, formatValue }: {
  data: number[]; width?: number; height?: number; stroke?: string;
  label?: string;
  formatValue?: (v: number) => string;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [tipPos, setTipPos] = useState<{ left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pts = data.map((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  const onMove = (e: React.MouseEvent<HTMLSpanElement>) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHoverIdx(Math.round(ratio * (data.length - 1)));
    setTipPos({ left: rect.left + rect.width / 2, top: rect.top });
  };

  const v = hoverIdx !== null ? data[hoverIdx] : null;
  const fmt = formatValue ?? ((x: number) => x.toFixed(2));

  return (
    <>
      <span
        ref={wrapRef}
        onMouseMove={onMove}
        onMouseLeave={() => { setHoverIdx(null); setTipPos(null); }}
        style={{ display: "inline-flex", flexShrink: 0, position: "relative", cursor: "default" }}
      >
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ display: "block" }}>
          <polyline points={pts} fill="none" stroke={stroke} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          {hoverIdx !== null && (
            <line x1={hoverIdx * stepX} y1={0} x2={hoverIdx * stepX} y2={height} stroke="rgba(255,255,255,0.30)" strokeWidth={1} />
          )}
        </svg>
      </span>
      {hoverIdx !== null && tipPos && v !== null && typeof document !== "undefined" && createPortal(
        <div style={{
          position: "fixed",
          left: tipPos.left,
          top: tipPos.top - 8,
          // translateZ forces a GPU compositor layer → integer-pixel
          // edges. The border becomes an inset box-shadow because
          // border + backdrop-filter on a translucent bg doubles up
          // antialiasing along the top edge.
          transform: "translate(-50%, -100%) translateZ(0)",
          background: "#15161b",
          boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)",
          borderRadius: 8,
          padding: "2px 8px",
          color: "#fff",
          fontFamily: "var(--sans-stack)",
          fontSize: 11, fontWeight: 500,
          lineHeight: 1.4,
          fontVariantNumeric: "tabular-nums",
          pointerEvents: "none",
          zIndex: 1000,
          whiteSpace: "nowrap",
        }}>
          {fmt(v)}
        </div>,
        document.body,
      )}
    </>
  );
}

function PoolChip({ p, size = 16 }: { p: PoolEntry; size?: number }) {
  if (p.pair) return <PoolPairChip left={p.pair.left} right={p.pair.right} size={size} />;
  if (p.single) return <TokenChip entry={p.single} size={size} radius={4} />;
  return null;
}

// Compact 3/4-circle gauge sized to fit a row of 5 across the
// dashboard sidebar. Smaller cousin of <Gauge>.
function DashGauge({ pct, color, chip }: { pct: number; color: string; chip: React.ReactNode }) {
  const SIZE = 44;
  const STROKE = 4;
  const r = (SIZE - STROKE) / 2;
  const c = 2 * Math.PI * r;
  const ARC_FRAC = 0.75;
  const trackLen = ARC_FRAC * c;
  const fillLen = Math.max(0, Math.min(trackLen, (pct / 100) * trackLen));
  return (
    <div style={{ position: "relative", width: SIZE, height: SIZE, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width={SIZE} height={SIZE} aria-hidden style={{ display: "block" }}>
        <circle cx={SIZE/2} cy={SIZE/2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={STROKE} strokeLinecap="round" strokeDasharray={`${trackLen} ${c-trackLen}`} transform={`rotate(135 ${SIZE/2} ${SIZE/2})`} />
        <circle cx={SIZE/2} cy={SIZE/2} r={r} fill="none" stroke={color} strokeWidth={STROKE} strokeLinecap="round" strokeDasharray={`${fillLen} ${c-fillLen}`} transform={`rotate(135 ${SIZE/2} ${SIZE/2})`} />
      </svg>
      <span aria-hidden style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, calc(-50% - 2px))", pointerEvents: "none" }}>
        {chip}
      </span>
    </div>
  );
}

// Shared grid-template so the Exposure header row + body rows align.
const EXPOSURE_GRID = "minmax(0, 1fr) 44px 44px 56px";

function ExposureRow({ p, dimmed }: { p: PoolEntry; dimmed: boolean }) {
  const apr = POOL_APR[p.slug] ?? 0;
  const earned = POOL_EARNED_30D[p.slug] ?? 0;
  const display = p.slug === "Idle reserve" ? "Reserve" : p.slug;
  const muted = "rgba(255,255,255,0.45)";
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: EXPOSURE_GRID,
      alignItems: "center",
      gap: 10,
      padding: "8px 10px",
      borderRadius: 10,
      background: "rgba(255,255,255,0.03)",
      border: "1px solid rgba(255,255,255,0.05)",
      opacity: dimmed ? 0.32 : 1,
      transition: "opacity 180ms ease",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <PoolChip p={p} size={16} />
        <span style={{
          color: "rgba(255,255,255,0.92)",
          fontFamily: "var(--sans-stack)", fontSize: 12, fontWeight: 500,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>
          {display}
        </span>
      </div>
      <span style={{ color: muted, fontSize: 11, fontFamily: "var(--sans-stack)", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
        {fmtPct(p.pct)}
      </span>
      <span style={{ color: apr === 0 ? muted : "rgba(255,255,255,0.92)", fontSize: 11, fontWeight: 500, fontFamily: "var(--sans-stack)", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
        {fmtPct(apr)}
      </span>
      <span style={{ color: earned === 0 ? muted : "rgba(255,255,255,0.85)", fontSize: 11, fontWeight: 500, fontFamily: "var(--sans-stack)", fontVariantNumeric: "tabular-nums", textAlign: "right" }}>
        {fmtUsd(earned)}
      </span>
    </div>
  );
}

// True if the pool has the given token slug somewhere in its make-up.
// USDC is in every pool, so hovering USDC's gauge keeps all rows lit.
function poolContainsToken(p: PoolEntry, slug: string | null): boolean {
  if (slug === null) return true;
  if (p.single) return p.single.slug === slug;
  if (p.pair) return p.pair.left.slug === slug || p.pair.right.slug === slug;
  return false;
}

// Compact action log — title + chip + tx + time. No body / thought /
// sources. Just the audit trail.
function ActionLogRow({ m }: { m: AgentMessage & { kind: "action" } }) {
  return (
    <a
      href={`${TX_BASE_URL}${m.tx.replace(/…/g, "")}`}
      target="_blank"
      rel="noopener noreferrer"
      className="chat-tx-link"
      style={{
        display: "grid",
        gridTemplateColumns: "auto minmax(0, 1fr) auto",
        alignItems: "center",
        gap: 8,
        padding: "7px 10px",
        borderRadius: 8,
        textDecoration: "none",
        color: "rgba(255,255,255,0.85)",
        background: "rgba(255,255,255,0.025)",
        border: "1px solid rgba(255,255,255,0.05)",
        transition: "background 160ms ease",
      }}
    >
      {m.chip.type === "pair"
        ? <PoolPairChip left={m.chip.left} right={m.chip.right} size={14} />
        : <TokenChip entry={m.chip.token} size={14} radius={4} />}
      <span style={{
        fontFamily: "var(--sans-stack)", fontSize: 11.5, fontWeight: 500,
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
      }}>
        {CATEGORY_LABEL[m.category]}
      </span>
      <span style={{
        color: "rgba(255,255,255,0.45)",
        fontFamily: "var(--sans-stack)", fontSize: 10, fontWeight: 500,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}>
        {m.iso.split(" · ")[1] ?? m.iso}
      </span>
    </a>
  );
}

// Inline value + label, same font size — `value` white-bold, `label`
// muted. Used for the TVL block's bottom row stats.
function DashStat({ value, label }: { value: string; label: string }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "baseline", gap: 5,
      fontFamily: "var(--sans-stack)", fontSize: 11,
      lineHeight: 1.1,
      whiteSpace: "nowrap",
    }}>
      <span style={{
        color: "rgba(255,255,255,0.92)", fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
      }}>
        {value}
      </span>
      <span style={{ color: "rgba(255,255,255,0.55)", fontWeight: 500 }}>
        {label}
      </span>
    </div>
  );
}

// Section heading row used between blocks. Lives inline with content,
// not a chrome bar — same family as the Exposure header row.
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      color: "#fff",
      fontFamily: "var(--sans-stack)", fontSize: 13, fontWeight: 600,
      letterSpacing: "-0.005em", lineHeight: 1,
    }}>
      {children}
    </div>
  );
}

function DashboardPanel() {
  const recentActions = INITIAL_WIRE_MESSAGES
    .filter((m): m is Extract<WireMessage, { kind: "action" }> => m.kind === "action")
    .slice(-6)
    .reverse()
    .map((w) => toAgentMessage(w))
    .filter((m): m is AgentMessage & { kind: "action" } => m.kind === "action");

  const tvl = TVL_30D[TVL_30D.length - 1] ?? 3.26;
  const activePools = POOLS.filter((p) => p.slug !== "Idle reserve").length;
  const [hoveredToken, setHoveredToken] = useState<string | null>(null);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Fixed top — everything but the Recent actions list itself.
          Mirrors Sherpa: only the bottom feed scrolls. */}
      <div style={{
        flexShrink: 0,
        padding: "16px 14px 0",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        {/* TVL + vault metrics — full-width hero */}
        <div style={{
          display: "flex", flexDirection: "column", gap: 10,
          padding: "13px 14px 12px",
          borderRadius: 12,
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.06)",
        }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div>
              <div style={{ color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500 }}>
                Vault TVL
              </div>
              <div style={{ marginTop: 4, color: "#fff", fontFamily: "var(--sans-stack)", fontSize: 22, fontWeight: 600, lineHeight: 1, letterSpacing: "-0.015em", fontVariantNumeric: "tabular-nums" }}>
                ${tvl.toFixed(2)}M
              </div>
            </div>
            <MiniSparkline data={TVL_30D} width={80} height={24} label="TVL" formatValue={(v) => `$${v.toFixed(2)}M`} />
          </div>
          {/* Bottom row: 3 stats inline with equal gaps between them
              via space-between. */}
          <div style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 8,
            paddingTop: 10,
            borderTop: "1px solid rgba(255,255,255,0.05)",
          }}>
            <DashStat value={fmtUsd(BASKET_EARNED_30D)} label="fees earned" />
            <DashStat value={String(activePools)} label="active pools" />
            <DashStat value={String(ALPS_USERS)} label="users" />
          </div>
        </div>

        {/* Yield (left) + Share Price (right) */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div style={{
            padding: "11px 12px 10px",
            borderRadius: 12,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.06)",
          }}>
            <div style={{ color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500 }}>
              Current yield
            </div>
            <div style={{ marginTop: 5, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ color: "rgb(134, 239, 172)", fontFamily: "var(--sans-stack)", fontSize: 18, fontWeight: 600, lineHeight: 1, letterSpacing: "-0.01em", fontVariantNumeric: "tabular-nums" }}>
                {fmtPct(BASKET_APR_30D)}
              </span>
              <MiniSparkline data={APR_30D} width={56} height={18} stroke="rgba(134, 239, 172, 0.85)" label="Yield" formatValue={(v) => `${v.toFixed(1)}%`} />
            </div>
          </div>
          <div style={{
            padding: "11px 12px 10px",
            borderRadius: 12,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.06)",
          }}>
            <div style={{ color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500 }}>
              Share price
            </div>
            <div style={{ marginTop: 5, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ color: "#fff", fontFamily: "var(--sans-stack)", fontSize: 18, fontWeight: 600, lineHeight: 1, letterSpacing: "-0.01em", fontVariantNumeric: "tabular-nums" }}>
                {fmtNum(SHARE_PRICE)}
              </span>
              <MiniSparkline data={SHARE_PRICE_30D} width={56} height={18} label="Share price" formatValue={(v) => `$${v.toFixed(4)}`} />
            </div>
          </div>
        </div>

        {/* Exposure — section title, gauges (by token), legend, table */}
        <div style={{ display: "flex", flexDirection: "column", marginTop: 8 }}>
          <div style={{ padding: "0 10px", marginBottom: 8 }}>
            <SectionTitle>Exposure</SectionTitle>
          </div>
          {/* Gauges by TOKEN. No container chrome; tighter spacing.
              Hovering a gauge lights its token's exposure rows. */}
          <div style={{
            display: "flex", alignItems: "center", gap: 16,
            padding: "4px 6px 12px",
          }}>
            {ALLOCATIONS.map((a) => (
              <span
                key={a.slug}
                onMouseEnter={() => setHoveredToken(a.slug)}
                onMouseLeave={() => setHoveredToken(null)}
                style={{ display: "inline-flex", cursor: "default" }}
              >
                <DashGauge
                  pct={a.pct}
                  color={a.color}
                  chip={<TokenChip entry={a} size={16} radius={4} />}
                />
              </span>
            ))}
          </div>
          <div style={{
            display: "grid",
            gridTemplateColumns: EXPOSURE_GRID,
            alignItems: "center",
            gap: 10,
            padding: "0 10px",
            marginBottom: 2,
            color: "rgba(255,255,255,0.45)",
            fontFamily: "var(--sans-stack)", fontSize: 10.5, fontWeight: 500,
          }}>
            <span>Assets</span>
            <span style={{ textAlign: "right" }}>Share</span>
            <span style={{ textAlign: "right" }}>Yield</span>
            <span style={{ textAlign: "right" }}>Fees</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {POSITIONS_SORTED.map((p) => (
              <ExposureRow
                key={p.slug}
                p={p}
                dimmed={!poolContainsToken(p, hoveredToken)}
              />
            ))}
          </div>
        </div>

        <div style={{ marginTop: 8, padding: "0 10px" }}>
          <SectionTitle>Recent actions</SectionTitle>
        </div>
      </div>

      {/* Only the action log scrolls. Equal top + bottom padding so
          the first/last item never touches the scroll edge regardless
          of scroll position. */}
      <div className="panel-scroll" style={{
        flex: 1, minHeight: 0,
        overflowY: "auto", overflowX: "hidden",
        padding: "12px 14px 16px",
        display: "flex", flexDirection: "column", gap: 4,
      }}>
        {recentActions.map((m) => <ActionLogRow key={m.id} m={m} />)}
      </div>
    </div>
  );
}

function AgentChatPanel() {
  // Dev stub: seed synchronously to avoid first-paint flicker.
  // Real backend: start empty, populate via `onHistory`.
  const [messages, setMessages] = useState<AgentMessage[]>(() =>
    IS_DEV_STUB ? INITIAL_WIRE_MESSAGES.map(toAgentMessage) : []
  );
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const didInitialScroll = useRef(false);
  const streamRef = useRef<StreamHandle | null>(null);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || didInitialScroll.current) return;
    el.scrollTop = el.scrollHeight;
    didInitialScroll.current = true;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !didInitialScroll.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, thinking]);

  useEffect(() => {
    if (streamRef.current) return; // StrictMode guard
    streamRef.current = subscribeAgentStream({
      url: WSS_URL,
      onHistory: (events) => {
        setMessages(events.map(toAgentMessage));
      },
      onEvent: (e) => {
        setMessages((prev) => {
          // Dedupe by id — server echo of an optimistic user msg
          // arrives with the same id we issued.
          if (prev.some((m) => m.id === e.id)) return prev;
          return [...prev, toAgentMessage(e)];
        });
        // Any reply landing means the agent's done thinking.
        if (e.kind === "reply") setThinking(false);
      },
    });
    return () => { streamRef.current?.close(); streamRef.current = null; };
  }, []);

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || thinking) return;
    const cid = clientId();
    const wireUser: WireMessage = {
      id: cid,
      ts: new Date().toISOString(),
      kind: "user",
      text,
    };
    setMessages((prev) => [...prev, toAgentMessage(wireUser)]);
    streamRef.current?.send({ v: 1, type: "user_message", text, clientId: cid });
    setInput("");
    setThinking(true);
    // Real backend emits the reply via `onEvent`; only the dev stub
    // synthesizes locally.
    if (IS_DEV_STUB) {
      window.setTimeout(() => {
        const reply = getAgentReply(text);
        const wireReply: WireMessage = {
          id: `r_${Date.now().toString(36)}`,
          ts: new Date().toISOString(),
          kind: "reply",
          text: reply.text,
          sources: reply.sources,
          replyTo: cid,
        };
        setMessages((prev) => [...prev, toAgentMessage(wireReply)]);
        setThinking(false);
      }, 1500);
    }
  };

  // Bar-click → scroll to the first signal/action message in that
  // hour and flash for 2s. Tracks by message id so live events
  // arriving mid-flash don't shift the highlight.
  const [flashId, setFlashId] = useState<string | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const flashStartRef = useRef<number | null>(null);
  const handleSelectHour = (hour: number) => {
    const target = messages.find((m) =>
      (m.kind === "signal" || m.kind === "action") && parseHour(m.iso) === hour
    );
    if (!target) return;
    const container = scrollRef.current;
    if (container) {
      const el = container.querySelector<HTMLElement>(`[data-msg-id="${target.id}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    if (flashTimerRef.current !== null) { window.clearTimeout(flashTimerRef.current); flashTimerRef.current = null; }
    if (flashStartRef.current !== null) { window.clearTimeout(flashStartRef.current); flashStartRef.current = null; }
    setFlashId(null);
    flashStartRef.current = window.setTimeout(() => {
      setFlashId(target.id);
      flashStartRef.current = null;
      flashTimerRef.current = window.setTimeout(() => {
        setFlashId(null);
        flashTimerRef.current = null;
      }, 2000);
    }, 250);
  };

  // Date shown at the top of the feed — the date of the most recent
  // (last) message. Re-derives whenever the feed updates.
  const topDate = messages.length > 0 ? messages[messages.length - 1].iso.split(" · ")[0] : "Today";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header */}
      <div style={{
        flexShrink: 0,
        display: "flex", alignItems: "center", gap: 10,
        padding: "14px 14px 12px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}>
        <div aria-hidden style={{
          width: 32, height: 32, borderRadius: 8,
          background: "rgba(255,255,255,0.06)",
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          <span aria-hidden style={{ display: "block", width: 18, height: 18, ...MASK_STYLE }} />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ color: "#fff", fontFamily: "var(--sans-stack)", fontSize: 13, fontWeight: 600, letterSpacing: "-0.005em", lineHeight: 1 }}>
            Sherpa
          </div>
          {/* Histogram floats free in the header — no chrome around
              it, so the bars sit directly on the panel background.
              Keeps the same 32px height + horizontal padding for
              vertical alignment with the avatar on the left. */}
          <div style={{
            marginLeft: "auto",
            height: 32,
            padding: "0 10px",
            display: "inline-flex", alignItems: "center",
            flexShrink: 0,
          }}>
            <ActivityHistogram messages={messages} onSelectHour={handleSelectHour} />
          </div>
        </div>
      </div>

      {/* Messages feed */}
      <div ref={scrollRef} className="panel-scroll" style={{
        flex: 1, minHeight: 0,
        overflowY: "auto", overflowX: "hidden",
        padding: "14px 14px 12px",
        display: "flex", flexDirection: "column", gap: 16,
      }}>
        {/* Date label — date of the latest message in the feed */}
        <div style={{
          color: "rgba(255,255,255,0.40)",
          fontFamily: "var(--sans-stack)",
          fontSize: 10, fontWeight: 500,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          textAlign: "center",
          flexShrink: 0,
        }}>
          {topDate}
        </div>
        {messages.map((m) => (
          <MessageView key={m.id} m={m} todayLabel={topDate} flash={flashId === m.id} />
        ))}
        {thinking && (
          <div style={{ display: "flex", alignItems: "center", gap: 9, paddingLeft: 2 }}>
            <ThinkingMark size={22} />
            <span style={{ color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 12, fontStyle: "italic" }}>
              thinking…
            </span>
          </div>
        )}
      </div>

      {/* Input */}
      <form
        onSubmit={handleSend}
        style={{
          flexShrink: 0,
          padding: "10px 12px 12px",
          borderTop: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: "5px 5px 5px 14px",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.10)",
          borderRadius: 999,
        }}>
          <input
            type="text"
            placeholder="How can I help you?"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={thinking}
            style={{
              flex: 1, minWidth: 0,
              height: 28,
              background: "transparent", border: "none", outline: "none",
              color: "#fff",
              fontFamily: "var(--sans-stack)", fontSize: 13, fontWeight: 400,
              lineHeight: "28px",
              padding: 0,
            }}
          />
          <button
            type="submit"
            disabled={thinking || !input.trim()}
            aria-label="Send"
            style={{
              flexShrink: 0,
              width: 26, height: 26, borderRadius: "50%",
              background: input.trim() && !thinking ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.06)",
              border: "none",
              color: input.trim() && !thinking ? "#fff" : "rgba(255,255,255,0.35)",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              transition: "background 200ms ease, color 200ms ease",
            }}
          >
            <StrokeIcon kind="arrow" size={12} />
          </button>
        </div>
      </form>
    </div>
  );
}

/* ---------- Sidebar tab switcher ---------- */

// Pill that sits above the right sidebar, inline with the floating
// nav above the main panel. Two tabs swap the sidebar content
// between Sherpa (agent chat) and the vault stats dashboard.
//
// Positioned in viewport space (matches the sidebar below it).
// Height + every interior dimension scale with --shell-scale so
// the pill stays visually identical to the nav (which scales
// because it lives inside the canvas) at every viewport. Bottom
// edge sits 14*scale px above the panel — the same offset the nav
// uses on the other side — so the two chrome strips share both a
// baseline AND a height at every scale.
function SidebarTabs({
  tab, onChange, exiting, agentUnread,
}: {
  tab: SidebarTab;
  onChange: (t: SidebarTab) => void;
  exiting: boolean;
  agentUnread: number;
}) {
  const animClass = exiting ? "app-sidebar-tab-exit" : "app-sidebar-tab-enter";
  return (
    <div className={animClass} style={{
      position: "fixed",
      left: "var(--sidebar-left)",
      width: "var(--sidebar-w)",
      top: `calc(var(--panel-top) - 14px * var(--shell-scale) - ${NAV_DESIGN_HEIGHT}px * var(--shell-scale))`,
      height: `calc(${NAV_DESIGN_HEIGHT}px * var(--shell-scale))`,
      // zIndex: 1 keeps the tabs behind the canvas (z=2) so the
      // slide-in animation reads as "unrolling from behind the panel".
      zIndex: 1,
    }}>
      <div style={{
        position: "relative",
        height: "100%",
        borderRadius: "calc(20px * var(--shell-scale))",
        overflow: "hidden",
        border: "1px solid rgba(255,255,255,0.08)",
        background: "#0c0c10",
        display: "flex",
        alignItems: "stretch",
        // Inset matches the FloatingNav's vertical padding (8px) so
        // the active button bg has the same breathing room from the
        // pill border that the Connect-wallet button has from the
        // nav border. Tab-button gap stays small for tight pairing.
        padding: "calc(8px * var(--shell-scale))",
        gap: "calc(4px * var(--shell-scale))",
        isolation: "isolate",
      }}>
        <SidebarTabButton active={tab === "stats"} onClick={() => onChange("stats")}>Stats</SidebarTabButton>
        <SidebarTabButton
          active={tab === "agent"}
          onClick={() => onChange("agent")}
          badge={agentUnread > 0 ? <UnreadBadge count={agentUnread} /> : undefined}
        >
          Agent
        </SidebarTabButton>
      </div>
    </div>
  );
}

function SidebarTabButton({
  active, onClick, badge, children,
}: {
  active: boolean;
  onClick: () => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="transition-colors duration-200 ease-out"
      style={{
        flex: 1,
        background: active ? "rgba(255,255,255,0.10)" : "transparent",
        color: active ? "#fff" : "rgba(255,255,255,0.55)",
        border: "none",
        borderRadius: "calc(14px * var(--shell-scale))",
        fontFamily: "var(--sans-stack)",
        fontSize: "calc(12px * var(--shell-scale))",
        fontWeight: 600,
        letterSpacing: "-0.005em",
        lineHeight: 1,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "calc(7px * var(--shell-scale))",
      }}
    >
      <span>{children}</span>
      {badge}
    </button>
  );
}

// Unread-message indicator on the Agent tab. A small red dot —
// no count, no chrome. Sits inline in the SidebarTabButton flex
// row (alignItems:center) so it center-aligns with the "Agent"
// text glyph cap-height naturally, no transform tweaks.
function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} unread`}
      style={{
        width: "calc(5px * var(--shell-scale))",
        height: "calc(5px * var(--shell-scale))",
        borderRadius: 999,
        background: "#ef4444",
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

/* ---------- Footer ---------- */

// Slim strip rendered BELOW the main panel (outside its rounded
// borders). Left button is a 1:1 copy of landing-face's HowItWorks
// chip (text + 16×16 white-10 square wrapping a 10px arrow). Right
// edge holds the vault link + version, same chip style as landing's
// BuiltWith.
function FooterStrip({
  left, top, width, showHowItWorks, onToggleHowItWorks,
}: {
  left: number; top: number; width: number;
  showHowItWorks: boolean;
  onToggleHowItWorks: () => void;
}) {
  return (
    <div style={{
      position: "absolute",
      left, top, width,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      gap: 16,
      pointerEvents: "auto",
      zIndex: 3,
    }}>
      <button
        type="button"
        onClick={onToggleHowItWorks}
        aria-label={showHowItWorks ? "Back to dashboard" : "How it works"}
        className="text-haze transition-colors hover:text-mist"
        style={{
          background: "transparent", border: "none", padding: 0,
          fontFamily: "var(--sans-stack)", fontSize: 12,
          display: "inline-flex", alignItems: "center", gap: 6,
          cursor: "pointer",
        }}
      >
        {showHowItWorks && (
          <span
            className="inline-flex items-center justify-center bg-white/10"
            style={{ width: 16, height: 16, borderRadius: 4, position: "relative", top: "1px" }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              style={{ display: "block", marginLeft: "1px", transform: "rotate(180deg)" }}
            >
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </span>
        )}
        <span>{showHowItWorks ? "Back" : "How it works?"}</span>
        {!showHowItWorks && (
          <span
            className="inline-flex items-center justify-center bg-white/10"
            style={{ width: 16, height: 16, borderRadius: 4, position: "relative", top: "1px" }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              style={{ display: "block", marginLeft: "-1px" }}
            >
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </span>
        )}
      </button>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 14 }}>
        <a
          href="#"
          className="text-haze transition-colors hover:text-mist"
          style={{
            textDecoration: "none",
            fontFamily: "var(--sans-stack)", fontSize: 12,
            display: "inline-flex", alignItems: "center", gap: 6,
          }}
        >
          <span>Vault: 0xA1b2…f9c8</span>
          <span
            className="inline-flex items-center justify-center bg-white/10"
            style={{ width: 16, height: 16, borderRadius: 4, position: "relative", top: "1px" }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
              style={{ display: "block" }}
            >
              <path d="M14 4h6v6" />
              <path d="M20 4l-9 9" />
              <path d="M19 13v6H5V5h6" />
            </svg>
          </span>
        </a>
        <span style={{ color: "rgba(255,255,255,0.45)", fontFamily: "var(--sans-stack)", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>v0.0.1</span>
      </span>
    </div>
  );
}


/* ---------- Page ---------- */

export default function AppPage() {
  const router = useRouter();
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [showHowItWorks, setShowHowItWorks] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("stats");
  // Mock unread count for the Agent tab. Real backend: bump on
  // incoming WireMessage, but always after we know the user isn't
  // already on the Agent tab. Cleared the moment the user opens the
  // Agent panel so the badge feels reactive instead of sticky.
  const [agentUnread, setAgentUnread] = useState(3);
  useEffect(() => {
    if (sidebarTab === "agent" && agentUnread !== 0) setAgentUnread(0);
  }, [sidebarTab, agentUnread]);

  // When the user clicks the alps logo in the floating nav, kick the
  // exit animation off (canvas/sidebar/tab pull back first, then the
  // nav drops 420ms later — mirror of the entry stagger) and delay
  // router.push so the staggered choreography actually plays out
  // instead of getting cut by a fast cached route swap. 760ms gives
  // the first beat room to settle before the route changes; the nav
  // drop continues into the landing's lockup-enter, blending the two.
  const handleBack = () => {
    if (exiting) return;
    setExiting(true);
    window.setTimeout(() => router.push("/"), 760);
  };

  const enterClass = exiting ? "app-bento-exit" : "app-bento-enter";
  const rightSidebarClass = exiting ? "app-sidebar-right-exit" : "app-sidebar-right-enter";
  const footerClass = exiting ? "app-footer-exit" : "app-footer-enter";
  const canvasClass = exiting ? "app-canvas-exit" : "app-canvas-enter";

  return (
    <main
      className="fixed inset-0 overflow-hidden"
      style={{
        background: "transparent",
        color: "#fff",
        isolation: "isolate",
        // Override the global --panel-left/right (which centers the
        // panel on landing) so /app centers the panel + sidebar
        // combo instead. The override only propagates to descendants
        // of this <main>, so PersistentBackdrop (sibling in
        // layout.tsx) keeps the centered panel position on landing.
        ["--panel-left" as string]: "calc((100vw - var(--combo-w)) / 2)",
        ["--panel-right" as string]: "calc(var(--panel-left) + var(--panel-w))",
        ["--sidebar-left" as string]: "calc(var(--panel-right) + var(--sidebar-gap))",
      } as React.CSSProperties}
    >
      {/* Scaled canvas == the main panel rect itself, sized to match
          the landing page's panel exactly. Nav above and footer
          below ride this same transform; sidebars deliberately do
          NOT (they live in viewport space, see below). z-index keeps
          this canvas (with the opaque main panel inside) layered
          above the sidebars so the sidebar enter/exit animations
          read as "unrolling from behind the panel".

          Position-wise the canvas is anchored at the combo-centered
          --panel-left/--panel-top (top-left transform origin so the
          scaled box lands exactly on those vars). On entry the canvas
          slides leftward from landing's centered position to its
          combo-centered resting spot — the same easing/duration as
          the sidebar emerging from behind it, so the two reads as
          one motion: the panel makes room while the sidebar fills
          it. */}
      <div className={canvasClass} style={{
        width: PANEL_W,
        height: PANEL_H,
        position: "fixed",
        left: "var(--panel-left)",
        top: "var(--panel-top)",
        transform: "scale(var(--shell-scale))",
        transformOrigin: "top left",
        flexShrink: 0,
        zIndex: 2,
      }}>
      <style>{`
        .panel-scroll { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.10) transparent; }
        .panel-scroll::-webkit-scrollbar { width: 8px; }
        .panel-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.10); border-radius: 999px; }
        .panel-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.18); }
        .panel-scroll::-webkit-scrollbar-track { background: transparent; }

        /* Nav slides up from BEHIND the main panel (covered by the
           panel's higher z-index) to its resting spot 14px above.
           Entry is the FIRST beat (no delay); exit is the SECOND
           beat (420ms delay) so the choreography mirrors. Total
           per-direction duration: 1180ms (420 delay + 760 anim). */
        @keyframes app-nav-enter {
          from { transform: translateY(34px); opacity: 1; }
          to   { transform: translateY(-100%); opacity: 1; }
        }
        .app-nav-enter { animation: app-nav-enter 760ms cubic-bezier(0.16, 1, 0.3, 1) both; }

        @keyframes app-nav-exit {
          from { transform: translateY(-100%); opacity: 1; }
          to   { transform: translateY(34px); opacity: 1; }
        }
        /* 'both' (not 'forwards') so the keyframe's "from" state
           holds through the 420ms delay — without it, the moment
           the class swaps from app-nav-enter the nav reverts to its
           base translateY(0) position (partially behind the panel)
           for the duration of the delay, then snaps back up to the
           keyframe's "from" translateY(-100%) when the animation
           actually starts. That was the disappear-reappear flicker. */
        .app-nav-exit { animation: app-nav-exit 760ms cubic-bezier(0.16, 1, 0.3, 1) 420ms both; }

        /* Right sidebar — slides out from behind the main panel on
           entry (translated INTO the main-panel area initially, then
           rightward to resting). Entry has the SECOND-beat 420ms
           delay so it pairs with the canvas slide; exit fires in the
           FIRST beat with no delay, so the symmetric reverse plays:
           sidebar/canvas first, nav second. The sidebar's resting
           position is exactly the panel's vertical extent, so the
           panel (z=2 inside canvas) hides it during the delay even
           without an opacity fade — pure z-stacking handles it. */
        @keyframes app-sidebar-right-enter {
          from { transform: translateX(calc(-100% - 14px)); }
          to   { transform: translateX(0); }
        }
        .app-sidebar-right-enter { animation: app-sidebar-right-enter 760ms cubic-bezier(0.16, 1, 0.3, 1) 420ms both; }

        @keyframes app-sidebar-right-exit {
          from { transform: translateX(0); }
          to   { transform: translateX(calc(-100% - 14px)); }
        }
        .app-sidebar-right-exit { animation: app-sidebar-right-exit 760ms cubic-bezier(0.16, 1, 0.3, 1) forwards; }

        /* Sidebar TAB pill — same horizontal slide as the sidebar
           below it, but the tab sits ABOVE the panel (at the nav's
           y) so z-stacking can't hide it the way it hides the
           sidebar. We add an opacity fade to the keyframes: tab is
           invisible during the nav-only first beat, then fades in as
           it slides out from behind the panel. Without this, the tab
           would flash at its resting spot during the delay (the user
           caught this on entry; same fix prevents it from lingering
           after the panel slides back on exit). */
        @keyframes app-sidebar-tab-enter {
          from { transform: translateX(calc(-100% - 14px)); opacity: 0; }
          to   { transform: translateX(0); opacity: 1; }
        }
        .app-sidebar-tab-enter { animation: app-sidebar-tab-enter 760ms cubic-bezier(0.16, 1, 0.3, 1) 420ms both; }

        @keyframes app-sidebar-tab-exit {
          from { transform: translateX(0); opacity: 1; }
          to   { transform: translateX(calc(-100% - 14px)); opacity: 0; }
        }
        .app-sidebar-tab-exit { animation: app-sidebar-tab-exit 760ms cubic-bezier(0.16, 1, 0.3, 1) forwards; }

        /* Canvas slide. The canvas's resting position is combo-centered
           (panel left of viewport center to make room for the sidebar);
           landing leaves the panel screen-centered. On entry we start
           the canvas at +canvas-shift (= landing's centered position)
           and glide it back to 0 (= combo-centered) in lockstep with
           the sidebar emerging from behind it. The composite read is:
           panel makes room, sidebar fills it, as a single motion.
           Same 420ms entry delay as the sidebar so the two paired
           movements fire as one beat after the nav has settled. On
           exit no delay — canvas + sidebar move together first,
           then the nav drops, mirroring the entry sequence in
           reverse. Scale is repeated in both keyframes since
           transform is one property — interpolating translate alone
           requires the scale component to be present at both
           endpoints. */
        @keyframes app-canvas-enter {
          from { transform: translateX(var(--canvas-shift)) scale(var(--shell-scale)); }
          to   { transform: translateX(0) scale(var(--shell-scale)); }
        }
        .app-canvas-enter { animation: app-canvas-enter 760ms cubic-bezier(0.16, 1, 0.3, 1) 420ms both; }

        @keyframes app-canvas-exit {
          from { transform: translateX(0) scale(var(--shell-scale)); }
          to   { transform: translateX(var(--canvas-shift)) scale(var(--shell-scale)); }
        }
        .app-canvas-exit { animation: app-canvas-exit 760ms cubic-bezier(0.16, 1, 0.3, 1) forwards; }

        /* Snappy staggered fade for bento items. Pure opacity (no
           transform) so the wrapper doesn't create a stacking
           context that swallows backdrop-filter on inner Cards. */
        @keyframes app-bento-enter {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        .app-bento-enter { animation: app-bento-enter 380ms cubic-bezier(0.16, 1, 0.3, 1) both; }

        @keyframes app-bento-exit {
          from { opacity: 1; }
          to   { opacity: 0; }
        }
        .app-bento-exit { animation: app-bento-exit 280ms cubic-bezier(0.4, 0, 1, 1) forwards; }

        /* Footer strip — fades in/out behind the main panel just
           like the nav, only vertical instead. */
        @keyframes app-footer-enter {
          from { opacity: 0; transform: translateY(-8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .app-footer-enter { animation: app-footer-enter 600ms cubic-bezier(0.16, 1, 0.3, 1) both; animation-delay: 200ms; }

        @keyframes app-footer-exit {
          from { opacity: 1; transform: translateY(0); }
          to   { opacity: 0; transform: translateY(-8px); }
        }
        .app-footer-exit { animation: app-footer-exit 280ms cubic-bezier(0.4, 0, 1, 1) forwards; }

        /* Agent thinking indicator — 5 streaks above the alps mountain
           fade in one-by-one then together fade out, looping. */
        @keyframes thinking-streak {
          0%, 8%   { opacity: 0; }
          30%, 80% { opacity: 1; }
          100%     { opacity: 0; }
        }
        .thinking-streak { opacity: 0; animation: thinking-streak 2.4s ease-in-out infinite; }
        .thinking-streak.streak-1 { animation-delay: 0ms; }
        .thinking-streak.streak-2 { animation-delay: 140ms; }
        .thinking-streak.streak-3 { animation-delay: 280ms; }
        .thinking-streak.streak-4 { animation-delay: 420ms; }
        .thinking-streak.streak-5 { animation-delay: 560ms; }

        /* Message hover affordances. Copy button sits absolute inside
           the body bubble's top-right; time sits absolute just below
           the bubble. Both are hidden by default with no reserved
           space, and just fade in on .chat-msg:hover.
           On hover we also add an adaptive bottom margin (transition
           in concert with the time fade) so the timestamp doesn't
           crowd the next message. The transition makes neighbours
           glide rather than jump. */
        .chat-msg { position: relative; transition: margin-bottom 200ms ease; }
        .chat-msg:hover { margin-bottom: 14px; }
        .chat-msg-copy { opacity: 0; transition: opacity 160ms ease, background 180ms ease; }
        .chat-msg-time { opacity: 0; transition: opacity 160ms ease; }
        .chat-msg:hover .chat-msg-copy,
        .chat-msg:hover .chat-msg-time { opacity: 1; }
        .chat-msg-copy:hover { background: rgba(255,255,255,0.18) !important; }

        /* Tx hash link in the action header — brighten both text and
           the trailing arrow icon together on hover. */
        .chat-tx-link:hover { color: rgba(255,255,255,0.95) !important; }

        /* "Now" bar in the activity histogram — slow opacity pulse so
           the rightmost (current hour) bar reads as live. */
        @keyframes histo-now {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0.55; }
        }
        .histo-now { animation: histo-now 2.2s ease-in-out infinite; }

        /* Flash highlight applied to a chat-msg when its hour is
           clicked in the histogram. Quick fade-in to a soft white
           wash, then 2s decay back to transparent. */
        @keyframes chat-msg-flash {
          0%   { background-color: rgba(255,255,255,0.00); }
          12%  { background-color: rgba(255,255,255,0.07); }
          100% { background-color: rgba(255,255,255,0.00); }
        }
        .chat-msg-flash {
          animation: chat-msg-flash 2s ease-out forwards;
          border-radius: 12px;
        }

        /* Withdraw modal entry — backdrop fade + dialog scale. */
        @keyframes withdraw-fade {
          from { opacity: 0; }
          to   { opacity: 1; }
        }
        @keyframes withdraw-pop {
          from { opacity: 0; transform: scale(0.98); }
          to   { opacity: 1; transform: scale(1); }
        }
      `}</style>

      <FloatingNav layout={MAIN_PANEL} exiting={exiting} onBack={handleBack} />

      {/* Main panel — fills the canvas exactly. */}
      <section style={{
          position: "absolute",
          left: 0, top: 0, width: PANEL_W, height: PANEL_H,
          borderRadius: 20,
          overflow: "hidden",
          display: "flex", flexDirection: "column",
          isolation: "isolate",
          zIndex: 2,
        }}>
          <PanelLandscape muted={showHowItWorks} />
          <div className="panel-scroll" style={{
            flex: 1, minHeight: 0,
            overflowY: "auto", overflowX: "hidden",
          }}>
            <div style={{ padding: "26px 28px 28px", height: "100%", display: "flex", flexDirection: "column" }}>
              {showHowItWorks ? (
                <LearnMoreContent open={true} inline />
              ) : (
                // 4-row × 3-col bento, sized to fill the panel:
                //   row 1: Hero title (col 1)         | Placeholder upper (cols 2-3)
                //   row 2: Summary card (col 1)       | Placeholder lower (cols 2-3)
                //   row 3: Vault upper (col 1, span)  | Position (col 2) | Performance (col 3)
                //   row 4: Vault lower (col 1, span)  | Activity (cols 2-3)
                // Col 1 is wider so the Summary's prose fits comfortably.
                // 4-row × 3-col bento (hero title dropped):
                //   row 1: Vault (col 1, spans rows 1-3)   | Placeholder (cols 2-3)
                //   row 2: Vault (continues)               | Position | Performance
                //   row 3: Vault (continues)               | Activity (cols 2-3, spans rows 3-4)
                //   row 4: Summary text (col 1)            | Activity (continues)
                <div style={{
                  display: "grid",
                  gridTemplateColumns: "1.45fr 1fr 1fr",
                  gridTemplateRows: "1fr 1fr 1fr 1fr",
                  gap: 14,
                  height: "100%",
                  alignItems: "stretch",
                }}>
                  <div className={enterClass} style={{ animationDelay: exiting ? "0ms" : "180ms", gridColumn: "1", gridRow: "1 / 4", display: "flex", flexDirection: "column" }}>
                    <VaultCard />
                  </div>
                  <div className={enterClass} style={{ animationDelay: exiting ? "20ms" : "240ms", gridColumn: "2", gridRow: "1", display: "flex", flexDirection: "column" }}>
                    <UserPositionCard onWithdraw={() => setWithdrawOpen(true)} />
                  </div>
                  <div className={enterClass} style={{ animationDelay: exiting ? "40ms" : "300ms", gridColumn: "3", gridRow: "1", display: "flex", flexDirection: "column" }}>
                    <UserAprCard />
                  </div>
                  <div className={enterClass} style={{ animationDelay: exiting ? "60ms" : "360ms", gridColumn: "2 / 4", gridRow: "2 / 4", display: "flex", flexDirection: "column" }}>
                    <UserActivityCard />
                  </div>
                  {/* No entry animation on this segment — animating
                      opacity on the Card or any ancestor leaves a
                      compositor layer that prevents backdrop-filter
                      from sampling the panel landscape. Static is
                      the price for the blur to stay live.
                      Exit, however, uses a binary visibility flip
                      (no transition) so the segment disappears with
                      the rest of the bento — no slow fade required,
                      and no compositor layer because there's no
                      animation, so the blur stays intact while
                      visible. */}
                  <div style={{
                    gridColumn: "1", gridRow: "4",
                    display: "flex", flexDirection: "column",
                    visibility: exiting ? "hidden" : "visible",
                  }}>
                    <Card style={{
                      display: "flex", alignItems: "center", height: "100%",
                      backdropFilter: "blur(24px)",
                      WebkitBackdropFilter: "blur(24px)",
                    }}>
                      <SummaryText />
                    </Card>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Withdraw modal lives INSIDE the panel section so its
              backdrop-filter only blurs the panel's own contents —
              the sidebar/tabs/nav (siblings outside the section)
              stay sharp. The section already has overflow:hidden,
              so the modal is naturally clipped to the panel rect. */}
          {withdrawOpen && <WithdrawModal onClose={() => setWithdrawOpen(false)} />}
        </section>

      {/* Bottom strip — sits 12 design-px below the panel, inside the
          scaled canvas so it tracks the panel's width and scale. */}
      <div className={footerClass}>
        <FooterStrip
          left={0}
          width={PANEL_W}
          top={PANEL_H + 12}
          showHowItWorks={showHowItWorks}
          onToggleHowItWorks={() => setShowHowItWorks((v) => !v)}
        />
      </div>

      </div>

      {/* Right sidebar + its tab switcher above. Both live in
          viewport space (NOT scaled by --shell-scale) but anchor to
          --sidebar-left / --sidebar-w, so they sit one fixed gap
          right of the (combo-centered) panel and hold a stable
          design width. zIndex: 1 keeps them behind the canvas (z=2),
          which is what the slide-in animation expects — they
          "unroll from behind the panel". */}
      <SidebarTabs tab={sidebarTab} onChange={setSidebarTab} exiting={exiting} agentUnread={agentUnread} />

      <section style={{
        position: "fixed",
        left: "var(--sidebar-left)",
        width: "var(--sidebar-w)",
        top: "var(--panel-top)",
        height: "var(--panel-h)",
        borderRadius: 20,
        overflow: "hidden",
        display: "flex", flexDirection: "column",
        isolation: "isolate",
        zIndex: 1,
        background: "#0c0c10",
        border: "1px solid rgba(255,255,255,0.08)",
      }} className={rightSidebarClass}>
        {sidebarTab === "agent" ? <AgentChatPanel /> : <DashboardPanel />}
      </section>
    </main>
  );
}
