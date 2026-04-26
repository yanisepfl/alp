"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

const WORDS = "Start earning from onchain volume".split(" ");
const ARROW_DELAY_MS = 2600 + (WORDS.length - 1) * 180 + 600 + 80;

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

// Per-token deposit breakdown -used by the expanded Total Deposits view.
const DEPOSITS = [
  { slug: "USDC", src: "/tokens/usdc.png",     color: "#2775CA", amount: "$1.20M" },
  { slug: "ETH",  src: "/tokens/eth.png",      color: "#627EEA", amount: "$850K"  },
  { slug: "BTC",  src: "/tokens/btc.png",      color: "#F7931A", amount: "$620K"  },
  { slug: "USDT", src: "/tokens/usdt.png",     color: "#26A17B", amount: "$245K"  },
  { slug: "UNI",  src: "/tokens/uni.png",      color: "#FF007A", amount: "$145K"  },
];

// Inline `color` is intentionally omitted -color must come from a Tailwind
// class so :hover and group-hover variants can override it.
const PILL_BOX = {
  height: 16,
  padding: "0 6px",
  borderRadius: 4,
  fontSize: "11px" as const,
  fontWeight: 500 as const,
  lineHeight: 1,
};

function CatchphraseLink({ disabled = false }: { disabled?: boolean }) {
  return (
    <Link
      href="/app"
      className="catchphrase-portal group pointer-events-auto inline-flex items-center gap-4"
      style={{
        textDecoration: "none",
        pointerEvents: disabled ? "none" : undefined,
      }}
    >
      <span
        style={{
          color: "#fff",
          fontFamily: "var(--font-radley)",
          fontSize: "40px",
          lineHeight: 1.2,
          letterSpacing: "-0.01em",
          minHeight: "1.2em",
          display: "inline-block",
        }}
      >
        {WORDS.map((word, i) => (
          <span
            key={i}
            className="reveal inline-block"
            style={{
              marginRight: i < WORDS.length - 1 ? "0.27em" : 0,
              animationDelay: `${2600 + i * 180}ms`,
            }}
          >
            {word}
          </span>
        ))}
      </span>

      <span className="reveal inline-block" style={{ animationDelay: `${ARROW_DELAY_MS}ms` }}>
        <span
          className="inline-flex items-center justify-center bg-white/10 transition-colors duration-300 ease-out group-hover:bg-white/[0.18]"
          style={{ width: 40, height: 40, borderRadius: 14, color: "#fff" }}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            style={{ display: "block" }}
          >
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </span>
      </span>
    </Link>
  );
}

function DepositChip({ d }: { d: (typeof DEPOSITS)[number] }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="group relative hover:z-10">
        <span
          className="inline-flex items-center justify-center bg-white/10"
          style={{ width: 16, height: 16, borderRadius: 4 }}
        >
          <Image src={d.src} alt={d.slug} width={11} height={11} />
        </span>
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 bottom-full mb-2 inline-flex items-center justify-center whitespace-nowrap bg-white/10 text-haze opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          style={{
            transform: "translateX(-50%)",
            ...PILL_BOX,
          }}
        >
          {d.slug}
        </span>
      </div>
      <span className="text-haze" style={{ fontSize: "11px", fontWeight: 500 }}>
        {d.amount}
      </span>
    </div>
  );
}

function CloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Close"
      className="inline-flex items-center justify-center bg-white/10 text-haze transition-colors duration-200 hover:text-white"
      style={{
        width: 16,
        height: 16,
        borderRadius: 4,
        border: "none",
        padding: 0,
      }}
    >
      <svg
        width="8"
        height="8"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        aria-hidden
        style={{ display: "block" }}
      >
        <line x1="6" y1="6" x2="18" y2="18" />
        <line x1="18" y1="6" x2="6" y2="18" />
      </svg>
    </button>
  );
}

// Both views slide on the same axis: collapsed animates up + out, expanded
// rises in from below. Same curve in reverse on close.
const SWITCH_TRANSITION =
  "transform 450ms cubic-bezier(0.6, 0, 0.3, 1), opacity 450ms cubic-bezier(0.6, 0, 0.3, 1)";

function TotalDeposits() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="reveal absolute z-30"
      style={{
        top: "calc(20% - 28px)",
        right: "20%",
        animationDelay: "2600ms",
      }}
    >
      {/* Collapsed view */}
      <div
        className="absolute top-0 right-0 flex items-center gap-1.5 whitespace-nowrap text-xs text-haze"
        style={{
          opacity: expanded ? 0 : 1,
          transform: expanded ? "translateY(-100%)" : "translateY(0)",
          pointerEvents: expanded ? "none" : "auto",
          transition: SWITCH_TRANSITION,
        }}
      >
        <span>Total Deposits</span>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center justify-center bg-white/10 text-haze transition-colors duration-200 hover:text-white"
          style={{ ...PILL_BOX, border: "none" }}
        >
          $3.26M
        </button>
      </div>

      {/* Expanded view -per-token breakdown */}
      <div
        className="absolute top-0 right-0 flex items-center gap-1.5 whitespace-nowrap text-xs text-haze"
        style={{
          opacity: expanded ? 1 : 0,
          transform: expanded ? "translateY(0)" : "translateY(100%)",
          pointerEvents: expanded ? "auto" : "none",
          transition: SWITCH_TRANSITION,
        }}
      >
        {DEPOSITS.map((d) => (
          <DepositChip key={d.slug} d={d} />
        ))}
        <CloseButton onClick={() => setExpanded(false)} />
      </div>
    </div>
  );
}

// "Built on top of" bars under the Summary card. Each entry maps to a
// prize track from ETHGlobal Open Agents that ALP integrates with. Colored
// rounded-square chip on the left (white glyph), name + descriptor stacked
// to the right.
const BUILT_ON = [
  { name: "Uniswap",   label: "Best Uniswap API integration",    color: "#FF007A", glyph: "U" },
  { name: "KeeperHub", label: "Best agent execution layer use",  color: "#00D26A", glyph: "K" },
  { name: "ENS",       label: "Best ENS integration for agents", color: "#5298FF", glyph: "E" },
];

function BuiltOnBar({
  name,
  label,
  color,
  glyph,
}: {
  name: string;
  label: string;
  color: string;
  glyph: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "10px 14px",
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 14,
        flex: 1,
        minWidth: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          width: 26,
          height: 26,
          borderRadius: 6,
          background: color,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#fff",
          fontFamily: "var(--sans-stack)",
          fontSize: 14,
          fontWeight: 600,
          lineHeight: 1,
          flexShrink: 0,
          letterSpacing: "-0.02em",
        }}
      >
        {glyph}
      </span>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontFamily: "var(--font-radley)",
            fontSize: 14,
            color: "rgba(255,255,255,0.92)",
            lineHeight: 1.1,
          }}
        >
          {name}
        </span>
        <span
          style={{
            fontFamily: "var(--font-radley)",
            fontSize: 11,
            color: "rgba(255,255,255,0.55)",
            lineHeight: 1.1,
          }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

// Bottom-left "Back" — small text + arrow chip, transparent background.
// Only rendered while the Learn-more overlay is open.
function LearnMore({ open, onClick }: { open: boolean; onClick: () => void }) {
  if (!open) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Back"
      className="absolute z-30 flex items-center gap-1.5 text-xs text-haze transition-colors hover:text-mist"
      style={{
        top: "calc(80% + 12px)",
        left: "20%",
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
      }}
    >
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
          style={{ display: "block", marginRight: "-1px" }}
        >
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
      </span>
      <span>Back</span>
    </button>
  );
}

// "How it works?" — primary entry into the Learn-more overlay. Same
// text + chip-arrow style as the Back button and same position too
// (bottom-left, just below the panel — outside the bg). They occupy the
// same slot mutually exclusively. Always rendered so the reveal animation
// only plays on first mount; toggling via opacity avoids the delayed
// re-fade-in when returning from Learn-more.
function HowItWorks({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="How it works"
      className="reveal absolute z-30 flex items-center gap-1.5 text-xs text-haze transition-opacity hover:text-mist"
      style={{
        top: "calc(80% + 12px)",
        left: "20%",
        animationDelay: "2700ms",
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0 : 1,
        pointerEvents: disabled ? "none" : "auto",
        transition: "opacity 350ms cubic-bezier(0.16, 1, 0.3, 1), color 200ms",
      }}
    >
      <span>How it works?</span>
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
    </button>
  );
}

const LEARN_FADE =
  "opacity 700ms cubic-bezier(0.16, 1, 0.3, 1), transform 700ms cubic-bezier(0.16, 1, 0.3, 1)";

// Tiny stroke icons used inside inline pills + card labels. 24x24 viewBox so
// stroke-width stays consistent regardless of render size.
const ICONS: Record<string, React.ReactNode> = {
  summary: <path d="M5 7h14M5 12h10M5 17h12" />,
  vault: (
    <>
      <path d="M5 9h14v9H5z" />
      <path d="M9 9V6a3 3 0 0 1 6 0v3" />
    </>
  ),
  strategy: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M3 12h6M15 12h6" />
    </>
  ),
  // agent — clock (24/7 monitoring), reads as "always on, decisioning over time"
  agent: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <polyline points="12 7 12 12 15.5 14" />
    </>
  ),
  // risk — shield with check, reads as "exposure managed"
  risk: (
    <>
      <path d="M12 3 L20 7 V13 C20 17 16.5 20 12 21 C7.5 20 4 17 4 13 V7 Z" />
      <polyline points="9 12 11 14 15 10" />
    </>
  ),
  // pools — three stacked liquidity layers
  pools: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="8" cy="7" r="0.8" fill="currentColor" />
      <circle cx="14" cy="12" r="0.8" fill="currentColor" />
      <circle cx="10" cy="17" r="0.8" fill="currentColor" />
    </>
  ),
  coin: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M14.5 9.5h-3a1.5 1.5 0 0 0 0 3h2a1.5 1.5 0 0 1 0 3h-3M12 7.5v9" />
    </>
  ),
  split: (
    <>
      <circle cx="9" cy="12" r="5" />
      <circle cx="15" cy="12" r="5" />
    </>
  ),
  wave: <path d="M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0" />,
  orbit: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="20" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  spark: <path d="M5 14l4-4 4 4 4-4 4 4M9 10V5M17 10V5" />,
  gate: (
    <>
      <path d="M5 5v14M19 5v14" />
      <path d="M9 12h6" />
    </>
  ),
};

