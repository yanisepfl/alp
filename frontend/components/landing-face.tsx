"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const WORDS = "Start earning from onchain volume".split(" ");
const ARROW_DELAY_MS = 2600 + (WORDS.length - 1) * 180 + 600 + 80;

// Cmd/ctrl/shift/alt-click and middle-click bypass our click handlers
// so they still behave as normal links.
function isPlainLeftClick(e: React.MouseEvent): boolean {
  return !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0;
}

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
  { slug: "UNI",  src: "/tokens/svg/uni.svg",  color: "#FF007A", amount: "$145K"  },
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

function CatchphraseLink({
  disabled = false,
  onAppNav,
}: {
  disabled?: boolean;
  onAppNav?: () => void;
}) {
  return (
    <Link
      href="/app"
      onClick={(e) => {
        if (disabled || !isPlainLeftClick(e)) return;
        e.preventDefault();
        onAppNav?.();
      }}
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

// "Built on top of" stack — 3 prize tracks. Two architectural layers:
//   AGENT layer: Gensyn (P2P comms between agent nodes) + KeeperHub
//                (trustless keeper that fires signed agent actions).
//   EXECUTION layer: Uniswap v4 hooks where the vault holds positions.
// Brand colour is used ONLY in the small chip, never as a row background
// (matches Vault flow's vocabulary — coloured chips on neutral chrome).
type BuiltOnEntry = {
  name: string;
  role: string;
  color: string;
  logoColor?: string;
  logoSrc?: string;
  logoSvg?: React.ReactNode;
  logoSvgViewBox?: string;
  link?: string;
};
const BUILT_ON: Record<"Uniswap" | "KeeperHub" | "Gensyn" | "X", BuiltOnEntry> = {
  X: {
    name: "X",
    role: "social context",
    color: "#000000",
    logoColor: "#FFFFFF",
    link: "https://x.com",
    logoSvgViewBox: "0 0 24 24",
    logoSvg: (
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    ),
  },
  Uniswap: {
    name: "Uniswap",
    role: "v4 hook + position manager",
    color: "#FF007A",
    logoSrc: "/tokens/svg/uni.svg",
    link: "https://developers.uniswap.org/docs",
  },
  KeeperHub: {
    name: "KeeperHub",
    role: "trustless trigger",
    color: "#00FF4F",
    logoColor: "#0B2A6B",
    link: "https://keeperhub.com",
    logoSvgViewBox: "0 0 318 500",
    logoSvg: (
      <>
        <path d="M317.77 204.279H226.98V295.069H317.77V204.279Z" fill="currentColor" />
        <path d="M204.28 90.79V0H113.49V90.79C113.456 120.879 101.488 149.725 80.2115 171.002C58.9355 192.278 30.0889 204.246 0 204.28V295.07C30.0889 295.104 58.9355 307.072 80.2115 328.348C101.488 349.625 113.456 378.471 113.49 408.56V499.35H204.28V408.56C204.28 378.075 197.445 347.977 184.279 320.482C171.113 292.987 151.95 268.793 128.2 249.68C151.948 230.563 171.109 206.367 184.275 178.871C197.441 151.374 204.277 121.276 204.28 90.79Z" fill="currentColor" />
      </>
    ),
  },
  Gensyn: {
    name: "Gensyn",
    role: "P2P node comms",
    color: "#F3B295",
    logoColor: "#1A1A1A",
    link: "https://gensyn.ai",
    logoSvgViewBox: "0 0 54 54",
    logoSvg: (
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        fill="currentColor"
        d="M53.2794 19.6761h-6.368v-6.4573h-6.3681v-6.45729h-6.3681v-6.438085h-14.1387v6.457305h-6.368v6.45727h-6.36811v6.4573h-6.330175v14.3368h6.368085v6.4573h6.3681v6.4573h6.3681v6.4573h14.1386v-6.4573h6.3681v-6.4573h6.3681v-6.4573h6.3681v-14.3368zm-13.4374 20.0638h-6.368v6.4573h-12.7173v-6.4573h-6.368v-6.4573h-6.36811v-12.8954h6.36811v-6.4573h6.368v-6.45731h12.7173v6.45731h6.368v6.4573h6.3681v12.8954h-6.3681z"
      />
    ),
  },
};

function StackViz({
  phaseIndex = -1,
  innerPhase = "title",
  completedPhases = new Set<number>(),
  barFillPercent = 40,
  poolRatios = [0.5, 0.5, 0.5],
}: {
  phaseIndex?: number;
  innerPhase?: "title" | "list" | "done" | "confirmed";
  completedPhases?: Set<number>;
  barFillPercent?: number;
  poolRatios?: number[];
} = {}) {
  const W = 200;
  const TOP_H = 116;
  const PANEL_W = 56;
  const EXEC_H = 74;
  const GAP = 16;
  const CHIP = 36;

  // Per-phase highlight state — mirrors the StackPreview row so the
  // panels (Context / Agent / Execution) and the chip-row visualisation
  // stay in lockstep with the typing animation on the left.
  const panelState = (i: number) => {
    const isActive = i === phaseIndex;
    const isGreen =
      completedPhases.has(i) || (isActive && innerPhase === "confirmed");
    // Only "pulse" the active panel during its working states (title /
    // list / done) — once green takes over the panel sits steady.
    return { isPulsing: isActive && !isGreen, isGreen };
  };

  const TOP_TOTAL = PANEL_W * 3 + GAP * 2;
  const TOP_OFFSET = (W - TOP_TOTAL) / 2;
  const ctxLeft = TOP_OFFSET;
  const ctxRight = ctxLeft + PANEL_W;
  const agtLeft = ctxRight + GAP;
  const agtRight = agtLeft + PANEL_W;
  const execLeft = agtRight + GAP;
  const execCx = execLeft + PANEL_W / 2;
  const execTop = TOP_H - EXEC_H;

  const chipArrowY = TOP_H / 2;
  const elbowY = 12;
  const ARROW = "rgba(255,255,255,0.62)";

  return (
    <div style={{ width: W, display: "flex", flexDirection: "column" }}>
      <div style={{ position: "relative", width: W, height: TOP_H }}>
        <div style={{ position: "absolute", left: ctxLeft, top: 0 }}>
          <TopPanel width={PANEL_W} height={TOP_H} label="Context" {...panelState(0)}>
            <BuiltOnChip entry={BUILT_ON.X} size={CHIP} tooltip="Twitter" />
            <BuiltOnChip entry={BUILT_ON.Uniswap} size={CHIP} tooltip="Uniswap API" />
          </TopPanel>
        </div>
        <div style={{ position: "absolute", left: agtLeft, top: 0 }}>
          <TopPanel width={PANEL_W} height={TOP_H} label="Agent" {...panelState(1)}>
            <BuiltOnChip entry={BUILT_ON.Gensyn} size={CHIP} tooltip="Gensyn AXL" />
            <BuiltOnChip entry={BUILT_ON.KeeperHub} size={CHIP} tooltip="KeeperHub" />
          </TopPanel>
        </div>
        <div style={{ position: "absolute", left: execLeft, top: execTop }}>
          <TopPanel width={PANEL_W} height={EXEC_H} label="Execution" {...panelState(2)}>
            <BuiltOnChip entry={BUILT_ON.Uniswap} size={CHIP} tooltip="Uniswap API" />
          </TopPanel>
        </div>

        <svg
          width={W}
          height={TOP_H}
          viewBox={`0 0 ${W} ${TOP_H}`}
          aria-hidden
          style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "visible" }}
        >
          <polyline
            points={`${(ctxRight + agtLeft) / 2 - 2},${chipArrowY - 3} ${(ctxRight + agtLeft) / 2 + 2},${chipArrowY} ${(ctxRight + agtLeft) / 2 - 2},${chipArrowY + 3}`}
            fill="none"
            stroke={ARROW}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          <path
            d={`M${agtRight + 6} ${elbowY} L${execCx - 10} ${elbowY} Q${execCx} ${elbowY} ${execCx} ${elbowY + 10} L${execCx} ${execTop - 9}`}
            fill="none"
            stroke="rgba(255,255,255,0.20)"
            strokeWidth={1.25}
            strokeDasharray="2 4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <polyline
            points={`${execCx - 3},${execTop - 9} ${execCx},${execTop - 5} ${execCx + 3},${execTop - 9}`}
            fill="none"
            stroke={ARROW}
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      <svg
        width={W}
        height={44}
        viewBox={`0 0 ${W} 44`}
        aria-hidden
        style={{ display: "block", overflow: "visible" }}
      >
        <path
          d={`M${execCx} 6 L${execCx} 10 Q${execCx} 20 ${execCx - 10} 20 L${W / 2 + 10} 20 Q${W / 2} 20 ${W / 2} 30 L${W / 2} 35`}
          fill="none"
          stroke="rgba(255,255,255,0.20)"
          strokeWidth={1.25}
          strokeDasharray="2 4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <polyline
          points={`${W / 2 - 3},35 ${W / 2},39 ${W / 2 + 3},35`}
          fill="none"
          stroke={ARROW}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      <div
        style={{
          width: W,
          background: "rgba(255,255,255,0.05)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
          // Real border (not inset shadow): backdrop-filter clips an inset stroke inside the curve.
          // border-box keeps outer width = W to stay flush with panels above.
          border: "1px solid rgba(255,255,255,0.06)",
          boxSizing: "border-box",
          borderRadius: 10,
          padding: 8,
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        <HoverChip label="Portfolio">
          <span
            aria-hidden
            style={{
              width: 52,
              height: 52,
              borderRadius: 11,
              background: "rgba(255,255,255,0.10)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <span aria-hidden style={{ width: 30, height: 30, ...MASK_STYLE }} />
          </span>
        </HoverChip>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, height: 18 }}>
            <HoverChip label={USDC_VAULT_ENTRY.name}>
              {renderChipFace(USDC_VAULT_ENTRY, 18)}
            </HoverChip>
            <span
              aria-hidden
              style={{
                flex: 1,
                height: 12,
                borderRadius: 4,
                background: "rgba(255,255,255,0.08)",
                position: "relative",
              }}
            >
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  height: "100%",
                  // Width is driven by the cycle pointer — fills change
                  // during phase 2's "confirmed" hold; transition gives
                  // a ~1.5s slide so the bar visibly rebalances.
                  width: `${barFillPercent}%`,
                  borderRadius: 4,
                  background: USDC_VAULT_ENTRY.color,
                  transition: "width 1500ms cubic-bezier(0.4, 0, 0.2, 1)",
                }}
              />
            </span>
          </div>
          <span
            aria-hidden
            style={{
              height: 1,
              background: "rgba(255,255,255,0.08)",
              borderRadius: 999,
            }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 5, height: 18 }}>
            {POOL_PAIRS.slice(0, 3).map(([l, r], i) => (
              <PoolPairChip key={i} left={l} right={r} leftRatio={poolRatios[i] ?? 0.5} />
            ))}
            <PoolPlus />
          </div>
        </div>
      </div>
    </div>
  );
}

