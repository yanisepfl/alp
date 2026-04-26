"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";

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
  { slug: "USDC",  src: "/tokens/usdc.png",  color: "#2775CA", amount: "$1.20M" },
  { slug: "WETH",  src: "/tokens/weth.png",  color: "#627EEA", amount: "$850K"  },
  { slug: "cbBTC", src: "/tokens/cbbtc.png", color: "#F7931A", amount: "$620K"  },
  { slug: "AERO",  src: "/tokens/aero.png",  color: "#5B83F4", amount: "$245K"  },
  { slug: "DAI",   src: "/tokens/dai.png",   color: "#F5AC37", amount: "$145K"  },
];

// 40-point yield series, fractional values 0–5 (chart row count).
const APY_SERIES = [
  2.1, 2.3, 3.0, 2.8, 3.2, 3.4, 3.5, 3.7,
  3.6, 4.0, 4.1, 4.2, 4.3, 4.5, 4.4, 4.6,
  4.7, 4.8, 4.9, 4.8, 5.0, 5.1, 5.0, 5.2,
  5.1, 5.3, 5.2, 5.4, 5.3, 5.4, 5.5, 5.4,
  5.5, 5.4, 5.5, 5.4, 5.5, 5.4, 5.4, 5.4,
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

const DOT_EMPTY = 0.08;
const DOT_FULL = 0.82;
const DOT_HOVER_LIT = 1.0;
const DOT_HOVER_DIM = 0.22;
// When a column is being hovered, all other columns dim down so the
// hovered bar reads as the focus.
const DOT_FULL_INACTIVE = 0.16;
const DOT_EMPTY_INACTIVE = 0.04;

function DotMatrixChart({
  values,
  rows = 5,
  dot = 2,
  gap = 1,
  hoverIdx = null,
  onHover,
}: {
  values: number[];
  rows?: number;
  dot?: number;
  gap?: number;
  hoverIdx?: number | null;
  onHover?: (idx: number | null) => void;
}) {
  const cols = values.length;
  const w = cols * (dot + gap) - gap;
  const h = rows * (dot + gap) - gap;
  const stride = dot + gap;

  const handleMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!onHover) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const idx = Math.max(0, Math.min(Math.floor(x / stride), cols - 1));
    onHover(idx);
  };

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden
      style={{ display: "block", overflow: "visible" }}
      onMouseMove={onHover ? handleMove : undefined}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
    >
      {values.flatMap((v, c) => {
        const anyHover = hoverIdx !== null;
        const isHover = c === hoverIdx;
        return Array.from({ length: rows }).map((_, r) => {
          const rowFromBottom = rows - r;
          const lit = v >= rowFromBottom;
          const opacity = isHover
            ? lit ? DOT_HOVER_LIT : DOT_HOVER_DIM
            : anyHover
              ? lit ? DOT_FULL_INACTIVE : DOT_EMPTY_INACTIVE
              : lit ? DOT_FULL : DOT_EMPTY;
          return (
            <circle
              key={`${c}-${r}`}
              cx={c * stride + dot / 2}
              cy={r * stride + dot / 2}
              r={dot / 2}
              fill="#fff"
              style={{
                opacity,
                transition: "opacity 260ms cubic-bezier(0.16, 1, 0.3, 1)",
              }}
            />
          );
        });
      })}
    </svg>
  );
}

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
        left: "20%",
        animationDelay: "2600ms",
      }}
    >
      {/* Collapsed view */}
      <div
        className="absolute top-0 left-0 flex items-center gap-1.5 whitespace-nowrap text-xs text-haze"
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
        className="absolute top-0 left-0 flex items-center gap-1.5 whitespace-nowrap text-xs text-haze"
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