// Inline brand reference - rendered as an InlinePill-shaped chip so it sits
// flush with the other inline pills in body copy. Logo + "alps" wordmark in
// pure white, hairline border, low-alpha bg.
function BrandRef() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px 2px 6px",
        borderRadius: 999,
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.09)",
        verticalAlign: "-0.12em",
        margin: "0 0.12em",
        color: "#fff",
        fontSize: 13,
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden
        style={{
          display: "inline-block",
          width: 14,
          height: 14,
          backgroundColor: "currentColor",
          WebkitMaskImage: "url(/logo.png)",
          maskImage: "url(/logo.png)",
          WebkitMaskSize: "contain",
          maskSize: "contain",
          WebkitMaskRepeat: "no-repeat",
          maskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          maskPosition: "center",
        }}
      />
      <span style={{ fontFamily: "var(--font-radley)", lineHeight: 1 }}>alps</span>
    </span>
  );
}

function StrokeIcon({ kind, size = 11, opacity = 1 }: { kind: keyof typeof ICONS | string; size?: number; opacity?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ display: "inline-block", flexShrink: 0, opacity }}
    >
      {ICONS[kind]}
    </svg>
  );
}

// Filled icons (18×18 viewBox, two-tone via fill-opacity). Sourced from a
// small icon kit; primary paths render at full color, secondary ones at 0.4.
const FILLED_ICONS: Record<string, React.ReactNode> = {
  dots: (
    <>
      <path d="M15.5001 12H13.7501V10.25C13.7501 9.8359 13.4142 9.5 13.0001 9.5C12.586 9.5 12.2501 9.8359 12.2501 10.25V12H10.5001C10.086 12 9.75012 12.3359 9.75012 12.75C9.75012 13.1641 10.086 13.5 10.5001 13.5H12.2501V15.25C12.2501 15.6641 12.586 16 13.0001 16C13.4142 16 13.7501 15.6641 13.7501 15.25V13.5H15.5001C15.9142 13.5 16.2501 13.1641 16.2501 12.75C16.2501 12.3359 15.9142 12 15.5001 12Z" />
      <path d="M5.00011 8.25C6.79503 8.25 8.25011 6.79493 8.25011 5C8.25011 3.20507 6.79503 1.75 5.00011 1.75C3.20518 1.75 1.75012 3.20507 1.75012 5C1.75012 6.79493 3.20518 8.25 5.00011 8.25Z" fillOpacity="0.4" />
      <path d="M13.0001 8.25C14.795 8.25 16.2501 6.79493 16.2501 5C16.2501 3.20507 14.795 1.75 13.0001 1.75C11.2052 1.75 9.75012 3.20507 9.75012 5C9.75012 6.79493 11.2052 8.25 13.0001 8.25Z" fillOpacity="0.4" />
      <path d="M5.00011 16.25C6.79503 16.25 8.25011 14.7949 8.25011 13C8.25011 11.2051 6.79503 9.75 5.00011 9.75C3.20518 9.75 1.75012 11.2051 1.75012 13C1.75012 14.7949 3.20518 16.25 5.00011 16.25Z" fillOpacity="0.4" />
    </>
  ),
  gaming: (
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M2 3.75C2 2.78349 2.78349 2 3.75 2H6.25C7.21651 2 8 2.78349 8 3.75V6.25C8 7.21651 7.21651 8 6.25 8H3.75C2.78349 8 2 7.21651 2 6.25V3.75Z" fillOpacity="0.4" />
      <path fillRule="evenodd" clipRule="evenodd" d="M9.75 13C9.75 11.2051 11.2051 9.75 13 9.75C14.7949 9.75 16.25 11.2051 16.25 13C16.25 14.7949 14.7949 16.25 13 16.25C11.2051 16.25 9.75 14.7949 9.75 13Z" fillOpacity="0.4" />
      <path fillRule="evenodd" clipRule="evenodd" d="M7.78033 11.2803C8.07322 10.9874 8.07322 10.5126 7.78033 10.2197C7.48744 9.92678 7.01256 9.92678 6.71967 10.2197L5 11.9393L3.28033 10.2197C2.98744 9.92678 2.51256 9.92678 2.21967 10.2197C1.92678 10.5126 1.92678 10.9874 2.21967 11.2803L3.93934 13L2.21967 14.7197C1.92678 15.0126 1.92678 15.4874 2.21967 15.7803C2.51256 16.0732 2.98744 16.0732 3.28033 15.7803L5 14.0607L6.71967 15.7803C7.01256 16.0732 7.48744 16.0732 7.78033 15.7803C8.07322 15.4874 8.07322 15.0126 7.78033 14.7197L6.06066 13L7.78033 11.2803Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M14.0104 2.58371L16.1268 6.24857C16.5746 7.02538 16.0158 8 15.1156 8H10.8834C9.98322 8 9.42416 7.02579 9.87205 6.24898C10.5775 5.02736 11.2831 3.80578 11.9877 2.58371C12.4365 1.8053 13.5614 1.80557 14.0104 2.58371Z" />
    </>
  ),
  sparkles: (
    <>
      <path d="M5.65802 2.98996L4.39502 2.56894L3.97402 1.30606C3.83702 0.898061 3.16202 0.898061 3.02502 1.30606L2.60402 2.56894L1.34103 2.98996C1.13703 3.05796 0.999023 3.24896 0.999023 3.46396C0.999023 3.67896 1.13703 3.86996 1.34103 3.93796L2.60402 4.35898L3.02502 5.62198C3.09302 5.82598 3.28502 5.96396 3.50002 5.96396C3.71502 5.96396 3.90602 5.82598 3.97502 5.62198L4.39603 4.35898L5.65902 3.93796C5.86302 3.86996 6.00102 3.67896 6.00102 3.46396C6.00102 3.24896 5.86202 3.05796 5.65802 2.98996Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M9.50007 2C9.80783 2.00003 10.0843 2.18808 10.1975 2.47429L11.99 7.00903L16.5258 8.80255C16.812 8.91571 17 9.19224 17 9.5C17 9.80776 16.812 10.0843 16.5258 10.1975L11.99 11.9909L10.1975 16.5257C10.0843 16.8119 9.80783 17 9.50007 17C9.1923 17 8.91575 16.812 8.80256 16.5258L7.00905 11.991L2.47417 10.1974C2.18799 10.0843 2 9.80774 2 9.5C2 9.19226 2.18799 8.91575 2.47417 8.80256L7.00905 7.00903L8.80256 2.47417C8.91575 2.18797 9.1923 1.99997 9.50007 2Z" fillOpacity="0.4" />
    </>
  ),
  fingerprint: (
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M9.00001 2.75C7.68924 2.75 6.48996 3.23143 5.56899 4.02896C5.25586 4.30012 4.78221 4.2661 4.51105 3.95297C4.2399 3.63985 4.27392 3.16619 4.58704 2.89504C5.77007 1.87057 7.31478 1.25 9.00001 1.25C12.7232 1.25 15.75 4.27679 15.75 8C15.75 10.387 15.3742 12.5347 14.7222 14.4542C14.5889 14.8464 14.163 15.0564 13.7708 14.9232C13.3786 14.7899 13.1686 14.364 13.3019 13.9718C13.8998 12.2113 14.25 10.227 14.25 8C14.25 5.10521 11.8948 2.75 9.00001 2.75Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M3.89029 4.76983C4.26484 4.94671 4.42507 5.39373 4.24819 5.76828C3.92854 6.44514 3.75 7.20096 3.75 8.00001C3.75 8.38139 3.6915 10.2337 2.54695 12.0957C2.33005 12.4486 1.86815 12.5589 1.51527 12.342C1.16238 12.1251 1.05215 11.6632 1.26905 11.3103C2.20451 9.78836 2.25 8.25862 2.25 8.00001C2.25 6.97506 2.47949 6.00087 2.89184 5.12773C3.06872 4.75319 3.51574 4.59295 3.89029 4.76983Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M11.9626 9.39774C12.3737 9.44889 12.6654 9.82357 12.6143 10.2346C12.3232 12.5733 11.5837 14.5968 10.5655 16.3282C10.3555 16.6852 9.89586 16.8045 9.53881 16.5945C9.18176 16.3845 9.06254 15.9249 9.27251 15.5678C10.1903 14.0072 10.8608 12.1787 11.1257 10.0494C11.1769 9.63834 11.5516 9.34659 11.9626 9.39774Z" fillOpacity="0.4" />
      <path fillRule="evenodd" clipRule="evenodd" d="M9.00001 5.75C7.75722 5.75 6.75001 6.75721 6.75001 8C6.75001 10.8522 5.77746 13.0139 4.44979 14.6182C4.18571 14.9373 3.71293 14.9819 3.39382 14.7178C3.07472 14.4537 3.03011 13.9809 3.2942 13.6618C4.41453 12.3081 5.25001 10.4798 5.25001 8C5.25001 5.92879 6.9288 4.25 9.00001 4.25C10.9056 4.25 12.4786 5.67128 12.7187 7.51093C12.7723 7.92166 12.4828 8.29808 12.0721 8.35169C11.6613 8.4053 11.2849 8.1158 11.2313 7.70507C11.0874 6.60272 10.1424 5.75 9.00001 5.75Z" fillOpacity="0.4" />
      <path fillRule="evenodd" clipRule="evenodd" d="M9.00001 7.25C9.41423 7.25 9.75001 7.58579 9.75001 8C9.75001 11.4326 8.6672 14.0727 7.14816 16.0718C6.89756 16.4016 6.42704 16.4658 6.09724 16.2152C5.76744 15.9646 5.70324 15.494 5.95385 15.1642C7.28281 13.4153 8.25001 11.0914 8.25001 8C8.25001 7.58579 8.5858 7.25 9.00001 7.25Z" />
    </>
  ),
  vault: (
    <>
      <path fillRule="evenodd" clipRule="evenodd" d="M9.75 1.75C9.75 1.33579 9.41421 1 9 1C8.58579 1 8.25 1.33579 8.25 1.75V13.25C8.25 14.2165 7.46649 15 6.5 15H4.75C4.33579 15 4 15.3358 4 15.75C4 16.1642 4.33579 16.5 4.75 16.5H6.5H9H11.5H13.25C13.6642 16.5 14 16.1642 14 15.75C14 15.3358 13.6642 15 13.25 15H11.5C10.5335 15 9.75 14.2165 9.75 13.25V1.75Z" fillOpacity="0.4" />
      <path fillRule="evenodd" clipRule="evenodd" d="M3.27502 3.75C3.27502 3.33579 3.61081 3 4.02502 3H13.975C14.3892 3 14.725 3.33579 14.725 3.75C14.725 4.16421 14.3892 4.5 13.975 4.5H4.02502C3.61081 4.5 3.27502 4.16421 3.27502 3.75Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M14.6714 3.47146C14.5571 3.18584 14.2801 2.99894 13.9724 3C13.6648 3.00107 13.389 3.18988 13.2768 3.47628L10.9619 9.38154C10.77 9.87124 10.8943 10.4824 11.3633 10.835C13.0415 12.0971 15.1125 12.1035 16.6835 10.8189C17.1289 10.4546 17.2265 9.8591 17.0393 9.3912L14.6714 3.47146ZM12.7226 9L13.9821 5.78707L15.2672 9H12.7226Z" />
      <path fillRule="evenodd" clipRule="evenodd" d="M4.72325 3.47628C4.61098 3.18988 4.3352 3.00107 4.02758 3C3.71995 2.99894 3.44287 3.18584 3.32862 3.47146L0.960722 9.39126C0.773549 9.85915 0.871273 10.4547 1.31662 10.819C2.88757 12.1036 4.95849 12.0971 6.63674 10.835C7.10568 10.4824 7.22996 9.87119 7.03805 9.38148L4.72325 3.47628ZM2.73277 9L4.01793 5.78707L5.27738 9H2.73277Z" />
    </>
  ),
  strategy: (
    <>
      <path opacity="0.4" d="M14.2501 8H3.75012C1.68212 8 0.00012207 9.682 0.00012207 11.75C0.00012207 13.818 1.68212 15.5 3.75012 15.5H14.2501C16.3181 15.5 18.0001 13.818 18.0001 11.75C18.0001 9.682 16.3181 8 14.2501 8Z" />
      <path d="M9.00011 6C8.58711 6 8.20211 5.79901 7.97111 5.46301L6.2141 2.909C5.9561 2.534 5.9291 2.05102 6.1451 1.65002C6.3611 1.24902 6.7821 0.999023 7.2441 0.999023H10.7561C11.2171 0.999023 11.6381 1.24802 11.8551 1.65002C12.0721 2.05202 12.0441 2.534 11.7861 2.909L10.0301 5.46198C9.79911 5.79798 9.4141 5.99902 9.0011 5.99902L9.00011 6Z" />
      <path d="M9.00012 12.5H3.75012C3.33612 12.5 3.00012 12.164 3.00012 11.75C3.00012 11.336 3.33612 11 3.75012 11H9.00012C9.41412 11 9.75012 11.336 9.75012 11.75C9.75012 12.164 9.41412 12.5 9.00012 12.5Z" />
    </>
  ),
  summary: (
    <>
      <path opacity="0.4" d="M15.25 2.75C7.8618 3.3965 4.78169 8.6387 3.54089 12.126C3.92719 12.3299 4.20599 12.4561 4.20599 12.4561C5.01599 12.8189 5.81799 12.979 5.86499 12.9871C6.71899 13.1431 7.50799 13.221 8.23199 13.221C9.73899 13.221 10.962 12.8831 11.882 12.211C12.2526 11.94 12.8529 11.3975 13.2719 10.4725C11.5489 10.1244 10.8235 9.4588 10.8235 9.4588C10.8235 9.4588 12.9829 9.7125 13.9199 8.9859C14.4219 8.5679 14.8189 7.9881 15.0359 7.1551C15.1749 6.543 15.2639 5.951 15.3489 5.379C15.4839 4.4781 15.6109 3.628 15.8999 3.1231C15.9797 2.9842 15.9977 2.8287 15.9816 2.6749C15.5423 2.7184 15.25 2.75 15.25 2.75Z" />
      <path d="M2.75099 16C2.72269 16 2.69439 15.9985 2.66509 15.9951C2.25399 15.9482 1.9581 15.5766 2.0049 15.165C2.0186 15.0439 3.52049 3.02341 15.1846 2.00291C15.5918 1.96481 15.961 2.27191 15.9971 2.68451C16.0332 3.09711 15.7276 3.46091 15.3155 3.49701C4.85848 4.41201 3.50789 15.2255 3.49519 15.3349C3.45129 15.7177 3.12689 16 2.75099 16Z" />
    </>
  ),
};