// Plain-language summary of what the agent has surfaced for each
// phase of the cycle: Twitter+Uniswap context, internal reasoning, and
// the resulting onchain actions. Module scope so the typing effect's
// closure has a stable reference.
const CONTEXT_BULLETS = [
  "• ETH bull thesis trending on Twitter",
  "• 12k posts mention $4K target by Friday",
  "• Major accounts shifting bullish",
  "• ETH/USDC volume up 12% in the last hour",
  "• Liquidity tightening near current price",
  "• BTC dominance debate intensifying",
  "• USDT/USDC arbitrage opportunity opening",
  "• Stablecoin pool fees holding steady",
];
const AGENT_BULLETS = [
  "• ETH momentum confirms bullish bias",
  "• Volume spike supports tighter ranges",
  "• USDT/USDC arb worth pursuing now",
  "• BTC correlation stable, safe to rotate",
  "• Liquidity squeeze favors concentrated LP",
  "• Tighten ETH/USDC range to 25 bps",
  "• Rotate 8% from UNI to BTC pool",
  "• Hold USDT/USDC peg arb for 20 min",
];
const EXECUTION_BULLETS = [
  "• Pulling ETH/USDC range 2180-2340",
  "• Burning LP token #48291, claiming fees",
  "• Swapping 2.4 ETH to USDC at 2287",
  "• Routing 8% to BTC/USDC pool",
  "• Minting new range 2270-2305, 25 bps",
  "• Opening USDT/USDC arb, 4 bps spread",
  "• Block 18249482, gas 24 gwei",
  "• Tx 0x9f3a confirmed, 2 blocks",
];