function CurrentYield() {
  const [expanded, setExpanded] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const idx = hoverIdx !== null ? hoverIdx : APY_SERIES.length - 1;
  const display = `${APY_SERIES[idx].toFixed(1)}%`;

  return (
    <div
      className="reveal absolute z-30"
      style={{
        top: "calc(20% - 28px)",
        right: "20%",
        animationDelay: "2700ms",
      }}
    >
      {/* Collapsed view */}
      <div
        className="absolute top-0 right-0 flex items-center gap-1.5 whitespace-nowrap"
        style={{
          opacity: expanded ? 0 : 1,
          transform: expanded ? "translateY(-100%)" : "translateY(0)",
          pointerEvents: expanded ? "none" : "auto",
          transition: SWITCH_TRANSITION,
        }}
      >
        <span className="text-xs text-haze">Current Yield</span>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="inline-flex items-center justify-center bg-white/10 text-haze transition-colors duration-200 hover:text-white"
          style={{ ...PILL_BOX, border: "none" }}
        >
          5.4%
        </button>
      </div>

      {/* Expanded view -chart + value + close */}
      <div
        className="absolute top-0 right-0 flex items-center gap-2 whitespace-nowrap"
        style={{
          opacity: expanded ? 1 : 0,
          transform: expanded ? "translateY(0)" : "translateY(100%)",
          pointerEvents: expanded ? "auto" : "none",
          transition: SWITCH_TRANSITION,
        }}
      >
        <DotMatrixChart
          values={APY_SERIES}
          rows={5}
          dot={2}
          gap={1}
          hoverIdx={hoverIdx}
          onHover={setHoverIdx}
        />
        <span
          className="text-haze"
          style={{ fontSize: "11px", fontWeight: 500, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}
        >
          {display}
        </span>
        <CloseButton onClick={() => setExpanded(false)} />
      </div>
    </div>
  );
}

function LearnMore({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="reveal absolute z-30 flex items-center gap-1.5 text-xs text-haze transition-colors hover:text-mist"
      style={{
        top: "calc(80% + 12px)",
        left: "20%",
        animationDelay: "2700ms",
        background: "transparent",
        border: "none",
        padding: 0,
      }}
    >
      <span>Learn more</span>
      <span
        className="inline-flex items-center justify-center bg-white/10"
        style={{ width: 16, height: 16, borderRadius: 4, position: "relative", top: "1px" }}
      >
        {open ? (
          <svg
            width="9"
            height="9"
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
        ) : (
          <svg
            width="10"
            height="10"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ display: "block", marginLeft: "-1px" }}
            aria-hidden
          >
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        )}
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
const PORTFOLIO_TOKENS = [
  { slug: "USDC",  src: "/tokens/usdc.png"  },
  { slug: "USDT",  src: "/tokens/usdt.png"  },
  { slug: "DAI",   src: "/tokens/dai.png"   },
  { slug: "WETH",  src: "/tokens/weth.png"  },
  { slug: "ETH",   src: "/tokens/eth.png"   },
  { slug: "cbBTC", src: "/tokens/cbbtc.png" },
  { slug: "UNI",   src: "/tokens/uni.png"   },
];

const POOL_PAIRS = [
  { left: "/tokens/eth.png",   right: "/tokens/usdc.png"   },
  { left: "/tokens/cbbtc.png", right: "/tokens/usdc.png"   },
  { left: "/tokens/usdc.png",  right: "/tokens/usdt.png"   },
  { left: "/tokens/weth.png",  right: "/tokens/cbbtc.png"  },
  { left: "/tokens/usdc.png",  right: "/tokens/dai.png"    },
  { left: "/tokens/uni.png",   right: "/tokens/usdc.png"   },
];

function PortfolioTooltip() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, auto)", gap: "10px 18px" }}>
      {PORTFOLIO_TOKENS.map((t) => (
        <div key={t.slug} style={{ display: "flex", alignItems: "center", gap: 7 }}>
          <Image
            src={t.src}
            alt={t.slug}
            width={18}
            height={18}
            style={{ borderRadius: 999, flexShrink: 0 }}
          />
          <span style={{ fontFamily: "var(--font-radley)", fontSize: 13, lineHeight: 1, color: "rgba(255,255,255,0.92)" }}>
            {t.slug}
          </span>
        </div>
      ))}
    </div>
  );
}