function FilledIcon({ kind, size = 12 }: { kind: keyof typeof FILLED_ICONS | string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="currentColor"
      aria-hidden
      style={{ display: "inline-block", flexShrink: 0 }}
    >
      {FILLED_ICONS[kind]}
    </svg>
  );
}

// Inline data pill -woven into prose. Hairline border + low-alpha bg, Inter
// numerals contrasting with the Radley body sets the "data" affordance in mono.
// Three icon variants: stroke (default), single token PNG, or overlapping pair.
type TokenImg = { src: string; alt: string };
type InlinePillProps = {
  icon?: keyof typeof ICONS;
  iconImage?: TokenImg;
  iconPair?: { left: TokenImg; right: TokenImg };
  tooltip?: React.ReactNode;
  children: React.ReactNode;
};

function InlinePill({ icon, iconImage, iconPair, tooltip, children }: InlinePillProps) {
  let iconSlot: React.ReactNode;
  if (iconImage) {
    iconSlot = (
      <span style={{ width: 14, height: 14, display: "inline-flex", flexShrink: 0 }}>
        <Image
          src={iconImage.src}
          alt={iconImage.alt}
          width={14}
          height={14}
          style={{ borderRadius: 999, display: "block" }}
        />
      </span>
    );
  } else if (iconPair) {
    // No boxShadow ring — the dark outline read as a black outline against
    // the muted scenery panel rather than blending invisibly into pill bg.
    iconSlot = (
      <span style={{ width: 23, height: 14, position: "relative", flexShrink: 0, display: "inline-block" }}>
        <Image
          src={iconPair.left.src}
          alt={iconPair.left.alt}
          width={14}
          height={14}
          style={{ borderRadius: 999, position: "absolute", left: 0, top: 0 }}
        />
        <Image
          src={iconPair.right.src}
          alt={iconPair.right.alt}
          width={14}
          height={14}
          style={{ borderRadius: 999, position: "absolute", left: 9, top: 0 }}
        />
      </span>
    );
  } else if (icon) {
    iconSlot =
      icon in FILLED_ICONS ? (
        <FilledIcon kind={icon} size={14} />
      ) : (
        <StrokeIcon kind={icon} size={12} opacity={0.92} />
      );
  }

  const pill = (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "2px 8px 2px 6px",
        borderRadius: 999,
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.09)",
        verticalAlign: "-0.12em",
        margin: "0 0.12em",
        color: "#fff",
        fontFamily: "var(--font-radley)",
        fontSize: 13,
        fontWeight: 400,
        lineHeight: 1,
        whiteSpace: "nowrap",
        cursor: "default",
      }}
    >
      {iconSlot}
      {children}
    </span>
  );

  if (!tooltip) return pill;

  // Hoverable variant. Popover uses frosted-glass chrome (matches the card
  // system, no dark text-box feel). Content can be text OR a JSX grid.
  return (
    <span
      className="group"
      style={{ position: "relative", display: "inline-block", whiteSpace: "nowrap" }}
    >
      {pill}
      <span
        aria-hidden
        className="pointer-events-none opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{
          position: "absolute",
          left: "50%",
          bottom: "calc(100% + 10px)",
          transform: "translateX(-50%)",
          padding: 12,
          borderRadius: 14,
          background: "rgba(255,255,255,0.05)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          border: "1px solid rgba(255,255,255,0.10)",
          color: "rgba(255,255,255,0.92)",
          fontFamily: "var(--font-radley)",
          fontSize: 13,
          fontWeight: 400,
          lineHeight: 1.5,
          width: "max-content",
          maxWidth: 380,
          whiteSpace: "normal",
          zIndex: 50,
        }}
      >
        {tooltip}
      </span>
    </span>
  );
}

// Token + pair lists used by tooltip grids on the Summary card pills.
// Shared 5-token set (matches ALLOCATIONS); each entry has the brand
// colour and kind/src so it can render through TokenChip as a brand-
// coloured rounded square (no more circular icon chrome).
type TokenEntry = { slug: string; kind: "svg" | "png"; src: string; color: string };
const TOKENS: Record<string, TokenEntry> = {
  USDC: { slug: "USDC", kind: "png", src: "/tokens/usdc.png",     color: "#2775CA" },
  ETH:  { slug: "ETH",  kind: "svg", src: "/tokens/svg/eth.svg",  color: "#627EEA" },
  BTC:  { slug: "BTC",  kind: "svg", src: "/tokens/svg/btc.svg",  color: "#F7931A" },
  USDT: { slug: "USDT", kind: "svg", src: "/tokens/svg/usdt.svg", color: "#26A17B" },
  UNI:  { slug: "UNI",  kind: "png", src: "/tokens/uni.png",      color: "#FF007A" },
};
const PORTFOLIO_TOKENS: TokenEntry[] = [
  TOKENS.USDC,
  TOKENS.ETH,
  TOKENS.BTC,
  TOKENS.USDT,
  TOKENS.UNI,
];
const POOL_PAIRS: [TokenEntry, TokenEntry][] = [
  [TOKENS.ETH,  TOKENS.USDC],
  [TOKENS.BTC,  TOKENS.USDC],
  [TOKENS.USDC, TOKENS.USDT],
  [TOKENS.UNI,  TOKENS.USDC],
  [TOKENS.BTC,  TOKENS.ETH],
  [TOKENS.ETH,  TOKENS.USDT],
];