// Per-phase done-state icon. Two states only: a solid default colour
// while showing alongside the done message or as a preview in
// upcoming panels, and solid green once the phase is confirmed
// completed. Pen and Stars icons are fully solid; Performance keeps
// its outer rectangle at 0.4 for visual hierarchy between the frame
// and the chart line.
const PEN_ICON = (
  <>
    <path d="M5.493 3.49204L4.547 3.17704L4.23101 2.23005C4.12901 1.92405 3.622 1.92405 3.52 2.23005L3.20401 3.17704L2.25801 3.49204C2.10501 3.54304 2.00101 3.68603 2.00101 3.84803C2.00101 4.01003 2.10501 4.15305 2.25801 4.20405L3.20401 4.51905L3.52 5.46604C3.571 5.61904 3.71401 5.72202 3.87501 5.72202C4.03601 5.72202 4.18001 5.61804 4.23001 5.46604L4.54601 4.51905L5.492 4.20405C5.645 4.15305 5.74901 4.01003 5.74901 3.84803C5.74901 3.68603 5.646 3.54304 5.493 3.49204Z" />
    <path d="M16.658 12.99L15.395 12.569L14.974 11.306C14.837 10.898 14.162 10.898 14.025 11.306L13.604 12.569L12.341 12.99C12.137 13.058 11.999 13.249 11.999 13.464C11.999 13.679 12.137 13.87 12.341 13.938L13.604 14.359L14.025 15.622C14.093 15.826 14.285 15.964 14.5 15.964C14.715 15.964 14.906 15.826 14.975 15.622L15.396 14.359L16.659 13.938C16.863 13.87 17.001 13.679 17.001 13.464C17.001 13.249 16.862 13.058 16.658 12.99Z" />
    <path d="M7.75 2.5C8.164 2.5 8.5 2.164 8.5 1.75C8.5 1.336 8.164 1 7.75 1C7.336 1 7 1.336 7 1.75C7 2.164 7.336 2.5 7.75 2.5Z" />
    <path d="M11.414 2.84802L3.605 10.657C2.742 11.521 2.204 14.063 2.012 15.116C1.968 15.358 2.046 15.607 2.22 15.781C2.362 15.923 2.553 16.001 2.75 16.001C2.794 16.001 2.839 15.997 2.884 15.989C3.937 15.798 6.479 15.26 7.343 14.396L15.152 6.58702C16.182 5.55602 16.182 3.88002 15.152 2.84902C14.154 1.85102 12.412 1.85102 11.414 2.84802Z" />
  </>
);
const STARS_ICON = (
  <>
    <path d="M4.743 2.492L3.797 2.17699L3.481 1.22999C3.379 0.923988 2.872 0.923988 2.77 1.22999L2.45399 2.17699L1.508 2.492C1.355 2.543 1.25101 2.686 1.25101 2.848C1.25101 3.01 1.355 3.15299 1.508 3.20399L2.45399 3.51899L2.77 4.466C2.821 4.619 2.964 4.72199 3.125 4.72199C3.286 4.72199 3.43 4.618 3.48 4.466L3.79601 3.51899L4.742 3.20399C4.895 3.15299 4.99899 3.01 4.99899 2.848C4.99899 2.686 4.896 2.543 4.743 2.492Z" />
    <path d="M8.999 13.9639C8.999 13.1016 9.54881 12.3389 10.3672 12.0669L10.918 11.8833L11.1026 11.3311C11.3692 10.5342 12.1319 10 12.9991 10C13.3584 10 13.6887 10.1096 13.984 10.2732L16.7735 7.5542C16.9776 7.355 17.0518 7.0566 16.963 6.7852C16.8751 6.5137 16.6407 6.316 16.3575 6.2749L11.7384 5.6035L9.67301 1.418C9.41911 0.9063 8.58121 0.9063 8.32731 1.418L6.26191 5.6035L1.64281 6.2749C1.35961 6.3159 1.1252 6.5137 1.0373 6.7852C0.948397 7.0567 1.02271 7.355 1.22681 7.5542L4.5696 10.8125L3.77961 15.4131C3.73171 15.6943 3.847 15.979 4.0775 16.147C4.308 16.314 4.6146 16.3365 4.8675 16.2041L9.00031 14.0322L9.01101 14.0378C9.01001 14.0124 8.999 13.9896 8.999 13.9639Z" />
    <path d="M15.158 13.49L13.895 13.069L13.474 11.806C13.337 11.398 12.662 11.398 12.525 11.806L12.104 13.069L10.841 13.49C10.637 13.558 10.499 13.749 10.499 13.964C10.499 14.179 10.637 14.37 10.841 14.438L12.104 14.859L12.525 16.122C12.593 16.326 12.785 16.464 13 16.464C13.215 16.464 13.406 16.326 13.475 16.122L13.896 14.859L15.159 14.438C15.363 14.37 15.501 14.179 15.501 13.964C15.501 13.749 15.362 13.558 15.158 13.49Z" />
    <path d="M14.25 4C14.6642 4 15 3.66421 15 3.25C15 2.83579 14.6642 2.5 14.25 2.5C13.8358 2.5 13.5 2.83579 13.5 3.25C13.5 3.66421 13.8358 4 14.25 4Z" />
  </>
);
const PERFORMANCE_ICON = (
  <>
    <path
      fillOpacity="0.4"
      d="M3.75 2C2.23079 2 1 3.23079 1 4.75V13.25C1 14.7692 2.23079 16 3.75 16H14.25C15.7692 16 17 14.7692 17 13.25V4.75C17 3.23079 15.7692 2 14.25 2H3.75Z"
    />
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M13.5854 5.07916C13.9559 5.2644 14.1061 5.71491 13.9208 6.08539L11.6708 10.5854C11.5484 10.8302 11.3023 10.9889 11.0288 10.9994C10.7553 11.0099 10.4977 10.8706 10.3569 10.6359L9.5158 9.23403L8.15119 11.6221C8.02796 11.8377 7.80594 11.9784 7.5583 11.9977C7.31066 12.017 7.06953 11.9125 6.91436 11.7185L6.47425 11.1684L5.31444 12.4939C5.04168 12.8056 4.56786 12.8372 4.25613 12.5644C3.9444 12.2917 3.91282 11.8178 4.18558 11.5061L5.93558 9.5061C6.0818 9.33899 6.29455 9.24527 6.51654 9.25016C6.73854 9.25506 6.94695 9.35807 7.08566 9.53146L7.39631 9.91978L8.84883 7.37788C8.98095 7.14667 9.22576 7.00286 9.49203 7.00002C9.75831 6.99719 10.0061 7.13577 10.1431 7.36411L10.9402 8.69256L12.5792 5.41457C12.7644 5.04409 13.2149 4.89392 13.5854 5.07916Z"
    />
    <path d="M4.25 6C4.664 6 5 5.664 5 5.25C5 4.836 4.664 4.5 4.25 4.5C3.836 4.5 3.5 4.836 3.5 5.25C3.5 5.664 3.836 6 4.25 6Z" />
    <path d="M6.75 6C7.164 6 7.5 5.664 7.5 5.25C7.5 4.836 7.164 4.5 6.75 4.5C6.336 4.5 6 4.836 6 5.25C6 5.664 6.336 6 6.75 6Z" />
  </>
);

const PHASE_CONFIGS: {
  title: string;
  bullets: string[];
  doneText: string;
  icon: React.ReactNode;
}[] = [
  {
    title: "Gathering context...",
    bullets: CONTEXT_BULLETS,
    doneText: "Context.md updated",
    icon: PEN_ICON,
  },
  {
    title: "Thinking...",
    bullets: AGENT_BULLETS,
    doneText: "Strategy.md updated",
    icon: STARS_ICON,
  },
  {
    title: "Executing...",
    bullets: EXECUTION_BULLETS,
    doneText: "Position rebalanced",
    icon: PERFORMANCE_ICON,
  },
];

// USDC vault bar fill — 3 values cycled across 3 cycles. The first
// and last are identical so after a full loop the bar lands back where
// it started; the middle two are the "rebalanced" intermediate states.
const BAR_VALUES = [40, 56, 22];

// Per-pool left-token balance ratio across the 3-cycle loop.
// Shape: number[poolIndex][cycleIndex] — three pools (ETH/USDC,
// BTC/USDC, USDC/USDT) × three cycles. Cycle 0 is the 0.5/0.5 norm
// for every pool; cycles 1 and 2 drift to plausible LP imbalances.
// Because barIdx wraps 0→1→2→0, the chips return to the norm after
// every full loop. Each pool follows its own pattern so the three
// chips don't move in lockstep.
const POOL_RATIOS: number[][] = [
  [0.5, 0.58, 0.46], // ETH/USDC — ETH up then under
  [0.5, 0.44, 0.62], // BTC/USDC — BTC under then over
  [0.5, 0.52, 0.48], // USDC/USDT — gentle peg drift
];