// 3×2 grid (was 4×2) since AERO pairs were dropped. Pair entries render as
// the overlapping coin pair only; no text label per the user's request.
function PairsTooltip() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, auto)", gap: "12px 18px" }}>
      {POOL_PAIRS.map((p, i) => (
        <span
          key={i}
          style={{ width: 30, height: 20, position: "relative", flexShrink: 0, display: "inline-block" }}
          aria-hidden
        >
          <Image src={p.left} alt="" width={20} height={20} style={{ borderRadius: 999, position: "absolute", left: 0, top: 0 }} />
          <Image src={p.right} alt="" width={20} height={20} style={{ borderRadius: 999, position: "absolute", left: 12, top: 0 }} />
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
        borderRadius: 999,
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
const ORBIT_TOKENS = [
  { slug: "USDC",  src: "/tokens/usdc.png",  pct: "39%", note: "stable leg",      angle: -90  },
  { slug: "WETH",  src: "/tokens/weth.png",  pct: "28%", note: "ETH/USDC pool",   angle: -18  },
  { slug: "cbBTC", src: "/tokens/cbbtc.png", pct: "20%", note: "cbBTC/USDC pool", angle:  54  },
  { slug: "AERO",  src: "/tokens/aero.png",  pct: "8%",  note: "AERO/USDC pool",  angle: 126  },
  { slug: "DAI",   src: "/tokens/dai.png",   pct: "5%",  note: "stable leg",      angle: -162 },
];

function VaultFlow() {
  const [hover, setHover] = useState<string | null>(null);
  const SIZE = 216;
  const CENTER = SIZE / 2;
  const RADIUS = 76;
  const CHIP = 30;

  const hovered = ORBIT_TOKENS.find((t) => t.slug === hover);

  return (
    <div
      onMouseLeave={() => setHover(null)}
      style={{ position: "relative", width: SIZE, height: SIZE }}
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
            end at the chip edge, leaving the squares uncovered. Both squares
            are 52px (center) and 30px (chip), half-sizes 26 and 15. The
            distance from a square's center to its edge along an angle θ is
            half_size / max(|cos θ|, |sin θ|). Adding a 2px breathing gap. */}
        {ORBIT_TOKENS.map((t) => {
          const rad = (t.angle * Math.PI) / 180;
          const m = Math.max(Math.abs(Math.cos(rad)), Math.abs(Math.sin(rad)));
          const startDist = 26 / m + 2;
          const endDist = RADIUS - 15 / m - 2;
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
          left: CENTER - 26,
          top: CENTER - 26,
          width: 52,
          height: 52,
          borderRadius: 14,
          background: "rgba(255,255,255,0.10)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div aria-hidden style={{ width: 26, height: 26, ...MASK_STYLE }} />
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
              borderRadius: 10,
              background: "rgba(255,255,255,0.10)",
              border: "none",
              padding: 0,
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
            <Image src={t.src} alt="" width={20} height={20} />
          </button>
        );
      })}

      {/* Caption — only renders the hovered token's info; nothing by default. */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: CENTER + 34,
          textAlign: "center",
          color: "rgba(255,255,255,0.55)",
          fontFamily: "var(--sans-stack)",
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: "0.02em",
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          opacity: hovered ? 1 : 0,
          transition: "opacity 220ms cubic-bezier(0.16, 1, 0.3, 1)",
          pointerEvents: "none",
        }}
      >
        {hovered ? `${hovered.slug} · ${hovered.pct} · ${hovered.note}` : ""}
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
function StrategyViz() {
  // Outer wrapper rendered at 216×216 to match VaultFlow. Internal SVG keeps
  // its 256×256 viewBox so the price path + frame coords stay valid; SVG
  // scales automatically.
  const SIZE = 216;
  const VIEW = 256;
  // Price path drawn at 2× window width so translateX(-50%) loops seamlessly.
  // Smooth quadratic-Bezier sine, period 72, range ±28 around y=128.
  const PRICE_PATH =
    "M 0 128 Q 18 100 36 128 Q 54 156 72 128 Q 90 100 108 128 Q 126 156 144 128 " +
    "Q 162 100 180 128 Q 198 156 216 128 Q 234 100 252 128 Q 270 156 288 128 " +
    "Q 306 100 324 128 Q 342 156 360 128 Q 378 100 396 128 Q 414 156 432 128";

  return (
    <div
      className="strategy-viz"
      aria-hidden
      style={{ position: "relative", width: SIZE, height: SIZE }}
    >
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
      >
        <defs>
          <clipPath id="strategy-window">
            <rect x={20} y={40} width={216} height={176} rx={10} />
          </clipPath>
        </defs>

        {/* Frame -dashed outline of the chart window, vocabulary match w/ VaultFlow ring */}
        <rect
          x={20}
          y={40}
          width={216}
          height={176}
          rx={10}
          fill="none"
          stroke="rgba(255,255,255,0.10)"
          strokeWidth={1}
          strokeDasharray="2 4"
        />

        {/* Y-axis tick marks (3) */}
        {[72, 128, 184].map((y) => (
          <line
            key={y}
            x1={16}
            x2={20}
            y1={y}
            y2={y}
            stroke="rgba(255,255,255,0.20)"
            strokeWidth={1}
          />
        ))}

        <g clipPath="url(#strategy-window)">
          {/* Range band -translucent fill + dashed top/bottom edges. Snaps
              up at 50%, back at 100%. */}
          <g className="animate-band-rebal" style={{ transformOrigin: "0 0", transformBox: "fill-box" }}>
            <rect
              x={20}
              y={104}
              width={216}
              height={48}
              fill="rgba(255,255,255,0.06)"
              rx={4}
            />
            <line
              x1={20}
              x2={236}
              y1={104}
              y2={104}
              stroke="rgba(255,255,255,0.40)"
              strokeWidth={1}
              strokeDasharray="3 4"
            />
            <line
              x1={20}
              x2={236}
              y1={152}
              y2={152}
              stroke="rgba(255,255,255,0.40)"
              strokeWidth={1}
              strokeDasharray="3 4"
            />
          </g>

          {/* Price line -drifts continuously leftward */}
          <g className="animate-price-drift" style={{ transformOrigin: "0 0" }}>
            <path
              d={PRICE_PATH}
              fill="none"
              stroke="rgba(255,255,255,0.85)"
              strokeWidth={1.25}
              strokeLinecap="round"
            />
          </g>
        </g>
      </svg>

      {/* Top-left label cluster -pair name + agent dot */}
      <div
        style={{
          position: "absolute",
          left: 20,
          top: 20,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          className="animate-agent-flash"
          style={{
            width: 6,
            height: 6,
            borderRadius: 999,
            background: "#fff",
            display: "inline-block",
            transformOrigin: "center",
          }}
        />
        <span
          style={{
            color: "rgba(255,255,255,0.55)",
            fontFamily: "var(--sans-stack)",
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: "0.04em",
            lineHeight: 1,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          ETH/USDC
        </span>
      </div>

      {/* Bottom-right fee-tick chip -fades in just after each rebalance */}
      <div
        className="animate-fee-tick"
        style={{
          position: "absolute",
          right: 20,
          bottom: 20,
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          height: 18,
          padding: "0 7px 0 6px",
          borderRadius: 999,
          background: "rgba(255,255,255,0.10)",
          color: "rgba(255,255,255,0.85)",
          fontFamily: "var(--sans-stack)",
          fontSize: 11,
          fontWeight: 500,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.01em",
        }}
      >
        <StrokeIcon kind="spark" size={9} opacity={0.85} />
        +0.04 fees
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
          Until now, those fees flowed to actively managed positions held by
          sophisticated Liquidity Providers. Tapping into this yield requires
          infrastructure and knowledge - <BrandRef /> opens it up to anyone.
        </p>
      </div>

      {/* Summary card - capped at half-width. Title + subtitle have already
          posed the gap and the resolution; Summary delivers the concrete
          mechanism - the user journey from deposit to compounding fees. */}
      <Card style={{ marginTop: 18, maxWidth: "calc(50% - 7px)" }}>
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

      {/* Subsegments row -vault flow + strategy, side by side. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 14,
          marginTop: 14,
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* Subsegment 1 -Vault flow */}
        <Card style={{ display: "flex", flexDirection: "column" }}>
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
                You deposit USDC. The vault splits it across pools on Base -
                ETH/USDC, cbBTC/USDC, others - so it sits where trades happen.
                Every swap routes a fee back into the vault. Withdraw anytime.
              </p>
            </div>
            <div style={{ flexShrink: 0 }}>
              <VaultFlow />
            </div>
          </div>
        </Card>

        {/* Subsegment 2 -Strategy */}
        <Card style={{ display: "flex", flexDirection: "column" }}>
          <CardLabel icon="strategy">Strategy</CardLabel>
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
                What the agents do.
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
                Prices move, and the price band where fees actually get paid
                moves with them. Agents watch where volume is concentrating,
                tighten ranges around it, and shift capital between pools when
                one starts paying more - closing the infrastructure gap.
              </p>
            </div>
            <div style={{ flexShrink: 0 }}>
              <StrategyViz />
            </div>
          </div>
        </Card>
      </div>

      {/* CTA -solid white pill, smaller radius, anchored bottom-right.
          The one high-contrast surface in the overlay. */}
      <div
        style={{
          marginTop: 16,
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
        }}
      >
        <Link
          href="/app"
          style={{
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            padding: "8px 14px",
            borderRadius: 12,
            background: "#fff",
            color: "#08080a",
            lineHeight: 1,
            transition: "background-color 220ms cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-radley)",
              fontSize: 14,
              fontWeight: 400,
              lineHeight: 1,
            }}
          >
            Open App
          </span>
          <svg
            width="12"
            height="12"
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
        </Link>
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
        style={{ top: "24px", left: "24px" }}
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

      {/* Catchphrase + arrow -fades out when Learn More takes the center */}
      <div
        className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-6"
        style={{
          opacity: learnMore ? 0 : 1,
          transition: "opacity 500ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      >
        <CatchphraseLink disabled={learnMore} />
      </div>

      {/* Learn-more overlay (headline + body + secondary Open App) */}
      <LearnMoreContent open={learnMore} />

      <TotalDeposits />
      <CurrentYield />
      <LearnMore open={learnMore} onClick={onToggleLearnMore} />
      <BuiltWith />
    </>
  );
}