function PortfolioTooltip() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, auto)", gap: "10px 18px" }}>
      {PORTFOLIO_TOKENS.map((t) => (
        <div key={t.slug} style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <TokenChip entry={t} size={18} radius={4} />
          <span style={{ fontFamily: "var(--font-radley)", fontSize: 13, lineHeight: 1, color: "rgba(255,255,255,0.92)" }}>
            {t.slug}
          </span>
        </div>
      ))}
    </div>
  );
}

// Portfolio breakdown - Apple-Health-style mini donut charts. Each pie
// represents one token's allocation; the filled arc is the % of vault TVL
// in that token. Token PNG sits in the center for instant recognition.
// Gauge-style allocation cells + shared TokenChip helper. Each chip is a
// brand-color rounded square with the token glyph inside: ETH/BTC/USDT use
// single-path SVGs masked white; USDC/UNI overlay their PNG (their SVG
// sources are missing/404).
type PiePngEntry = { slug: string; pct: number; color: string; kind: "png"; src: string };
type PieSvgEntry = { slug: string; pct: number; color: string; kind: "svg"; src: string };
type PieEntry = PiePngEntry | PieSvgEntry;

function TokenChip({
  entry,
  size,
  glyphSize,
  radius,
}: {
  entry: { kind: "svg" | "png"; src: string; color: string };
  size: number;
  glyphSize?: number;
  radius?: number;
}) {
  const gs = glyphSize ?? Math.round(size * 0.62);
  const r = radius ?? Math.max(3, Math.round(size * 0.26));
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: r,
        background: entry.color,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
      }}
    >
      {entry.kind === "svg" ? (
        <span
          style={{
            width: gs,
            height: gs,
            backgroundColor: "#fff",
            WebkitMaskImage: `url(${entry.src})`,
            maskImage: `url(${entry.src})`,
            WebkitMaskSize: "contain",
            maskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskPosition: "center",
            display: "block",
          }}
        />
      ) : (
        <Image
          src={entry.src}
          alt=""
          width={size}
          height={size}
          style={{ display: "block" }}
        />
      )}
    </span>
  );
}

const PORTFOLIO_PIES: PieEntry[] = [
  { slug: "USDC", kind: "png", src: "/tokens/usdc.png",     pct: 38, color: "#2775CA" },
  { slug: "ETH",  kind: "svg", src: "/tokens/svg/eth.svg",  pct: 24, color: "#627EEA" },
  { slug: "BTC",  kind: "svg", src: "/tokens/svg/btc.svg",  pct: 18, color: "#F7931A" },
  { slug: "USDT", kind: "svg", src: "/tokens/svg/usdt.svg", pct: 12, color: "#26A17B" },
  { slug: "UNI",  kind: "png", src: "/tokens/uni.png",      pct:  8, color: "#FF007A" },
];