// Three preview panels animating through the Context → Agent →
// Execution cycle. The active phase's panel grows from a square to
// fill the remaining row width, surfacing a title; the inactive two
// stay square. ResizeObserver measures the row so the active width
// adapts to the text column's actual rendered width. Cycle state
// (phaseIndex / innerPhase / completedPhases) is owned by the parent
// `StackBody` so the StackViz on the right can share it; this
// component is purely presentational for the preview row.
function StackPreview({
  open,
  phaseIndex,
  innerPhase,
  completedPhases,
}: {
  open: boolean;
  phaseIndex: number;
  innerPhase: "title" | "list" | "done" | "confirmed";
  completedPhases: Set<number>;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);

  useLayoutEffect(() => {
    if (!rowRef.current) return;
    const el = rowRef.current;
    const measure = () => setRowWidth(el.getBoundingClientRect().width);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Typing animation — when the "list" phase starts, walk through the
  // joined bullet text one character at a time. Base typing is fast
  // (a few ms per letter) but each char rolls a 5% chance of a
  // "thinking" lag, plus longer beats on newlines and punctuation, so
  // the cadence varies naturally without ever being mechanical.
  const [typedChars, setTypedChars] = useState(0);
  useEffect(() => {
    if (!open || innerPhase !== "list") {
      setTypedChars(0);
      return;
    }
    const fullText = PHASE_CONFIGS[phaseIndex].bullets.join("\n");
    let idx = 0;
    let timeoutId: ReturnType<typeof setTimeout>;
    const tick = () => {
      // Batch 1–2 chars per tick. Below ~4ms single-char delays the
      // browser's timer minimum kicks in, so batching keeps typing
      // visibly fast without monotony. Random batch size + variable
      // delays preserve a streaming-like rhythm.
      const batch = 1 + Math.floor(Math.random() * 2);
      idx = Math.min(idx + batch, fullText.length);
      setTypedChars(idx);
      if (idx >= fullText.length) return;
      const justTyped = fullText[idx - 1];
      let delay: number;
      if (justTyped === "\n") delay = 10 + Math.random() * 21;
      else if (/[.,;:!?$/]/.test(justTyped)) delay = 3 + Math.random() * 11;
      else delay = 1 + Math.random() * 5.5;
      // Occasional "thinking" lag — adds a longer pause to ~5% of
      // ticks so the typing rhythm has natural irregularity.
      if (Math.random() < 0.05) delay += 19 + Math.random() * 34;
      timeoutId = setTimeout(tick, delay);
    };
    timeoutId = setTimeout(tick, 60);
    return () => clearTimeout(timeoutId);
  }, [innerPhase, open, phaseIndex]);

  // Gate the done-area exit transitions. On entry to "done", styles
  // (text width, opacity, gap) snap to their done values with no
  // transition (avoids the icon-shift jump while the wrapper fades
  // in). After 100ms — once the entry has painted — transitions are
  // re-enabled, so the eventual done → check transition (when the
  // phase advances) animates text fade + gap collapse + icon green
  // together as a single combined motion. We deliberately don't
  // reset readyToExit when innerPhase leaves "done": flipping the
  // transition rule back to "none" mid-flight would cancel the very
  // animation we're trying to play.
  const [readyToExit, setReadyToExit] = useState(false);
  useEffect(() => {
    if (innerPhase !== "done") return;
    setReadyToExit(false);
    const id = setTimeout(() => setReadyToExit(true), 100);
    return () => clearTimeout(id);
  }, [innerPhase]);

  const SQUARE = 42;
  const CHEVRON_W = 4;
  const GAP = 6;
  const activeWidth = Math.max(
    SQUARE,
    rowWidth - 2 * SQUARE - 2 * CHEVRON_W - 4 * GAP,
  );
  const titles = PHASE_CONFIGS.map((p) => p.title);
  // CONTEXT_BULLETS is at module scope (above this component) so the
  // typing effect's setTimeout closure has a stable reference.
  const ease = "cubic-bezier(0.4, 0, 0.2, 1)";
  const dur = 800;

  // Pre-sliced bullet text for the typed list rendering. Scroll is
  // CSS-driven (.ai-context-flow), so the column glides linearly
  // upward over 6s; typing is calibrated to finish well before that,
  // so lines reach the top fully typed.
  const visibleText =
    innerPhase === "list"
      ? PHASE_CONFIGS[phaseIndex].bullets.join("\n").slice(0, typedChars)
      : "";

  // Cell grid for the diagonal wave. Each dot is 1px (integer pixel
  // — the previous 1.5px size combined with fractional offsetX/Y
  // values from the centring math made some dots straddle pixel
  // boundaries, so the browser anti-aliased them as 1px in some
  // positions and 2px in others). Centred at the 8px cell midpoint,
  // with animation-delay = (col + row) * 30ms so the brightness
  // pulse rolls from top-left to bottom-right. PAD cells extend past
  // the panel — overflow:hidden masks the overhang. Math.round on
  // each x/y locks dots to the integer pixel grid.
  const CELL = 8;
  const DOT = 1;
  const PAD = 2;
  const baseCols = activeWidth > 0 ? Math.floor(activeWidth / CELL) : 0;
  const baseRows = Math.floor(SQUARE / CELL);
  const cols = baseCols + 2 * PAD;
  const rows = baseRows + 2 * PAD;
  const offsetX = (activeWidth - cols * CELL) / 2;
  const offsetY = (SQUARE - rows * CELL) / 2;
  const cells: { x: number; y: number; delay: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: Math.round(offsetX + c * CELL + CELL / 2 - DOT / 2),
        y: Math.round(offsetY + r * CELL + CELL / 2 - DOT / 2),
        delay: (c + r) * 30,
      });
    }
  }

  const renderPanel = (i: number) => {
    const isActive = i === phaseIndex && rowWidth > 0;
    // Three "green" trigger conditions: an inactive panel that's
    // completed (showCheck), and the active phase-2 panel sitting in
    // its "confirmed" hold state (showConfirmed). Either way the
    // panel + icon + text all flip to the green palette with the
    // same delayed pop animation.
    const showConfirmed = isActive && innerPhase === "confirmed";
    const showCheck = !isActive && completedPhases.has(i);
    const isGreen = showConfirmed || showCheck;
    return (
      <div
        style={{
          width: isActive ? activeWidth : SQUARE,
          height: SQUARE,
          // Subtle green-tint on the panel bg + a soft inset border in
          // the green family when the phase has completed. Tints fade
          // in with the same delayed timing as the icon's white→green
          // pop, and snap back instantly on cycle reset.
          background: isGreen
            ? "rgba(74, 222, 128, 0.06)"
            : "rgba(255,255,255,0.04)",
          boxShadow: isGreen
            ? "inset 0 0 0 1px rgba(74, 222, 128, 0.18)"
            : "inset 0 0 0 1px rgba(255,255,255,0.06)",
          borderRadius: 10,
          flexShrink: 0,
          transition: isGreen
            ? `width ${dur}ms ${ease}, background 450ms ${ease} ${dur}ms, box-shadow 450ms ${ease} ${dur}ms`
            : `width ${dur}ms ${ease}, background 180ms cubic-bezier(0.4, 0, 1, 1), box-shadow 180ms cubic-bezier(0.4, 0, 1, 1)`,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
        }}
      >
        {/* Diagonal wave — wrapper is ALWAYS mounted so the opacity
            transition fires when a panel becomes active or when the
            phase enters "done". Without this, the wave snapped in at
            full brightness on every panel switch, which read as
            "incredibly sharp and white". Cells themselves are only
            instantiated when isActive (saves ~190 absolute spans on
            the two inactive panels). */}
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            opacity:
              isActive &&
              innerPhase !== "done" &&
              innerPhase !== "confirmed"
                ? 1
                : 0,
            // Asymmetric transition: fade-in is delayed by 750ms so
            // the wave doesn't slam in at full brightness when a
            // panel switches from square to rectangle. Fade-out runs
            // immediately so the wave is gone before the panel
            // collapses, enters done, or holds in confirmed.
            transition:
              isActive &&
              innerPhase !== "done" &&
              innerPhase !== "confirmed"
                ? `opacity ${dur}ms ${ease} 750ms`
                : `opacity ${dur}ms ${ease}`,
            pointerEvents: "none",
          }}
        >
          {isActive &&
            cells.map((cell, k) => (
              <span
                key={k}
                className="ai-wave-cell"
                style={{
                  position: "absolute",
                  left: cell.x,
                  top: cell.y,
                  width: DOT,
                  height: DOT,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.7)",
                  animationDelay: `${cell.delay}ms`,
                }}
              />
            ))}
        </div>
        <span
          style={{
            opacity: isActive && innerPhase === "title" ? 1 : 0,
            transition: `opacity ${dur}ms ${ease}`,
            fontFamily: "var(--sans-stack)",
            fontSize: 12,
            fontWeight: 500,
            color: "rgba(255,255,255,0.62)",
            whiteSpace: "nowrap",
            letterSpacing: "-0.005em",
            lineHeight: 1,
            position: "absolute",
            zIndex: 1,
          }}
        >
          {titles[i]}
        </span>
        {/* Typed bullet list — fixed-height 8-row column. translateY is
            JS-driven from typedChars so the line being typed is always
            pinned to the panel bottom; the scroll never outruns the
            typing. Smooth CSS transition between line bumps gives a
            steady, lined-up feel that's still kinetic. */}
        {isActive && innerPhase === "list" && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              padding: "0 10px",
              overflow: "hidden",
              pointerEvents: "none",
              zIndex: 1,
            }}
          >
            <div
              className="ai-context-flow"
              style={{
                position: "absolute",
                top: 0,
                left: 10,
                right: 10,
                fontFamily: "var(--sans-stack)",
                fontSize: 10,
                lineHeight: "16px",
                color: "rgba(255,255,255,0.62)",
                letterSpacing: "-0.005em",
              }}
            >
              {(() => {
                const lines = visibleText.split("\n");
                return PHASE_CONFIGS[phaseIndex].bullets.map((_, k) => (
                  <div
                    key={k}
                    style={{
                      height: 16,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                    }}
                  >
                    {lines[k] ?? ""}
                  </div>
                ));
              })()}
            </div>
          </div>
        )}
        {/* Done / confirmed / check / preview area — same icon in four
            contexts:
            • "done"      : panel is in done phase; muted text + icon.
            • "confirmed" : phase 2 only — active panel has finished
                            its cycle and is holding the green
                            success state for 3s before the cycle
                            wraps. Text + icon both green and scaled.
            • "check"     : a previous phase has collapsed back to a
                            square; icon green, no text.
            • "preview"   : phase hasn't reached this panel yet; icon
                            in default colour as an upcoming-step hint. */}
        {(() => {
          const showDone = isActive && innerPhase === "done";
          const showText = showDone || showConfirmed;
          const showPreview = !isActive && !completedPhases.has(i);
          const visible = showDone || showConfirmed || showCheck || showPreview;
          return (
            <div
              aria-hidden
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                opacity: visible ? 1 : 0,
                transition: "opacity 400ms cubic-bezier(0.2, 0, 0.2, 1)",
                pointerEvents: "none",
                zIndex: 1,
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: showText ? 6 : 0,
                  // Whole inline-flex scales when entering green so
                  // both text + icon "pop" together. Asymmetric
                  // timing matches the icon-colour transition: long
                  // delay + bouncy spring on entry, fast snap on exit.
                  transform: isGreen ? "scale(1.12)" : "scale(1)",
                  transition: isGreen
                    ? `gap 400ms cubic-bezier(0.2, 0, 0.2, 1), transform 450ms cubic-bezier(0.34, 1.56, 0.64, 1) ${dur}ms`
                    : readyToExit
                      ? "gap 400ms cubic-bezier(0.2, 0, 0.2, 1), transform 180ms cubic-bezier(0.4, 0, 1, 1)"
                      : "transform 180ms cubic-bezier(0.4, 0, 1, 1)",
                }}
              >
                <span
                  style={{
                    opacity: showText ? 1 : 0,
                    maxWidth: showText ? 200 : 0,
                    overflow: "hidden",
                    whiteSpace: "nowrap",
                    transition: readyToExit
                      ? `opacity 220ms cubic-bezier(0.4, 0, 1, 1), max-width 380ms cubic-bezier(0.4, 0, 0.2, 1), color ${isGreen ? `450ms cubic-bezier(0.34, 1.56, 0.64, 1) ${dur}ms` : "180ms cubic-bezier(0.4, 0, 1, 1)"}`
                      : "none",
                    fontFamily: "var(--sans-stack)",
                    fontSize: 12,
                    fontWeight: isGreen ? 600 : 400,
                    color: isGreen
                      ? "rgb(74, 222, 128)"
                      : "rgba(255,255,255,0.62)",
                    letterSpacing: "-0.005em",
                    // lineHeight 1.3 leaves room for descenders ("g",
                    // "p", "y") that were previously clipped by the
                    // overflow:hidden used for the max-width collapse.
                    lineHeight: 1.3,
                  }}
                >
                  {PHASE_CONFIGS[i].doneText}
                </span>
                <svg
                  width={14}
                  height={14}
                  viewBox="0 0 18 18"
                  fill="currentColor"
                  aria-hidden
                  style={{
                    display: "block",
                    flexShrink: 0,
                    color: isGreen
                      ? "rgb(74, 222, 128)"
                      : "rgba(255,255,255,0.62)",
                    // Scale lives on the parent inline-flex (so text
                    // + icon scale together); here just colour. Same
                    // delay-on-entry / instant-on-exit asymmetry.
                    transition: isGreen
                      ? `color 450ms cubic-bezier(0.34, 1.56, 0.64, 1) ${dur}ms`
                      : "color 180ms cubic-bezier(0.4, 0, 1, 1)",
                  }}
                >
                  {PHASE_CONFIGS[i].icon}
                </svg>
              </div>
            </div>
          );
        })()}
      </div>
    );
  };

  const chevron = (
    <svg
      width={CHEVRON_W}
      height={6}
      viewBox="0 0 4 6"
      aria-hidden
      style={{ display: "block", flexShrink: 0 }}
    >
      <polyline
        points="0,0 4,3 0,6"
        fill="none"
        stroke="rgba(255,255,255,0.62)"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );

  return (
    <div
      ref={rowRef}
      style={{
        display: "flex",
        alignItems: "center",
        gap: GAP,
        // Equal margins on both sides — auto/auto centers the row
        // vertically in the remaining space below the description, so
        // the gap to the description above matches the gap to the
        // card's bottom edge.
        marginTop: "auto",
        marginBottom: "auto",
        // 10% narrower than the column — shrinks rowWidth → activeWidth
        // tracks automatically (computed from rowWidth in the layout
        // math above).
        width: "90%",
      }}
    >
      {renderPanel(0)}
      {chevron}
      {renderPanel(1)}
      {chevron}
      {renderPanel(2)}
    </div>
  );
}