function MiniPie(entry: PieEntry) {
  const [hover, setHover] = useState(false);
  const { slug, pct, color } = entry;
  const SIZE = 46;
  const STROKE = 5;
  const r = (SIZE - STROKE) / 2;
  const c = 2 * Math.PI * r;
  const ARC_FRAC = 0.75; // 270° visible
  const trackLen = ARC_FRAC * c;
  const fillLen = Math.max(0, Math.min(trackLen, (pct / 100) * trackLen));
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        position: "relative",
        width: SIZE,
        height: SIZE,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      aria-label={`${slug} ${pct}%`}
    >
      <svg width={SIZE} height={SIZE} aria-hidden style={{ display: "block" }}>
        {/* Track — muted, full 270° arc */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${trackLen} ${c - trackLen}`}
          transform={`rotate(135 ${SIZE / 2} ${SIZE / 2})`}
        />
        {/* Fill — colored, pct/100 of the visible 270° arc */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${fillLen} ${c - fillLen}`}
          transform={`rotate(135 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      {/* Center: token chip by default, percentage number on hover */}
      <span
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, calc(-58% + 2px))",
          opacity: hover ? 0 : 1,
          transition: "opacity 180ms ease-out",
          pointerEvents: "none",
        }}
      >
        <TokenChip entry={entry} size={20} />
      </span>
      <span
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%, calc(-58% + 2px))",
          fontFamily: "var(--sans-stack)",
          fontSize: 13,
          fontWeight: 500,
          color: "rgba(255,255,255,0.95)",
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "-0.02em",
          lineHeight: 1,
          opacity: hover ? 1 : 0,
          transition: "opacity 180ms ease-out",
          pointerEvents: "none",
        }}
      >
        {pct}
      </span>
    </div>
  );
}

function PortfolioPies() {
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
      {PORTFOLIO_PIES.map((t) => (
        <MiniPie key={t.slug} {...t} />
      ))}
    </div>
  );
}

// Bar track. centerline=true draws the divider for bipolar bars.
function BarTrack({ children, centerline }: { children: React.ReactNode; centerline?: boolean }) {
  return (
    <div
      style={{
        position: "relative",
        height: 6,
        background: "rgba(255,255,255,0.06)",
        borderRadius: 999,
        overflow: "hidden",
      }}
    >
      {centerline && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: "50%",
            top: 0,
            bottom: 0,
            width: 1,
            background: "rgba(255,255,255,0.22)",
            zIndex: 1,
          }}
        />
      )}
      {children}
    </div>
  );
}

// === Live simulation data — must match the band animation keyframes ===
// Right-edge price y at each cycle %. Linear interpolation between points.
const PRICE_KFS: { t: number; y: number }[] = [
  { t: 0,   y: 124 }, { t: 5,   y: 138 }, { t: 10,  y: 139 }, { t: 14,  y: 153 },
  { t: 18,  y: 146 }, { t: 22,  y: 149 }, { t: 30,  y: 150 }, { t: 40,  y: 154 },
  { t: 45,  y: 143 }, { t: 50,  y: 156 }, { t: 60,  y: 152 }, { t: 70,  y: 149 },
  { t: 75,  y: 151 }, { t: 80,  y: 145 }, { t: 85,  y: 110 }, { t: 88,  y: 100 },
  { t: 90,  y:  91 }, { t: 92,  y:  93 }, { t: 95,  y:  96 }, { t: 98,  y: 117 },
  { t: 100, y: 124 },
];
// Narrow band keyframes (translateY in px, scaleY).
const NARROW_KFS = [
  { t: 0,  ty: -4,  sy: 0.60 }, { t: 5,  ty: 10,  sy: 0.55 },
  { t: 14, ty: 24,  sy: 0.55 }, { t: 30, ty: 22,  sy: 0.55 },
  { t: 50, ty: 28,  sy: 0.55 }, { t: 75, ty: 23,  sy: 0.55 },
  { t: 82, ty: 20,  sy: 0.55 }, { t: 88, ty: 18,  sy: 0.55 },
  { t: 91, ty: -15, sy: 0.65 }, { t: 95, ty: -28, sy: 0.70 },
  { t: 99, ty: -3,  sy: 0.60 }, { t: 100, ty: -4, sy: 0.60 },
];
const WIDE_KFS = [
  { t: 0,   ty: 0,   sy: 2.40 }, { t: 18,  ty: 18,  sy: 2.20 },
  { t: 80,  ty: 18,  sy: 2.20 }, { t: 90,  ty: 18,  sy: 2.20 },
  { t: 93,  ty: -15, sy: 2.70 }, { t: 98,  ty: -15, sy: 2.70 },
  { t: 100, ty: 0,   sy: 2.40 },
];

function lerp(a: number, b: number, p: number) { return a + p * (b - a); }
function interpKfs<K extends string>(kfs: ({ t: number } & { [k in K]: number })[], t: number, key: K): number {
  if (t <= kfs[0].t) return kfs[0][key];
  if (t >= kfs[kfs.length - 1].t) return kfs[kfs.length - 1][key];
  for (let i = 0; i < kfs.length - 1; i++) {
    if (kfs[i].t <= t && t <= kfs[i + 1].t) {
      const p = (t - kfs[i].t) / (kfs[i + 1].t - kfs[i].t);
      return lerp(kfs[i][key], kfs[i + 1][key], p);
    }
  }
  return kfs[0][key];
}

// Stepped lookup matching CSS steps(1, end) semantics: value held at the
// most-recent keyframe whose t ≤ cycle %, snaps to the next at the boundary.
function steppedKfs<K extends string>(kfs: ({ t: number } & { [k in K]: number })[], t: number, key: K): number {
  let val = kfs[0][key];
  for (const kf of kfs) {
    if (kf.t <= t) val = kf[key];
    else break;
  }
  return val;
}

// MetricBars — reads the ACTUAL rendered transforms of the band groups
// and the price-line group via getComputedStyle every frame. Whatever
// is on screen is what the bars compute against — no separate JS clock,
// no animation-start mismatch, no easing-curve drift. Pure synchronization
// with what the eye sees.

// Path waypoints extracted from the price-line d-string. Used to look up
// the y at the right edge of viewport given the current scroll amount.
const PATH_POINTS: { x: number; y: number }[] = [
  { x: 0,     y: 140.9 }, { x: 5.1,   y: 135.6 }, { x: 10.3,  y: 128.4 }, { x: 15.4,  y: 145.5 },
  { x: 20.6,  y: 156.3 }, { x: 25.7,  y: 165.0 }, { x: 30.9,  y: 170.8 }, { x: 36.0,  y: 165.2 },
  { x: 41.1,  y: 167.7 }, { x: 46.3,  y: 164.7 }, { x: 51.4,  y: 163.4 }, { x: 56.6,  y: 158.4 },
  { x: 61.7,  y: 151.8 }, { x: 66.9,  y: 143.0 }, { x: 72.0,  y: 162.0 }, { x: 77.1,  y: 155.0 },
  { x: 82.3,  y: 132.8 }, { x: 87.4,  y: 130.6 }, { x: 92.6,  y: 142.6 }, { x: 97.7,  y: 141.6 },
  { x: 102.9, y: 149.5 }, { x: 108.0, y: 146.2 }, { x: 113.1, y: 143.9 }, { x: 118.3, y: 140.6 },
  { x: 123.4, y: 134.8 }, { x: 128.6, y: 151.3 }, { x: 133.7, y: 154.5 }, { x: 138.9, y: 150.3 },
  { x: 144.0, y: 148.9 }, { x: 149.1, y: 144.6 }, { x: 154.3, y: 149.6 }, { x: 159.4, y: 141.4 },
  { x: 164.6, y: 111.9 }, { x: 169.7, y: 117.3 }, { x: 174.9, y:  98.9 }, { x: 180.0, y: 101.6 },
  { x: 185.1, y: 100.2 }, { x: 190.3, y:  90.7 }, { x: 195.4, y:  91.4 }, { x: 200.6, y: 102.8 },
  { x: 205.7, y:  95.6 }, { x: 210.9, y:  99.7 }, { x: 216.0, y:  95.8 }, { x: 221.1, y: 112.9 },
  { x: 226.3, y: 124.9 }, { x: 231.4, y: 128.2 }, { x: 236.6, y: 123.7 }, { x: 241.7, y: 133.3 },
  { x: 246.9, y: 150.0 }, { x: 252.0, y: 141.3 }, { x: 257.1, y: 137.7 }, { x: 262.3, y: 142.9 },
  { x: 267.4, y: 153.8 }, { x: 272.6, y: 144.6 }, { x: 277.7, y: 139.2 }, { x: 282.9, y: 140.0 },
  { x: 288.0, y: 147.3 }, { x: 293.1, y: 155.7 }, { x: 298.3, y: 154.2 }, { x: 303.4, y: 150.0 },
  { x: 308.6, y: 149.6 }, { x: 313.7, y: 145.9 }, { x: 318.9, y: 152.4 }, { x: 324.0, y: 151.4 },
  { x: 329.1, y: 148.8 }, { x: 334.3, y: 143.9 }, { x: 339.4, y: 153.5 }, { x: 344.6, y: 151.4 },
  { x: 349.7, y: 150.5 }, { x: 354.9, y: 150.9 }, { x: 360.0, y: 151.2 }, { x: 365.1, y: 149.7 },
  { x: 370.3, y: 149.6 }, { x: 375.4, y: 153.7 }, { x: 380.6, y: 152.0 }, { x: 385.7, y: 156.5 },
  { x: 390.9, y: 155.1 }, { x: 396.0, y: 154.4 }, { x: 401.1, y: 151.2 }, { x: 406.3, y: 154.1 },
  { x: 411.4, y: 153.6 }, { x: 416.6, y: 151.8 }, { x: 421.7, y: 144.5 }, { x: 426.9, y: 146.2 },
  { x: 432.0, y: 140.9 },
];

function pathYAt(x: number): number {
  // Path is duplicated with second copy at +432, so wrap into [0, 432).
  const xMod = ((x % 432) + 432) % 432;
  for (let i = 0; i < PATH_POINTS.length - 1; i++) {
    const a = PATH_POINTS[i], b = PATH_POINTS[i + 1];
    if (a.x <= xMod && xMod <= b.x) {
      const p = (xMod - a.x) / (b.x - a.x || 1);
      return a.y + p * (b.y - a.y);
    }
  }
  return PATH_POINTS[0].y;
}

// matrix(a, b, c, d, e, f) → { scaleY: d, translateX: e, translateY: f }
function readMatrix(transformStr: string): { scaleY: number; translateX: number; translateY: number } {
  if (!transformStr || transformStr === "none") return { scaleY: 1, translateX: 0, translateY: 0 };
  const m = transformStr.match(/matrix\(([^)]+)\)/);
  if (!m) return { scaleY: 1, translateX: 0, translateY: 0 };
  const p = m[1].split(",").map((s) => parseFloat(s));
  return { scaleY: p[3] ?? 1, translateX: p[4] ?? 0, translateY: p[5] ?? 0 };
}

function MetricBars() {
  const netRef = useRef<HTMLDivElement>(null);
  const cumRef = useRef<HTMLDivElement>(null);
  const compoundedRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const net = netRef.current;
    const cum = cumRef.current;
    const compounded = compoundedRef.current;
    if (!net || !cum) return;

    let cumNet = 0;
    let prevNarrowCenter: number | null = null;
    let prevWideCenter: number | null = null;
    let prevTimeMs: number | null = null;
    let prevRightX = -1;
    let lastSign = 1;
    let rafId = 0;
    let compoundedTimer: ReturnType<typeof setTimeout> | null = null;
    let lvrShown = 0;   // decaying display value so a 1-frame LVR snap stays visible

    const tick = () => {
      const priceEl = document.querySelector(".animate-price-drift");
      if (!priceEl) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      // Derive the cycle % from the price-line's actual translateX (linear
      // easing → matrix is reliable). Then use that cycle % to look up
      // band positions from the keyframes via stepped semantics — matching
      // the visible bands' steps(1, end) snaps exactly.
      const priceM = readMatrix(window.getComputedStyle(priceEl).transform);
      const cyclePct = Math.max(0, Math.min(100, (-priceM.translateX / 432) * 100));

      const narrowCenter = 128 + steppedKfs(NARROW_KFS, cyclePct, "ty");
      const narrowHalf   = 24  * steppedKfs(NARROW_KFS, cyclePct, "sy");
      const wideCenter   = 128 + steppedKfs(WIDE_KFS,   cyclePct, "ty");
      const wideHalf     = 24  * steppedKfs(WIDE_KFS,   cyclePct, "sy");

      const rightEdgeX = 236 - priceM.translateX;
      const price = pathYAt(rightEdgeX);

      // Wrap detection: cyclePct decreases sharply at loop reset.
      if (rightEdgeX < prevRightX - 100) {
        cumNet = 0;
        if (compounded) {
          compounded.style.opacity = "1";
          if (compoundedTimer) clearTimeout(compoundedTimer);
          compoundedTimer = setTimeout(() => {
            if (compounded) compounded.style.opacity = "0";
          }, 1400);
        }
      }
      prevRightX = rightEdgeX;

      const inNarrow = Math.abs(price - narrowCenter) <= narrowHalf;
      const inWide = Math.abs(price - wideCenter) <= wideHalf;
      const depth = (inNarrow ? 1 : 0) + (inWide ? 1 : 0);

      const fee = depth === 2 ? 30 : depth === 1 ? 15 : 0;

      const dnNarrow = prevNarrowCenter !== null ? Math.abs(narrowCenter - prevNarrowCenter) : 0;
      const dnWide = prevWideCenter !== null ? Math.abs(wideCenter - prevWideCenter) : 0;
      const now = performance.now();
      const dtSec = prevTimeMs !== null ? Math.min(0.05, (now - prevTimeMs) / 1000) : 0.016;

      // Raw LVR for this frame. First-order LP rebalance cost: linear in
      // |Δcenter|, weighted by concentration (narrow is tighter so the
      // swap to recenter costs more per unit shift).
      const lvrThisFrame = dnNarrow * 0.30 + dnWide * 0.12;
      const lvrInstant = lvrThisFrame / Math.max(dtSec, 0.001);

      // For DISPLAY: faster decay so small snaps fade quickly (visibly
      // smaller red flash), big snaps persist. Differentiates magnitudes.
      lvrShown = Math.max(lvrShown * 0.78, lvrInstant);

      const inst = fee - lvrShown;

      // Top bar (smooth transitions added on the element style itself)
      const w = Math.min(48, Math.abs(inst));
      const sign = inst >= 0 ? 1 : -1;
      if (sign !== lastSign) {
        net.style.background = sign === 1 ? "rgba(74,222,128,0.85)" : "rgba(239,68,68,0.85)";
        lastSign = sign;
      }
      if (sign === 1) {
        net.style.left = "50%";
        net.style.right = `calc(50% - ${w.toFixed(2)}%)`;
      } else {
        net.style.left = `calc(50% - ${w.toFixed(2)}%)`;
        net.style.right = "50%";
      }

      // Bottom bar (Revenue) — accumulate using the RAW lvrInstant (not the
      // decayed display value), so each LVR event is counted once.
      cumNet += (fee - lvrInstant) * dtSec * 0.08;
      const cumW = Math.max(0.5, Math.min(95, cumNet));
      cum.style.width = `${cumW.toFixed(2)}%`;

      prevNarrowCenter = narrowCenter;
      prevWideCenter = wideCenter;
      prevTimeMs = now;
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      if (compoundedTimer) clearTimeout(compoundedTimer);
    };
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 16 }}>
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 5,
            fontFamily: "var(--font-radley)",
            fontSize: 11,
            color: "rgba(255,255,255,0.55)",
            lineHeight: 1,
          }}
        >
          <span>LVR</span>
          <span>Fees</span>
        </div>
        <BarTrack centerline>
          <div
            ref={netRef}
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              borderRadius: 999,
              background: "rgba(74,222,128,0.85)",
              left: "50%",
              right: "50%",
              transition: "left 120ms linear, right 120ms linear, background-color 200ms linear",
            }}
          />
        </BarTrack>
      </div>
      <div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 5,
            fontFamily: "var(--font-radley)",
            fontSize: 11,
            color: "rgba(255,255,255,0.55)",
            lineHeight: 1,
          }}
        >
          <span>Revenue</span>
          <span
            ref={compoundedRef}
            style={{
              color: "rgba(74,222,128,0.95)",
              opacity: 0,
              transition: "opacity 320ms ease-out",
            }}
          >
            Compounded
          </span>
        </div>
        <BarTrack>
          <div
            ref={cumRef}
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: "0.5%",
              background: "rgba(74,222,128,0.85)",
              borderRadius: 999,
              transition: "width 120ms linear",
            }}
          />
        </BarTrack>
      </div>
    </div>
  );
}

// 3×2 grid (was 4×2) since AERO pairs were dropped. Pair entries render as
// the overlapping coin pair only; no text label per the user's request.
function PairsTooltip() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, auto)", gap: "12px 18px" }}>
      {POOL_PAIRS.map(([l, r], i) => (
        <span
          key={i}
          style={{ width: 30, height: 20, position: "relative", flexShrink: 0, display: "inline-block" }}
          aria-hidden
        >
          <span style={{ position: "absolute", left: 0, top: 0 }}>
            <TokenChip entry={l} size={20} radius={5} />
          </span>
          <span style={{ position: "absolute", left: 12, top: 0 }}>
            <TokenChip entry={r} size={20} radius={5} />
          </span>
        </span>
      ))}
    </div>
  );
}

// Top-left card label pill. Uses FilledIcon when the icon name is in
// FILLED_ICONS; falls back to StrokeIcon otherwise. alignSelf flex-start
// prevents the pill from stretching when its parent is a flex-col Card.
function CardLabel({ icon, children }: { icon: string; children: React.ReactNode }) {
  const isFilled = icon in FILLED_ICONS;
  return (
    <span
      style={{
        display: "inline-flex",
        alignSelf: "flex-start",
        alignItems: "center",
        gap: 5,
        padding: "0 8px 0 6px",
        height: 20,
        borderRadius: 6,
        background: "rgba(255,255,255,0.08)",
        color: "rgba(255,255,255,0.92)",
        fontFamily: "var(--sans-stack)",
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: "0.02em",
        lineHeight: 1,
        width: "max-content",
      }}
    >
      {isFilled ? <FilledIcon kind={icon} size={12} /> : <StrokeIcon kind={icon} size={11} />}
      {children}
    </span>
  );
}

// Generic card chrome -bg + hairline + radius + padding. Used for Summary,
// Vault flow, Strategy.
function Card({ children, style, className }: { children: React.ReactNode; style?: React.CSSProperties; className?: string }) {
  return (
    <div
      className={className}
      style={{
        background: "rgba(255,255,255,0.04)",
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 20,
        padding: "16px 20px 18px",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// VaultFlow -orbital basket. Five token chips ring an ALPS center; dashed
// deposit/yield paths animate continuously. Hovering a chip dims the others
// and updates the caption beneath the center card.
type OrbitEntry = PieEntry & { angle: number; note: string };
const ORBIT_TOKENS: OrbitEntry[] = [
  { slug: "USDC", kind: "png", src: "/tokens/usdc.png",     pct: 38, color: "#2775CA", note: "stable leg",     angle: -90  },
  { slug: "ETH",  kind: "svg", src: "/tokens/svg/eth.svg",  pct: 24, color: "#627EEA", note: "ETH/USDC pool",  angle: -18  },
  { slug: "BTC",  kind: "svg", src: "/tokens/svg/btc.svg",  pct: 18, color: "#F7931A", note: "BTC/USDC pool",  angle:  54  },
  { slug: "USDT", kind: "svg", src: "/tokens/svg/usdt.svg", pct: 12, color: "#26A17B", note: "stable leg",     angle: 126  },
  { slug: "UNI",  kind: "png", src: "/tokens/uni.png",      pct:  8, color: "#FF007A", note: "UNI/USDC pool",  angle: -162 },
];

function VaultFlow() {
  const [hover, setHover] = useState<string | null>(null);
  // Scaled-up internal coord space (216 → 240) so the ring + chips fill
  // more of the card. HEIGHT is shorter than SIZE so the empty padding
  // under the lowest chips is cropped via overflow:hidden — the viz
  // itself isn't shrunk.
  const SIZE = 240;
  const HEIGHT = 212;
  const CENTER = SIZE / 2;
  const RADIUS = 86;
  const CHIP = 34;

  const hovered = ORBIT_TOKENS.find((t) => t.slug === hover);

  return (
    <div
      onMouseLeave={() => setHover(null)}
      style={{ position: "relative", width: SIZE, height: HEIGHT, overflow: "hidden" }}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        aria-hidden
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        {/* Ring -dashed outline indicating "the basket" */}
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="rgba(255,255,255,0.10)"
          strokeWidth={1}
          strokeDasharray="2 4"
        />
        {/* Spokes — radial connectors that start at the ALPS card edge and
            end at the chip edge, leaving the squares uncovered. ALPS
            center is 58px and chips are CHIP px (half-sizes 29 and CHIP/2).
            The distance from a square's center to its edge along an angle
            θ is half_size / max(|cos θ|, |sin θ|). Adding a 2px gap. */}
        {ORBIT_TOKENS.map((t) => {
          const rad = (t.angle * Math.PI) / 180;
          const m = Math.max(Math.abs(Math.cos(rad)), Math.abs(Math.sin(rad)));
          const startDist = 29 / m + 2;
          const endDist = RADIUS - (CHIP / 2) / m - 2;
          const x1 = CENTER + startDist * Math.cos(rad);
          const y1 = CENTER + startDist * Math.sin(rad);
          const x2 = CENTER + endDist * Math.cos(rad);
          const y2 = CENTER + endDist * Math.sin(rad);
          const lit = hover === t.slug;
          return (
            <line
              key={t.slug}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#fff"
              strokeWidth={1}
              strokeOpacity={lit ? 0.45 : 0.08}
              style={{ transition: "stroke-opacity 260ms cubic-bezier(0.16, 1, 0.3, 1)" }}
            />
          );
        })}
      </svg>

      {/* ALPS center card */}
      <div
        style={{
          position: "absolute",
          left: CENTER - 29,
          top: CENTER - 29,
          width: 58,
          height: 58,
          borderRadius: 14,
          background: "rgba(255,255,255,0.10)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div aria-hidden style={{ width: 30, height: 30, ...MASK_STYLE }} />
      </div>

      {/* Token chips */}
      {ORBIT_TOKENS.map((t) => {
        const rad = (t.angle * Math.PI) / 180;
        const cx = CENTER + RADIUS * Math.cos(rad);
        const cy = CENTER + RADIUS * Math.sin(rad);
        const isHover = hover === t.slug;
        const dim = hover && !isHover;
        return (
          <button
            key={t.slug}
            type="button"
            onMouseEnter={() => setHover(t.slug)}
            onFocus={() => setHover(t.slug)}
            aria-label={t.slug}
            style={{
              position: "absolute",
              left: cx - CHIP / 2,
              top: cy - CHIP / 2,
              width: CHIP,
              height: CHIP,
              border: "none",
              padding: 0,
              background: "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              opacity: dim ? 0.32 : 1,
              transform: isHover ? "scale(1.08)" : "scale(1)",
              transition:
                "opacity 260ms cubic-bezier(0.16, 1, 0.3, 1), transform 260ms cubic-bezier(0.16, 1, 0.3, 1)",
              cursor: "pointer",
            }}
          >
            <TokenChip entry={t} size={CHIP} radius={9} />
          </button>
        );
      })}

      {/* Caption — chip-styled pill at the top of the viz, only visible when
          a token is hovered. Floating above the orbital ring keeps it from
          overlapping any of the lower chips. */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 6,
          transform: "translateX(-50%)",
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          height: 22,
          padding: "0 9px 0 8px",
          borderRadius: 999,
          background: "rgba(255,255,255,0.08)",
          border: "1px solid rgba(255,255,255,0.10)",
          color: "rgba(255,255,255,0.92)",
          fontFamily: "var(--font-radley)",
          fontSize: 12,
          fontWeight: 400,
          lineHeight: 1,
          whiteSpace: "nowrap",
          opacity: hovered ? 1 : 0,
          transition: "opacity 220ms cubic-bezier(0.16, 1, 0.3, 1)",
          pointerEvents: "none",
        }}
      >
        {hovered ? (
          <>
            <TokenChip entry={hovered} size={14} radius={4} />
            {`${hovered.slug} · ${hovered.pct}%`}
          </>
        ) : null}
      </div>
    </div>
  );
}

// StrategyViz -active LP range management.
// A price polyline drifts left under a clip window. A liquidity range band
// sits at the midline and "snaps" up/down twice per loop -that's the
// rebalance event. A fee-tick chip flashes after each snap; the agent dot
// pulses bright at the same moment, telegraphing cause-and-effect.
// All four animated layers share a 9s clock so they stay phase-locked.
// Real ETH/USD price data — 7 days of hourly closes from CoinGecko, sampled
// every 2nd point (85 waypoints, ~5px between steps for fine granularity),
// mapped to viewBox y=86..170 (lower y = higher price), then linearly
// detrended AND seam-slope-matched: |y[1]-y[0]| equals |y[N-1]-y[N-2]|, so
// the wrap point shows no kink — the price flows continuously across loops.
// The mid-series rally from ~$2300 to the $2415 peak reads as a real
// out-of-range breakout above the LP band. Spans x=0..432; rendered twice
// (second copy translated +432) so translateX(-50%) of the 864-wide group
// cycles invisibly.
const PRICE_PATH =
  "M 0 140.9 L 5.1 135.6 L 10.3 128.4 L 15.4 145.5 L 20.6 156.3 L 25.7 165.0 " +
  "L 30.9 170.8 L 36.0 165.2 L 41.1 167.7 L 46.3 164.7 L 51.4 163.4 L 56.6 158.4 " +
  "L 61.7 151.8 L 66.9 143.0 L 72.0 162.0 L 77.1 155.0 L 82.3 132.8 L 87.4 130.6 " +
  "L 92.6 142.6 L 97.7 141.6 L 102.9 149.5 L 108.0 146.2 L 113.1 143.9 L 118.3 140.6 " +
  "L 123.4 134.8 L 128.6 151.3 L 133.7 154.5 L 138.9 150.3 L 144.0 148.9 L 149.1 144.6 " +
  "L 154.3 149.6 L 159.4 141.4 L 164.6 111.9 L 169.7 117.3 L 174.9 98.9 L 180.0 101.6 " +
  "L 185.1 100.2 L 190.3 90.7 L 195.4 91.4 L 200.6 102.8 L 205.7 95.6 L 210.9 99.7 " +
  "L 216.0 95.8 L 221.1 112.9 L 226.3 124.9 L 231.4 128.2 L 236.6 123.7 L 241.7 133.3 " +
  "L 246.9 150.0 L 252.0 141.3 L 257.1 137.7 L 262.3 142.9 L 267.4 153.8 L 272.6 144.6 " +
  "L 277.7 139.2 L 282.9 140.0 L 288.0 147.3 L 293.1 155.7 L 298.3 154.2 L 303.4 150.0 " +
  "L 308.6 149.6 L 313.7 145.9 L 318.9 152.4 L 324.0 151.4 L 329.1 148.8 L 334.3 143.9 " +
  "L 339.4 153.5 L 344.6 151.4 L 349.7 150.5 L 354.9 150.9 L 360.0 151.2 L 365.1 149.7 " +
  "L 370.3 149.6 L 375.4 153.7 L 380.6 152.0 L 385.7 156.5 L 390.9 155.1 L 396.0 154.4 " +
  "L 401.1 151.2 L 406.3 154.1 L 411.4 153.6 L 416.6 151.8 L 421.7 144.5 L 426.9 146.2 " +
  "L 432.0 140.9";

// Particle delays (seconds; all keyframes are 9s loops). 8 USDC particles
// spread evenly across 0-4.5s so they continuously emit during the
// price-up phase. 8 ETH particles use the same staggers (their keyframe
// is dormant 0-50%, active 50-100%).
const USDC_OUT_DELAYS = [0, 0.55, 1.1, 1.65, 2.2, 2.75, 3.3, 3.85];
const ETH_OUT_DELAYS  = [0, 0.55, 1.1, 1.65, 2.2, 2.75, 3.3, 3.85];
// Inbound rebalance: 2 particles each side, 0.18s jitter so they don't
// look like a single fat blob arriving at the band.
const REBAL_USDC_DELAYS = [0, 0.18];
const REBAL_ETH_DELAYS  = [0, 0.18];

function StrategyViz() {
  const [hoveredBand, setHoveredBand] = useState<"narrow" | "wide" | null>(null);
  // Keep the last band label so the callout text doesn't blank out
  // mid-fade-out — only update on hover-enter, never on hover-leave.
  const [lastBandLabel, setLastBandLabel] = useState<string>("");
  const enterBand = (b: "narrow" | "wide") => {
    setHoveredBand(b);
    setLastBandLabel(b === "wide" ? "Wide" : "Narrow");
  };
  const leaveBand = () => setHoveredBand(null);

  // The SVG's viewBox is 256×256 but only the rectangle x=12..236, y=20..216
  // contains real content (y-ticks, chart frame, bands, price line). At
  // 216/256 render scale that's a ~189×166 visible region with ~14px of
  // empty padding on top, ~34px on bottom, and ~14px on each side. Rather
  // than re-coord the whole viz, we leave the SVG at 216×216 and translate
  // it up-and-left inside a smaller wrapper that crops the empty borders —
  // so content sits flush with the wrapper edge, matching the inner
  // margin of text in other cards.
  // Wrapper sized so the chart-frame's outer stroke edge sits flush with
  // the wrapper edges. Slightly smaller than the prior 184×150 so the
  // sim card doesn't push Strategy out of proportion.
  const W = 168;
  const H = 138;
  const SHIFT_X = -16;
  const SHIFT_Y = -33;

  return (
    <div
      className="strategy-viz"
      aria-hidden
      style={{ position: "relative", width: W, height: H, overflow: "hidden" }}
    >
      <svg
        width={216}
        height={216}
        viewBox="0 0 256 256"
        style={{ position: "absolute", left: SHIFT_X, top: SHIFT_Y, overflow: "visible" }}
      >
        <defs>
          <clipPath id="strategy-window">
            <rect x={20} y={40} width={216} height={176} rx={10} />
          </clipPath>
        </defs>

        {/* Frame — shaded bg (matches the ALPS center card tint), no
            border. */}
        <rect
          x={20}
          y={40}
          width={216}
          height={176}
          rx={10}
          fill="rgba(255,255,255,0.06)"
        />

        <g clipPath="url(#strategy-window)">
          {/* WIDE range — slow Bollinger (k=3, 40-period). Sits BEHIND
              the narrow range. Greyscale tint; brightens on hover. */}
          <g
            className="animate-band-wide-volatility"
            onMouseEnter={() => enterBand("wide")}
            onMouseLeave={leaveBand}
            style={{ cursor: "pointer" }}
          >
            <rect
              x={20}
              y={104}
              width={216}
              height={48}
              fill={hoveredBand === "wide" ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)"}
              rx={6}
              style={{ transition: "fill 200ms ease-out" }}
            />
            <line
              x1={20}
              x2={236}
              y1={104}
              y2={104}
              stroke={hoveredBand === "wide" ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.28)"}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              style={{ transition: "stroke 200ms ease-out" }}
            />
            <line
              x1={20}
              x2={236}
              y1={152}
              y2={152}
              stroke={hoveredBand === "wide" ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.28)"}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              style={{ transition: "stroke 200ms ease-out" }}
            />
          </g>

          {/* NARROW range — aggressive Bollinger (k=2, 20-period). Sits on
              top of WIDE; deeper greyscale shade + dashed edges to read
              as the tighter inner envelope. Brightens on hover. */}
          <g
            className="animate-band-volatility"
            onMouseEnter={() => enterBand("narrow")}
            onMouseLeave={leaveBand}
            style={{ cursor: "pointer" }}
          >
            <rect
              x={20}
              y={104}
              width={216}
              height={48}
              fill={hoveredBand === "narrow" ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.10)"}
              rx={4}
              style={{ transition: "fill 200ms ease-out" }}
            />
            <line
              x1={20}
              x2={236}
              y1={104}
              y2={104}
              stroke={hoveredBand === "narrow" ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.50)"}
              strokeWidth={1}
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
              style={{ transition: "stroke 200ms ease-out" }}
            />
            <line
              x1={20}
              x2={236}
              y1={152}
              y2={152}
              stroke={hoveredBand === "narrow" ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.50)"}
              strokeWidth={1}
              strokeDasharray="3 4"
              vectorEffect="non-scaling-stroke"
              style={{ transition: "stroke 200ms ease-out" }}
            />
          </g>

          {/* Price line — random walk, drifts continuously leftward. The
              path is rendered twice (second copy translated by 432 units)
              so translateX(-50%) of the 864-wide group is a seamless loop. */}
          <g className="animate-price-drift" style={{ transformOrigin: "0 0" }}>
            <path
              d={PRICE_PATH}
              fill="none"
              stroke="rgba(255,255,255,0.85)"
              strokeWidth={1.25}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <g transform="translate(432 0)">
              <path
                d={PRICE_PATH}
                fill="none"
                stroke="rgba(255,255,255,0.85)"
                strokeWidth={1.25}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          </g>
        </g>
      </svg>

      {/* Top-right callout — labels which range the user is hovering.
          Same styling as the corner-UI pills (TotalDeposits' "$3.26M"). */}
      <div
        aria-hidden
        className="bg-white/10 text-haze inline-flex items-center justify-center"
        style={{
          ...PILL_BOX,
          position: "absolute",
          top: 8,
          right: 10,
          opacity: hoveredBand ? 1 : 0,
          transform: hoveredBand ? "translateY(0)" : "translateY(-4px)",
          transition: "opacity 180ms ease-out, transform 180ms ease-out",
          pointerEvents: "none",
        }}
      >
        {lastBandLabel}
      </div>
    </div>
  );
}

function LearnMoreContent({ open }: { open: boolean }) {
  return (
    <div
      className="absolute z-[25]"
      style={{
        top: "calc(20% + 36px)",
        left: "calc(20% + 36px)",
        right: "calc(20% + 36px)",
        bottom: "calc(20% + 36px)",
        display: "flex",
        flexDirection: "column",
        opacity: open ? 1 : 0,
        transition: "opacity 500ms cubic-bezier(0.16, 1, 0.3, 1)",
        pointerEvents: open ? "auto" : "none",
      }}
    >
      {/* Header -concrete fee stat over two lines, full container width.
          Subtitle delivers the why (infrastructure, not capital) and the
          resolution in one breath. */}
      <div>
        <h2
          style={{
            color: "#fff",
            fontFamily: "var(--font-radley)",
            fontSize: 46,
            lineHeight: 1.08,
            letterSpacing: "-0.01em",
            margin: 0,
            fontWeight: 400,
          }}
        >
          Swap volume created over $2B in fees in 2025.
          <br />
          We allow anyone to earn them.
        </h2>
        <p
          style={{
            color: "rgba(255,255,255,0.55)",
            fontFamily: "var(--font-radley)",
            fontSize: 16,
            lineHeight: 1.5,
            margin: "14px 0 0 0",
            maxWidth: "calc(50% - 7px)",
          }}
        >
          Most fees flow to actively managed positions held by sophisticated
          Liquidity Providers. Tapping into this yield requires infrastructure
          and knowledge - <BrandRef /> opens it up to anyone.
        </p>
      </div>

      {/* Bento — two independent columns. Each card is sized to its own
          content; nothing stretches to match siblings.
            left:  Summary on top,    Strategy below it
            right: Vault flow on top, Open App pinned bottom-right */}
      <div
        style={{
          display: "flex",
          gap: 14,
          marginTop: 14,
          flex: 1,
          minHeight: 0,
          alignItems: "flex-start",
        }}
      >
        {/* Left column — Summary on top, Built-on bars filling the rest */}
        <div
          style={{
            flex: 1,
            alignSelf: "stretch",
            display: "flex",
            flexDirection: "column",
            gap: 14,
            minWidth: 0,
          }}
        >
        <Card>
          <CardLabel icon="summary">Summary</CardLabel>
          <p
            style={{
              margin: "8px 0 0 0",
              color: "rgba(255,255,255,0.92)",
              fontFamily: "var(--font-radley)",
              fontSize: 18,
              lineHeight: 1.55,
            }}
          >
            You deposit{" "}
            <InlinePill iconImage={{ src: "/tokens/usdc.png", alt: "USDC" }}>
              USDC
            </InlinePill>{" "}
            and gain exposure to a{" "}
            <InlinePill icon="dots" tooltip={<PortfolioTooltip />}>
              portfolio
            </InlinePill>{" "}
            of active positions across high volume{" "}
            <InlinePill icon="gaming" tooltip={<PairsTooltip />}>
              pairs
            </InlinePill>
            . An{" "}
            <InlinePill
              icon="sparkles"
              tooltip="An agentic backend with rich context across markets, pools, and onchain conditions. Decides where to deploy, when to retighten, and when to rotate capital."
            >
              agent
            </InlinePill>{" "}
            continuously tightens these positions and rotates capital between
            pools to maximize fee earnings while managing{" "}
            <InlinePill
              icon="fingerprint"
              tooltip="Impermanent loss, range exits, and capital drift. The agent's rebalancing and rotation are designed to manage all three."
            >
              risk
            </InlinePill>
            .
          </p>
        </Card>

        {/* Built-on protocols — three sponsor/prize tracks ALP integrates
            with. Container fills the remaining left-column height so the
            last bar aligns with Open App's bottom. Uniswap takes a double
            row (flex 2) so the trio reads as a 4-row bento. */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 14,
            flex: 1,
            minHeight: 0,
            // Reserve room at the bottom so the last bar lines up with
            // Strategy's bottom (right column) instead of Open App's bottom.
            // Open App's outer height (~33px) + the 14px gap above it.
            marginBottom: 47,
          }}
        >
          {BUILT_ON.map((p, i) => (
            <div key={p.name} style={{ flex: i === 0 ? 2 : 1, display: "flex" }}>
              <BuiltOnBar {...p} />
            </div>
          ))}
        </div>
        </div>

        {/* Right column — Vault flow on top, Strategy/sim row, Open App
            pinned bottom-right. alignSelf:stretch so the column fills the
            bento's height (overriding the parent's alignItems:flex-start)
            — needed for marginTop:auto on Open App to push it to the
            actual bottom of the LMC, matching the right-edge margin. */}
        <div
          style={{
            flex: 1,
            alignSelf: "stretch",
            display: "flex",
            flexDirection: "column",
            gap: 14,
            minWidth: 0,
          }}
        >
          {/* Vault flow — top of right column. The orbital viz is lifted
              with a negative margin so its rings visually align with the
              card title row instead of sitting below it. */}
          <Card>
            <CardLabel icon="vault">Vault flow</CardLabel>
            <div
              style={{
                display: "flex",
                gap: 18,
                marginTop: 12,
                alignItems: "flex-start",
                flex: 1,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3
                  style={{
                    color: "#fff",
                    fontFamily: "var(--font-radley)",
                    fontSize: 22,
                    lineHeight: 1.1,
                    letterSpacing: "-0.005em",
                    margin: 0,
                    fontWeight: 400,
                  }}
                >
                  Where your deposit goes.
                </h3>
                <p
                  style={{
                    marginTop: 8,
                    color: "rgba(255,255,255,0.62)",
                    fontFamily: "var(--font-radley)",
                    fontSize: 15,
                    lineHeight: 1.55,
                  }}
                >
                  The vault deploys capital into our portfolio of active
                  liquidity positions and idle operative liquidity. An
                  agent rebalances active positions and uses the idle
                  reserve for withdrawals and rotations.
                </p>
                <PortfolioPies />
              </div>
              <div style={{ flexShrink: 0, marginTop: -18 }}>
                <VaultFlow />
              </div>
            </div>
          </Card>

          {/* Strategy (text) + ETH/USDC sim (square) — split into two
              side-by-side cards so the row's height isn't dictated by
              the viz alone. */}
          <div style={{ display: "flex", gap: 14, alignItems: "stretch" }}>
            <Card style={{ flex: 1, minWidth: 0 }}>
              <CardLabel icon="strategy">Strategy</CardLabel>
              <div style={{ marginTop: 12, flex: 1, minWidth: 0 }}>
                <h3
                  style={{
                    color: "#fff",
                    fontFamily: "var(--font-radley)",
                    fontSize: 22,
                    lineHeight: 1.1,
                    letterSpacing: "-0.005em",
                    margin: 0,
                    fontWeight: 400,
                  }}
                >
                  Beating IL and LVR.
                </h3>
                <p
                  style={{
                    marginTop: 8,
                    color: "rgba(255,255,255,0.62)",
                    fontFamily: "var(--font-radley)",
                    fontSize: 15,
                    lineHeight: 1.55,
                  }}
                >
                  Concentrated LPs earn the most fees but bleed to IL and
                  LVR. Our agents retighten ranges and rotate capital so
                  fees stay ahead of both costs.
                </p>
              </div>
            </Card>

            <Card
              style={{
                flexShrink: 0,
                padding: 18,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <StrategyViz />
            </Card>
          </div>

          {/* Open App — marginTop:auto pushes it to the bottom of the
              right column regardless of Strategy's content height. */}
          <div
            style={{
              marginTop: "auto",
              display: "flex",
              justifyContent: "flex-end",
              alignItems: "center",
              gap: 8,
            }}
          >
            {/* Ghost secondary — GitHub icon square button. Same chrome
                as the BuiltWith heart-icon (bg-white/10, text-haze). */}
            <a
              href="https://github.com/yanisepfl/alp"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="View source on GitHub"
              className="bg-white/10 text-haze transition-colors duration-200 ease-out hover:text-mist hover:bg-white/[0.18]"
              style={{
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 36,
                height: 36,
                borderRadius: 14,
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 32 32"
                fill="currentColor"
                aria-hidden
                style={{ display: "block" }}
              >
                <path d="M16,2.345c7.735,0,14,6.265,14,14-.002,6.015-3.839,11.359-9.537,13.282-.7,.14-.963-.298-.963-.665,0-.473,.018-1.978,.018-3.85,0-1.312-.437-2.152-.945-2.59,3.115-.35,6.388-1.54,6.388-6.912,0-1.54-.543-2.783-1.435-3.762,.14-.35,.63-1.785-.14-3.71,0,0-1.173-.385-3.85,1.435-1.12-.315-2.31-.472-3.5-.472s-2.38,.157-3.5,.472c-2.677-1.802-3.85-1.435-3.85-1.435-.77,1.925-.28,3.36-.14,3.71-.892,.98-1.435,2.24-1.435,3.762,0,5.355,3.255,6.563,6.37,6.913-.403,.35-.77,.963-.893,1.872-.805,.368-2.818,.963-4.077-1.155-.263-.42-1.05-1.452-2.152-1.435-1.173,.018-.472,.665,.017,.927,.595,.332,1.277,1.575,1.435,1.978,.28,.787,1.19,2.293,4.707,1.645,0,1.173,.018,2.275,.018,2.607,0,.368-.263,.787-.963,.665-5.719-1.904-9.576-7.255-9.573-13.283,0-7.735,6.265-14,14-14Z" />
              </svg>
            </a>
            <Link
              href="/app"
              className="bg-white/[0.20] transition-colors duration-300 ease-out hover:bg-white/[0.32]"
              style={{
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 9,
                padding: "10px 16px 10px 18px",
                borderRadius: 14,
                color: "#fff",
                lineHeight: 1,
              }}
            >
              <span
                style={{
                  fontFamily: "var(--sans-stack)",
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "-0.005em",
                  lineHeight: 1,
                }}
              >
                Open App
              </span>
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
                style={{ display: "block", position: "relative", top: 1 }}
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function BuiltWith() {
  return (
    <a
      href="#"
      className="reveal absolute z-30 flex items-center gap-1.5 text-xs text-haze group"
      style={{
        top: "calc(80% + 12px)",
        right: "20%",
        animationDelay: "2600ms",
        textDecoration: "none",
      }}
    >
      <span>Built with</span>
      <span
        className="inline-flex items-center justify-center bg-white/10"
        style={{ width: 16, height: 16, borderRadius: 4 }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="currentColor"
          className="text-haze transition-colors duration-200 group-hover:text-[#ef4444]"
          style={{ display: "block" }}
          aria-hidden
        >
          <path d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
        </svg>
      </span>
      <span>at ETHGlobal</span>
    </a>
  );
}

export function LandingFace({
  learnMore,
  onToggleLearnMore,
}: {
  learnMore: boolean;
  onToggleLearnMore: () => void;
}) {
  return (
    <>
      {/* Single lockup -appears at center large, glides to top-left while shrinking */}
      <div
        className="glide-and-shrink absolute z-30 flex items-center gap-1.5"
        style={{ top: "calc(20% - 48px)", left: "20%" }}
      >
        <div aria-hidden className="lift h-[36px] w-[36px]" style={MASK_STYLE} />
        <span
          className="lift"
          style={{
            color: "#fff",
            fontFamily: "var(--font-radley)",
            fontSize: "36px",
            lineHeight: 1,
            fontWeight: 400,
            letterSpacing: "-0.02em",
            animationDelay: "180ms",
          }}
        >
          alps
        </span>
      </div>

      {/* Catchphrase + arrow — fades out when Learn-more takes the centre. */}
      <div
        className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-6"
        style={{
          opacity: learnMore ? 0 : 1,
          transition: "opacity 500ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <CatchphraseLink disabled={learnMore} />
      </div>

      {/* Bottom-left entry into Learn-more (only in default state). */}
      <HowItWorks disabled={learnMore} onClick={onToggleLearnMore} />

      {/* Learn-more overlay (headline + body + secondary Open App) */}
      <LearnMoreContent open={learnMore} />

      <TotalDeposits />
      <LearnMore open={learnMore} onClick={onToggleLearnMore} />
      <BuiltWith />
    </>
  );
}