// Wraps the Stack card's body — text column on the left (with the
// preview row at the bottom) and StackViz on the right — and owns the
// shared cycle state that drives both. Lifting state here is what
// keeps the StackPreview animation in sync with the StackViz panel
// highlights and the USDC bar fill.
function StackBody({ open }: { open: boolean }) {
  const [phaseIndex, setPhaseIndex] = useState(0);
  const [innerPhase, setInnerPhase] = useState<
    "title" | "list" | "done" | "confirmed"
  >("title");
  const [completedPhases, setCompletedPhases] = useState<Set<number>>(
    () => new Set(),
  );
  // Cycle pointer for the USDC bar fill — advances at each phase 2
  // "confirmed" entry, wraps mod 3 so after 3 cycles the bar lands
  // back where it started.
  const [barIdx, setBarIdx] = useState(0);

  useEffect(() => {
    if (!open) {
      setInnerPhase("title");
      setCompletedPhases(new Set());
      setPhaseIndex(0);
      setBarIdx(0);
      return;
    }
    if (phaseIndex === 0) setCompletedPhases(new Set());
    setInnerPhase("title");
    const t1 = setTimeout(() => setInnerPhase("list"), 2000);
    const t2 = setTimeout(() => setInnerPhase("done"), 5000);

    if (phaseIndex === 2) {
      const t3 = setTimeout(() => {
        setInnerPhase("confirmed");
        setBarIdx((i) => (i + 1) % BAR_VALUES.length);
      }, 6000);
      const t4 = setTimeout(() => {
        setInnerPhase("title");
        setPhaseIndex(0);
      }, 9000);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
        clearTimeout(t4);
      };
    }

    const t3 = setTimeout(() => {
      setCompletedPhases((prev) => {
        const next = new Set(prev);
        next.add(phaseIndex);
        return next;
      });
      setInnerPhase("title");
      setPhaseIndex((p) => (p + 1) % 3);
    }, 6000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [phaseIndex, open]);

  return (
    <div
      style={{
        display: "flex",
        gap: 18,
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <CardLabel icon="stack">Stack</CardLabel>
        <h3
          style={{
            color: "#fff",
            fontFamily: "var(--font-radley)",
            fontSize: 22,
            lineHeight: 1.1,
            letterSpacing: "-0.005em",
            margin: "12px 0 0 0",
            fontWeight: 400,
          }}
        >
          What happens behind the scenes.
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
          Our agent layer has continuous access to enriched context
          spanning categories like social narrative, price action,
          and real-world events. These informations are digested
          into an operative decision which is executed onchain.
        </p>
        <StackPreview
          open={open}
          phaseIndex={phaseIndex}
          innerPhase={innerPhase}
          completedPhases={completedPhases}
        />
      </div>
      <div style={{ flexShrink: 0 }}>
        <StackViz
          phaseIndex={phaseIndex}
          innerPhase={innerPhase}
          completedPhases={completedPhases}
          barFillPercent={BAR_VALUES[barIdx]}
          poolRatios={POOL_RATIOS.map((p) => p[barIdx])}
        />
      </div>
    </div>
  );
}

// Panel keeps overflow:visible (so chip tooltips can extend above it) — footer owns its own bottom-corner radius.
// `isPulsing` adds a slow white-border pulse via the .stackviz-panel-pulse class (active phase, working).
// `isGreen` swaps to a green tint + green border with the same delayed transition the StackPreview uses.
function TopPanel({
  children,
  width,
  height,
  label,
  isPulsing = false,
  isGreen = false,
}: {
  children: React.ReactNode;
  width: number | string;
  height?: number | string;
  label: string;
  isPulsing?: boolean;
  isGreen?: boolean;
}) {
  // Diagonal wave grid covering the body (panel - footer). Mirrors the
  // StackPreview pattern: CELL=8 spacing, DOT=1 dots, animation-delay
  // = (col + row) * 30ms so the brightness ramp travels top-left to
  // bottom-right. Only computed when width/height resolve to numbers
  // (always the case in current usage).
  const FOOTER_H = 18;
  const numericW = typeof width === "number" ? width : 0;
  const numericH = typeof height === "number" ? height : 0;
  const bodyH = Math.max(0, numericH - FOOTER_H);
  const CELL = 8;
  const DOT = 1;
  const PAD = 2;
  const baseCols = numericW > 0 ? Math.floor(numericW / CELL) : 0;
  const baseRows = bodyH > 0 ? Math.floor(bodyH / CELL) : 0;
  const cols = baseCols + 2 * PAD;
  const rows = baseRows + 2 * PAD;
  const offsetX = (numericW - cols * CELL) / 2;
  const offsetY = (bodyH - rows * CELL) / 2;
  const cells: { x: number; y: number; delay: number }[] = [];
  if (numericW > 0 && bodyH > 0) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        cells.push({
          x: Math.round(offsetX + c * CELL + CELL / 2 - DOT / 2),
          y: Math.round(offsetY + r * CELL + CELL / 2 - DOT / 2),
          delay: (c + r) * 30,
        });
      }
    }
  }
  const showWave = isPulsing && !isGreen && cells.length > 0;
  return (
    <div
      className={isPulsing ? "stackviz-panel-pulse" : undefined}
      style={{
        width,
        height,
        position: "relative",
        // Body bg + inset border drive both the pulse animation
        // (white) and the success state (green). When the pulse class
        // is active, its keyframes override the inline boxShadow /
        // background; when isGreen takes over, the inline values pin
        // the panel to its green palette and the (delayed) transition
        // animates the swap. Cycle reset → instant snap back.
        background: isGreen
          ? "rgba(74, 222, 128, 0.06)"
          : "rgba(255,255,255,0.04)",
        boxShadow: isGreen
          ? "inset 0 0 0 1px rgba(74, 222, 128, 0.18)"
          : "inset 0 0 0 1px rgba(255,255,255,0.06)",
        transition: isGreen
          ? "background 450ms cubic-bezier(0.34, 1.56, 0.64, 1) 800ms, box-shadow 450ms cubic-bezier(0.34, 1.56, 0.64, 1) 800ms"
          : "background 180ms cubic-bezier(0.4, 0, 1, 1), box-shadow 180ms cubic-bezier(0.4, 0, 1, 1)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Wave layer — clipped to the body region (panel minus footer)
          and to the panel's top-corner radius so dots don't bleed past
          the rounded edges. Asymmetric fade: 750ms delay on entry
          (matches StackPreview) so the wave doesn't slam in alongside
          the panel switch; instant fade on exit when the phase wraps
          to green or the panel becomes inactive. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 0,
          bottom: FOOTER_H,
          overflow: "hidden",
          borderRadius: "10px 10px 0 0",
          opacity: showWave ? 1 : 0,
          transition: showWave
            ? "opacity 220ms cubic-bezier(0.16, 1, 0.3, 1) 750ms"
            : "opacity 220ms cubic-bezier(0.16, 1, 0.3, 1)",
          pointerEvents: "none",
        }}
      >
        {showWave &&
          cells.map((cell, k) => (
            <span
              key={k}
              className="ai-wave-cell"
              style={{
                position: "absolute",
                left: cell.x,
                top: cell.y,
                width: DOT,
                height: DOT,
                borderRadius: "50%",
                background: "rgba(255,255,255,0.7)",
                animationDelay: `${cell.delay}ms`,
              }}
            />
          ))}
      </div>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          padding: 10,
          position: "relative",
        }}
      >
        {children}
      </div>
      <div
        style={{
          background: isGreen
            ? "rgba(74, 222, 128, 0.10)"
            : "rgba(255,255,255,0.06)",
          padding: "4px 4px 5px",
          textAlign: "center",
          fontFamily: "var(--sans-stack)",
          fontSize: 9,
          fontWeight: 400,
          color: isGreen
            ? "rgb(74, 222, 128)"
            : "rgba(255,255,255,0.62)",
          lineHeight: 1,
          borderRadius: "0 0 10px 10px",
          transition: isGreen
            ? "background 450ms cubic-bezier(0.34, 1.56, 0.64, 1) 800ms, color 450ms cubic-bezier(0.34, 1.56, 0.64, 1) 800ms"
            : "background 180ms cubic-bezier(0.4, 0, 1, 1), color 180ms cubic-bezier(0.4, 0, 1, 1)",
        }}
      >
        {label}
      </div>
    </div>
  );
}


const USDC_VAULT_ENTRY: BuiltOnEntry = {
  name: "USDC",
  role: "",
  color: "#2775CA",
  logoSrc: "/tokens/usdc.png",
};

function HoverChip({
  label,
  children,
  onHoverChange,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  onHoverChange?: (hover: boolean) => void;
}) {
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  // Tooltip is portalled to <body> to escape ancestor backdrop-filter, which would otherwise blank it out.
  useLayoutEffect(() => {
    if (!hover || !ref.current) return;
    const update = () => {
      if (!ref.current) return;
      const r = ref.current.getBoundingClientRect();
      setPos({ left: r.left + r.width / 2, top: r.top });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [hover]);

  const set = (v: boolean) => {
    setHover(v);
    onHoverChange?.(v);
  };

  return (
    <span
      ref={ref}
      onMouseEnter={() => set(true)}
      onMouseLeave={() => set(false)}
      onFocus={() => set(true)}
      onBlur={() => set(false)}
      tabIndex={0}
      style={{
        position: "relative",
        display: "inline-flex",
        flexShrink: 0,
        zIndex: hover ? 5 : 1,
        outline: "none",
      }}
    >
      <span
        style={{
          display: "inline-flex",
          transform: hover ? "scale(1.10)" : "scale(1)",
          transition: "transform 220ms cubic-bezier(0.16, 1, 0.3, 1)",
          willChange: "transform",
        }}
      >
        {children}
      </span>
      {hover && pos && typeof document !== "undefined"
        ? createPortal(
            <span
              aria-hidden
              style={{
                position: "fixed",
                left: pos.left,
                top: pos.top,
                transform: "translate(-50%, calc(-100% - 6px))",
                display: "inline-flex",
                alignItems: "center",
                height: 20,
                padding: "0 8px",
                borderRadius: 999,
                background: "rgba(255,255,255,0.05)",
                backdropFilter: "blur(24px)",
                WebkitBackdropFilter: "blur(24px)",
                color: "rgba(255,255,255,0.92)",
                fontFamily: "var(--sans-stack)",
                fontSize: 11,
                fontWeight: 500,
                lineHeight: 1,
                letterSpacing: "-0.005em",
                whiteSpace: "nowrap",
                pointerEvents: "none",
                zIndex: 9999,
              }}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </span>
  );
}

function PoolPairChip({
  left,
  right,
  leftRatio = 0.5,
}: {
  left: TokenEntry;
  right: TokenEntry;
  leftRatio?: number;
}) {
  const SIZE = 18;
  const OFFSET = 10;
  const [hoverLeft, setHoverLeft] = useState(false);
  const [hoverRight, setHoverRight] = useState(false);
  const rightRatio = 1 - leftRatio;
  return (
    <span
      style={{
        position: "relative",
        width: SIZE + OFFSET,
        height: SIZE,
        display: "inline-block",
        flexShrink: 0,
      }}
    >
      {/* display:flex on absolute wrappers prevents inline-flex children inheriting line-height as padding. */}
      <span style={{ position: "absolute", left: 0, top: 0, display: "flex", zIndex: hoverLeft ? 6 : 1 }}>
        <HoverChip label={left.slug} onHoverChange={setHoverLeft}>
          <RatioChip entry={left} size={SIZE} radius={4} ratio={leftRatio} />
        </HoverChip>
      </span>
      <span style={{ position: "absolute", left: OFFSET, top: 0, display: "flex", zIndex: hoverRight ? 6 : 2 }}>
        <HoverChip label={right.slug} onHoverChange={setHoverRight}>
          <RatioChip entry={right} size={SIZE} radius={4} ratio={rightRatio} />
        </HoverChip>
      </span>
    </span>
  );
}

// Two-layer chip: a greyscale base sits at full size (always visible),
// a coloured copy of the same TokenChip overlays it clipped from the
// bottom up to `ratio * height`. Reads as a fill-level / liquidity
// gauge for the token's share of the pool. clip-path is animated so
// ratio changes glide in lockstep with the USDC bar's transition.
function RatioChip({
  entry,
  size,
  radius,
  ratio,
}: {
  entry: TokenEntry;
  size: number;
  radius: number;
  ratio: number;
}) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const topInset = `${(1 - clamped) * 100}%`;
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        width: size,
        height: size,
        display: "inline-block",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          // Half-saturation base — the unfilled portion still reads as
          // the token's own colour, just dimmer than the full-saturation
          // overlay clipped on top.
          filter: "saturate(0.5)",
        }}
      >
        <TokenChip entry={entry} size={size} radius={radius} />
      </span>
      <span
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          clipPath: `inset(${topInset} 0 0 0)`,
          WebkitClipPath: `inset(${topInset} 0 0 0)`,
          transition:
            "clip-path 1500ms cubic-bezier(0.4, 0, 0.2, 1), -webkit-clip-path 1500ms cubic-bezier(0.4, 0, 0.2, 1)",
        }}
      >
        <TokenChip entry={entry} size={size} radius={radius} />
      </span>
    </span>
  );
}

function PoolPlus() {
  const SIZE = 18;
  return (
    <span
      aria-hidden
      style={{
        width: SIZE,
        height: SIZE,
        boxSizing: "border-box",
        borderRadius: 4,
        background: "rgba(255,255,255,0.04)",
        border: "1px dashed rgba(255,255,255,0.22)",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: "rgba(255,255,255,0.55)",
        flexShrink: 0,
      }}
    >
      <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden style={{ display: "block" }}>
        <line
          x1={5}
          y1={2}
          x2={5}
          y2={8}
          stroke="currentColor"
          strokeWidth={1.3}
          strokeLinecap="round"
        />
        <line
          x1={2}
          y1={5}
          x2={8}
          y2={5}
          stroke="currentColor"
          strokeWidth={1.3}
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

function BuiltOnChip({
  entry,
  size = 26,
  tooltip,
}: {
  entry: BuiltOnEntry;
  size?: number;
  tooltip?: string;
}) {
  const [hover, setHover] = useState(false);
  const interactive = !!entry.link;
  const label = tooltip ?? entry.name;
  const chipNode = renderChipFace(entry, size);

  if (!interactive) {
    return chipNode;
  }

  return (
    <span
      style={{
        position: "relative",
        display: "inline-flex",
        flexShrink: 0,
        // Lift above sibling chips so the tooltip clears them on hover.
        zIndex: hover ? 5 : 1,
      }}
    >
      <a
        href={entry.link}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={label}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        style={{
          display: "inline-flex",
          textDecoration: "none",
          cursor: "pointer",
          transform: hover ? "scale(1.10)" : "scale(1)",
          transition: "transform 220ms cubic-bezier(0.16, 1, 0.3, 1)",
          willChange: "transform",
          outline: "none",
        }}
      >
        {chipNode}
      </a>
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: "50%",
          bottom: "100%",
          marginBottom: 6,
          transform: "translateX(-50%)",
          display: "inline-flex",
          alignItems: "center",
          height: 20,
          padding: "0 8px",
          borderRadius: 999,
          background: "rgba(255,255,255,0.05)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          color: "rgba(255,255,255,0.92)",
          fontFamily: "var(--sans-stack)",
          fontSize: 11,
          fontWeight: 500,
          lineHeight: 1,
          letterSpacing: "-0.005em",
          whiteSpace: "nowrap",
          opacity: hover ? 1 : 0,
          transition: "opacity 220ms cubic-bezier(0.16, 1, 0.3, 1)",
          pointerEvents: "none",
          zIndex: 20,
        }}
      >
        {label}
      </span>
    </span>
  );
}

// White circle layered behind a Uniswap chip's silhouette. 85% of the
// chip's box, centered. Parent must be position:relative.
function Moon() {
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: "85%",
        height: "85%",
        borderRadius: "50%",
        background: "white",
        pointerEvents: "none",
      }}
    />
  );
}

// Recoloured silhouette layered on top of Moon — masks the unicorn SVG
// in the chip's brand colour at 62% of the box so it sits inside the
// moon. Parent must be position:relative.
function Silhouette({ src, color }: { src: string; color: string }) {
  return (
    <span
      aria-hidden
      style={{
        position: "absolute",
        left: "50%",
        top: "50%",
        transform: "translate(-50%, -50%)",
        width: "62%",
        height: "62%",
        backgroundColor: color,
        WebkitMaskImage: `url(${src})`,
        maskImage: `url(${src})`,
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        pointerEvents: "none",
      }}
    />
  );
}

function renderChipFace(entry: BuiltOnEntry, size: number) {
  const radius = Math.max(5, Math.round(size * 0.22));
  if (entry.logoSrc) {
    const withMoon = entry.name === "Uniswap";
    return (
      <span
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: entry.color,
          overflow: "hidden",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          position: "relative",
        }}
      >
        {withMoon ? (
          <>
            <Moon />
            <Silhouette src={entry.logoSrc} color={entry.color} />
          </>
        ) : (
          <Image src={entry.logoSrc} alt="" width={size} height={size} style={{ display: "block" }} />
        )}
      </span>
    );
  }
  const glyphSize = Math.round(size * 0.55);
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: entry.color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        color: entry.logoColor ?? "#fff",
        fontFamily: "var(--sans-stack)",
        fontSize: Math.round(size * 0.5),
        fontWeight: 600,
        lineHeight: 1,
        flexShrink: 0,
        letterSpacing: "-0.02em",
      }}
    >
      <svg
        viewBox={entry.logoSvgViewBox || "0 0 32 32"}
        width={glyphSize}
        height={glyphSize}
        style={{ display: "block" }}
        aria-hidden
      >
        {entry.logoSvg}
      </svg>
    </span>
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
// (bottom-left, just below the panel). They occupy the same slot
// mutually exclusively, toggled via display:none.
//
// The `reveal` entry animation must only play once on initial page load.
// Browsers restart CSS animations when an element flips from `display:none`
// back to a visible display value, so leaving the class on would re-fire
// the 2700ms delayed reveal every time the user clicks Back from the
// Learn-more overlay. Once the initial reveal has completed we strip the
// class entirely — the button's resting state (opacity 1, no transform)
// matches the animation's final keyframe, so there is no visual snap.
const REVEAL_DELAY_MS = 2700;
const REVEAL_DURATION_MS = 600;
function HowItWorks({ disabled, onClick }: { disabled?: boolean; onClick: () => void }) {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setRevealed(true), REVEAL_DELAY_MS + REVEAL_DURATION_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="How it works"
      className={`${revealed ? "" : "reveal "}absolute z-30 items-center gap-1.5 text-xs text-haze transition-colors hover:text-mist`}
      style={{
        top: "calc(80% + 12px)",
        left: "20%",
        ...(revealed ? null : { animationDelay: `${REVEAL_DELAY_MS}ms` }),
        background: "transparent",
        border: "none",
        padding: 0,
        cursor: "pointer",
        display: disabled ? "none" : "flex",
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
  stack: (
    <>
      <path fillOpacity="0.4" d="M15.6856 7.67326L9.8165 4.58299C9.3058 4.31299 8.69539 4.31251 8.18469 4.58251L2.3156 7.67326V7.6743C1.8215 7.9346 1.5148 8.44289 1.5148 9.00139C1.5148 9.55989 1.8214 10.0683 2.3156 10.3285L8.18381 13.4179C8.43971 13.5532 8.7199 13.6205 9.0007 13.6205C9.2805 13.6205 9.5608 13.5531 9.8156 13.4184L15.6857 10.3276C16.1798 10.0673 16.4865 9.55897 16.4865 9.00047C16.4865 8.44197 16.1798 7.93346 15.6856 7.67326Z" />
      <path fillOpacity="0.2" d="M15.6856 10.9233L15.1199 10.6254L9.81552 13.4184C9.56062 13.5532 9.28031 13.6205 9.00061 13.6205C8.71981 13.6205 8.43962 13.5531 8.18372 13.4179L2.88031 10.6259L2.31552 10.9233V10.9243C1.82142 11.1846 1.51471 11.6929 1.51471 12.2514C1.51471 12.8099 1.82132 13.3183 2.31552 13.5785L8.18372 16.6679C8.43962 16.8032 8.71981 16.8705 9.00061 16.8705C9.28041 16.8705 9.56072 16.8031 9.81552 16.6684L15.6856 13.5776C16.1797 13.3173 16.4864 12.809 16.4864 12.2505C16.4864 11.692 16.1798 11.1835 15.6856 10.9233Z" />
      <path d="M15.6856 4.42241L9.8165 1.33208C9.3058 1.06208 8.69539 1.06159 8.18469 1.33159L2.3156 4.42241C1.8215 4.68271 1.5148 5.19197 1.5148 5.75047C1.5148 6.30897 1.8214 6.81736 2.3156 7.07756L8.18381 10.167C8.43971 10.3023 8.7199 10.3696 9.0007 10.3696C9.2805 10.3696 9.5608 10.3022 9.8156 10.1675L15.6857 7.07671C16.1798 6.81641 16.4865 6.30806 16.4865 5.74956C16.4865 5.19106 16.1798 4.68261 15.6856 4.42241Z" />
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
  UNI:  { slug: "UNI",  kind: "png", src: "/tokens/svg/uni.svg",  color: "#FF007A" },
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

// Gauge-style allocation cells + shared TokenChip helper. Each chip is a
// brand-color rounded square with the token glyph inside: ETH/BTC/USDT use
// single-path SVGs masked white; USDC/UNI overlay their PNG (their SVG
// sources don't exist).
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
  const withMoon = entry.kind === "png" && entry.src.endsWith("/uni.svg");
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
        position: "relative",
      }}
    >
      {withMoon ? (
        <>
          <Moon />
          <Silhouette src={entry.src} color={entry.color} />
        </>
      ) : entry.kind === "svg" ? (
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
  { slug: "UNI",  kind: "png", src: "/tokens/svg/uni.svg",  pct:  8, color: "#FF007A" },
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
  { slug: "UNI",  kind: "png", src: "/tokens/svg/uni.svg",  pct:  8, color: "#FF007A", note: "UNI/USDC pool",  angle: -162 },
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
              willChange: "transform",
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
          height: 20,
          padding: "0 9px 0 8px",
          borderRadius: 999,
          background: "rgba(255,255,255,0.05)",
          backdropFilter: "blur(24px)",
          WebkitBackdropFilter: "blur(24px)",
          color: "rgba(255,255,255,0.92)",
          fontFamily: "var(--sans-stack)",
          fontSize: 11,
          fontWeight: 500,
          lineHeight: 1,
          letterSpacing: "-0.005em",
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

function LearnMoreContent({ open, onAppNav }: { open: boolean; onAppNav?: () => void }) {
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

        {/* Stack — single card. Unlike Strategy/Vault flow which have a
            CardLabel pill at top followed by a side-by-side row, here the
            CardLabel lives INSIDE the left column so the viz can start
            at the same Y as the pill (aligned to card top-padding).
            Height + paddingBottom are fixed (264 / 12) so the bottom
            edge lines up exactly with Strategy's bottom in the right
            column — measured via DevTools, not a flex/stretch trick,
            because the two cards live in independent columns. */}
        <Card style={{ paddingBottom: 12, height: 264, display: "flex", flexDirection: "column" }}>
          <StackBody open={open} />
        </Card>
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
                  Outpacing IL and LVR.
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
                  Concentrated positions earn the most fees but bleed
                  the most to IL and LVR. Agents retighten ranges and
                  rotate capital to keep yield ahead of both.
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
              onClick={(e) => {
                if (!isPlainLeftClick(e)) return;
                e.preventDefault();
                onAppNav?.();
              }}
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
  const router = useRouter();
  const [exiting, setExiting] = useState(false);

  // Trigger lockup-exit and fire navigation in parallel — animation
  // runs on the still-mounted landing until the route swaps in.
  const handleAppNav = () => {
    if (exiting) return;
    setExiting(true);
    router.push("/app");
  };

  return (
    <>
      {/* Lockup. Slides up from behind the muted scenery panel on
          entry, back down behind it on exit. z-10 so scenery-panel
          (z-15) covers it during the slide. */}
      <div
        className={`absolute z-10 flex items-center gap-1.5 ${exiting ? "lockup-exit" : "lockup-enter"}`}
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
        <CatchphraseLink disabled={learnMore} onAppNav={handleAppNav} />
      </div>

      {/* Bottom-left entry into Learn-more (only in default state). */}
      <HowItWorks disabled={learnMore} onClick={onToggleLearnMore} />

      {/* Learn-more overlay (headline + body + secondary Open App) */}
      <LearnMoreContent open={learnMore} onAppNav={handleAppNav} />

      <TotalDeposits />
      <LearnMore open={learnMore} onClick={onToggleLearnMore} />
      <BuiltWith />
    </>
  );
}
