"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import React, { useEffect, useState } from "react";

/* ---------- Panel rect math (mirrors Shell + Scenery from the landing) ---------- */

const REF_W = 2300;
const REF_H = 1300;
const SCALE_REF_W = 1800;
const SCALE_REF_H = (SCALE_REF_W * REF_H) / REF_W;
const PANEL_INSET = 0.20;

type PanelLayout = { left: number; top: number; width: number; height: number; scale: number };
type FullLayout = { main: PanelLayout };

function computeFullLayout(): FullLayout {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const scale = Math.min(1, vw / SCALE_REF_W, vh / SCALE_REF_H);
  const canvasW = REF_W * scale;
  const canvasH = REF_H * scale;
  const canvasLeft = (vw - canvasW) / 2;
  const canvasTop = (vh - canvasH) / 2;

  const mainLeft = canvasLeft + canvasW * PANEL_INSET;
  const mainTop = canvasTop + canvasH * PANEL_INSET;
  const mainW = canvasW * (1 - 2 * PANEL_INSET);
  const mainH = canvasH * (1 - 2 * PANEL_INSET);
  const main: PanelLayout = { left: mainLeft, top: mainTop, width: mainW, height: mainH, scale };

  return { main };
}

// useState initializer so the layout (and FloatingNav) is in the DOM
// on the first client render rather than after a useEffect tick.
function useFullLayout(): FullLayout | null {
  const [layout, setLayout] = useState<FullLayout | null>(() =>
    typeof window === "undefined" ? null : computeFullLayout(),
  );
  useEffect(() => {
    const update = () => setLayout(computeFullLayout());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return layout;
}

// Landscape filter — colour-preserving, just slightly desaturated and dimmed.
// Used on the main panel + nav pill so the colour reads through.
const LANDSCAPE_FILTER = "saturate(0.85) brightness(0.7)";

// LMC-style muted filter — exact match to landing's Scenery muted state
// (when learnMore = true). Applied to the bottom activity panel so it
// reads as a recessed, greyscaled surface vs the colourful main panel.
const LANDSCAPE_FILTER_MUTED = "grayscale(0.85) saturate(0.35) contrast(0.85) brightness(0.55)";

/* ---------- Constants & sample data ---------- */

const SHARE_PRICE = 1.0427;

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

function StrokeIcon({ kind, size = 11 }: { kind: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ display: "inline-block", flexShrink: 0 }}>
      {ICONS[kind]}
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
  const gs = Math.round(size * 0.62);
  const withMoon = entry.kind === "png" && entry.src.endsWith("/uni.svg");
  return (
    <span aria-hidden style={{
      width: size, height: size, borderRadius: r, background: entry.color,
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      overflow: "hidden", flexShrink: 0, position: "relative",
    }}>
      {withMoon ? (
        <>
          <Moon />
          <Silhouette src={entry.src} color={entry.color} />
        </>
      ) : entry.kind === "svg" ? (
        <span style={{
          width: gs, height: gs, backgroundColor: "#fff",
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
  const inner = Math.round(size * 0.65);
  return (
    <span aria-hidden style={{
      width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.26)),
      background: "rgba(255,255,255,0.10)",
      display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    }}>
      <span style={{ display: "block", width: inner, height: inner, ...MASK_STYLE }} />
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
  return (
    <div className={className} style={{
      background: "rgba(255,255,255,0.04)",
      border: "1px solid rgba(255,255,255,0.06)",
      borderRadius: 20,
      padding: "16px 20px 18px",
      backdropFilter: "blur(24px)",
      WebkitBackdropFilter: "blur(24px)",
      ...style,
    }}>
      {children}
    </div>
  );
}

function CardLabel({ icon, children }: { icon: keyof typeof ICONS | string; children: React.ReactNode }) {
  return (
    <span style={{
      display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 5,
      padding: "0 8px 0 6px", height: 20, borderRadius: 6,
      background: "rgba(255,255,255,0.08)",
      color: "rgba(255,255,255,0.92)",
      fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500,
      letterSpacing: "0.02em", lineHeight: 1, width: "max-content",
    }}>
      <StrokeIcon kind={icon} size={11} />
      {children}
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18, marginBottom: 12 }}>
      <span style={{
        fontFamily: "var(--sans-stack)", fontSize: 10, fontWeight: 500,
        color: "rgba(255,255,255,0.45)", letterSpacing: "0.10em",
        textTransform: "uppercase", lineHeight: 1,
      }}>
        {children}
      </span>
      <span aria-hidden style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.06)" }} />
    </div>
  );
}

function PageSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
        <span style={{
          display: "inline-flex", alignItems: "center", height: 22,
          padding: "0 11px", borderRadius: 6,
          background: "rgba(255,255,255,0.10)",
          color: "rgba(255,255,255,0.95)",
          fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 600,
          letterSpacing: "0.12em", textTransform: "uppercase", lineHeight: 1,
        }}>
          {label}
        </span>
        <span aria-hidden style={{ flex: 1, height: 1, background: "rgba(255,255,255,0.10)" }} />
      </div>
      {children}
    </section>
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

function RangeMiniChart({ upper, lower, color, height = 36 }: { upper: number[]; lower: number[]; color: string; height?: number }) {
  const W = 1000;
  const H = height;
  const stepX = W / (upper.length - 1);
  const upperPts = upper.map((v, i) => `${(i * stepX).toFixed(1)},${((1 - v) * H).toFixed(1)}`);
  const lowerPts = lower.map((v, i) => `${(i * stepX).toFixed(1)},${((1 - v) * H).toFixed(1)}`);
  const path =
    `M${upperPts[0]} ` +
    upperPts.slice(1).map((p) => `L${p}`).join(" ") +
    " " +
    [...lowerPts].reverse().map((p) => `L${p}`).join(" ") +
    " Z";
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden style={{ display: "block" }}>
      <path d={path} fill={color} fillOpacity="0.18" />
      <polyline points={upperPts.join(" ")} fill="none" stroke={color} strokeOpacity="0.7" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <polyline points={lowerPts.join(" ")} fill="none" stroke={color} strokeOpacity="0.7" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/* ---------- Stat / Metric cells ---------- */

function StatCell({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  const valueColor = tone === "up" ? "rgb(134, 239, 172)" : tone === "down" ? "rgb(252, 165, 165)" : "#fff";
  return (
    <div>
      <div style={{ color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", lineHeight: 1 }}>
        {label}
      </div>
      <div style={{ marginTop: 8, color: valueColor, fontFamily: "var(--font-radley)", fontSize: 26, lineHeight: 1.1, letterSpacing: "-0.01em", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
    </div>
  );
}

function MetricCell({ label, value, icon }: { label: string; value: string; icon?: keyof typeof ICONS | string }) {
  return (
    <div>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500, letterSpacing: "0.06em", textTransform: "uppercase", lineHeight: 1 }}>
        {icon && <StrokeIcon kind={icon} size={11} />}
        {label}
      </div>
      <div style={{ marginTop: 8, color: "#fff", fontFamily: "var(--sans-stack)", fontSize: 22, fontWeight: 500, lineHeight: 1.1, letterSpacing: "-0.015em", fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
    </div>
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

type ActivityRow =
  | { kind: "single"; token: TokenEntry; time: string; text: string }
  | { kind: "pair"; left: TokenEntry; right: TokenEntry; time: string; text: string };
const ACTIVITY: ActivityRow[] = [
  { kind: "single", token: TOKENS.ETH,  time: "2m",  text: "Tightened ETH/USDC range to ±0.8%" },
  { kind: "single", token: TOKENS.BTC,  time: "17m", text: "Harvested $1.2k in fees from BTC/USDC" },
  { kind: "pair",   left: TOKENS.BTC,   right: TOKENS.UNI, time: "1h",  text: "Rotated 5% from BTC/USDC into UNI/USDC" },
  { kind: "single", token: TOKENS.UNI,  time: "3h",  text: "Pulled UNI/USDC outer band to reserve" },
  { kind: "single", token: TOKENS.ETH,  time: "6h",  text: "Rebalanced ETH/USDC at $4,124" },
  { kind: "single", token: TOKENS.USDT, time: "9h",  text: "Compounded $890 from USDC/USDT into LP" },
  { kind: "pair",   left: TOKENS.USDC,  right: TOKENS.UNI, time: "14h", text: "Closed UNI/USDC narrow window post-volatility" },
  { kind: "single", token: TOKENS.BTC,  time: "1d",  text: "Tightened BTC/USDC range to ±1.4%" },
  { kind: "single", token: TOKENS.ETH,  time: "1d",  text: "Pulled ETH/USDC outer band, redeployed inner" },
  { kind: "single", token: TOKENS.UNI,  time: "2d",  text: "Skipped UNI/USDC rebalance — gas threshold" },
  { kind: "single", token: TOKENS.USDC, time: "2d",  text: "Drew $4.2k from idle reserve into USDC/USDT" },
  { kind: "single", token: TOKENS.BTC,  time: "3d",  text: "Harvested $4.8k in fees from BTC/USDC" },
  { kind: "pair",   left: TOKENS.UNI,   right: TOKENS.ETH, time: "3d",  text: "Rebalanced UNI/USDC post-narrative shift" },
  { kind: "single", token: TOKENS.ETH,  time: "4d",  text: "Tightened ETH/USDC to ±1.0% mid-volatility" },
  { kind: "single", token: TOKENS.USDC, time: "5d",  text: "Returned $3.1k to idle reserve from BTC/USDC" },
];

type FlowEntry = { fromIdx: number; toIdx: number; amount: string; time: string };
const FLOWS: FlowEntry[] = [
  { fromIdx: 1, toIdx: 3, amount: "$12.4k", time: "17m" },
  { fromIdx: 4, toIdx: 0, amount: "$8.2k",  time: "2h"  },
  { fromIdx: 1, toIdx: 4, amount: "$5.1k",  time: "5h"  },
  { fromIdx: 0, toIdx: 1, amount: "$3.8k",  time: "8h"  },
  { fromIdx: 4, toIdx: 2, amount: "$2.4k",  time: "1d"  },
];

const POOL_RANGES_DATA: Record<string, { upper: number[]; lower: number[]; current: string }> = {
  "ETH/USDC": {
    upper: [0.78,0.80,0.82,0.85,0.83,0.81,0.79,0.82,0.85,0.88,0.85,0.82,0.78,0.75,0.78,0.81,0.84,0.86,0.83,0.80,0.78,0.81,0.83,0.85,0.82,0.79,0.81,0.84,0.82,0.80],
    lower: [0.22,0.20,0.18,0.15,0.17,0.19,0.21,0.18,0.15,0.12,0.15,0.18,0.22,0.25,0.22,0.19,0.16,0.14,0.17,0.20,0.22,0.19,0.17,0.15,0.18,0.21,0.19,0.16,0.18,0.20],
    current: "±0.8%",
  },
  "BTC/USDC": {
    upper: [0.75,0.78,0.80,0.82,0.85,0.83,0.80,0.78,0.81,0.84,0.82,0.79,0.76,0.78,0.81,0.84,0.82,0.79,0.77,0.80,0.83,0.85,0.82,0.79,0.81,0.84,0.86,0.83,0.80,0.78],
    lower: [0.25,0.22,0.20,0.18,0.15,0.17,0.20,0.22,0.19,0.16,0.18,0.21,0.24,0.22,0.19,0.16,0.18,0.21,0.23,0.20,0.17,0.15,0.18,0.21,0.19,0.16,0.14,0.17,0.20,0.22],
    current: "±1.2%",
  },
  "USDC/USDT": {
    upper: [0.55,0.56,0.57,0.55,0.54,0.56,0.58,0.57,0.55,0.54,0.55,0.57,0.58,0.56,0.55,0.54,0.56,0.58,0.57,0.55,0.56,0.58,0.57,0.55,0.54,0.56,0.58,0.57,0.55,0.54],
    lower: [0.45,0.44,0.43,0.45,0.46,0.44,0.42,0.43,0.45,0.46,0.45,0.43,0.42,0.44,0.45,0.46,0.44,0.42,0.43,0.45,0.44,0.42,0.43,0.45,0.46,0.44,0.42,0.43,0.45,0.46],
    current: "±0.05%",
  },
  "UNI/USDC": {
    upper: [0.85,0.82,0.78,0.75,0.80,0.85,0.88,0.85,0.82,0.78,0.82,0.86,0.83,0.80,0.85,0.88,0.84,0.81,0.83,0.86,0.84,0.80,0.78,0.82,0.85,0.82,0.79,0.83,0.86,0.83],
    lower: [0.15,0.18,0.22,0.25,0.20,0.15,0.12,0.15,0.18,0.22,0.18,0.14,0.17,0.20,0.15,0.12,0.16,0.19,0.17,0.14,0.16,0.20,0.22,0.18,0.15,0.18,0.21,0.17,0.14,0.17],
    current: "±2.4%",
  },
};

/* ---------- Backdrop ---------- */

function PanelLandscape({ muted = false }: { muted?: boolean }) {
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, zIndex: 0 }}>
      <Image src="/landscape.png" alt="" fill priority sizes="100vw" style={{
        objectFit: "cover",
        filter: muted ? LANDSCAPE_FILTER_MUTED : LANDSCAPE_FILTER,
      }} />
    </div>
  );
}

/* ---------- Floating nav pill — full main-panel width, sits just above it ---------- */

function FloatingNav({ layout }: { layout: PanelLayout }) {
  const router = useRouter();
  const [exiting, setExiting] = useState(false);

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
        borderRadius: 999,
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
          padding: "8px 12px 8px 18px",
        }}>
          <Link
            href="/"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
              e.preventDefault();
              if (exiting) return;
              setExiting(true);
              router.push("/");
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
            padding: "8px 14px", borderRadius: 999, border: "none",
            color: "#fff", fontFamily: "var(--sans-stack)",
            fontSize: 12, fontWeight: 600, letterSpacing: "-0.005em", lineHeight: 1,
          }}>
            Connect wallet
            <StrokeIcon kind="arrow" size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Hero ---------- */

function Hero() {
  return (
    <div className="reveal" style={{ animationDelay: "100ms" }}>
      <h1 style={{ color: "#fff", fontFamily: "var(--font-radley)", fontSize: 38, lineHeight: 1.08, letterSpacing: "-0.01em", margin: 0, fontWeight: 400 }}>
        Your stake in onchain volume.
      </h1>
      <p style={{ color: "rgba(255,255,255,0.65)", fontFamily: "var(--font-radley)", fontSize: 15, lineHeight: 1.5, margin: "10px 0 0 0", maxWidth: 620 }}>
        Deposit{" "}
        <InlinePill iconImage={{ src: "/tokens/usdc.png", alt: "USDC" }}>USDC</InlinePill>
        {" "}once. An agent rebalances across high-volume pools, keeping an idle reserve for instant withdrawals.
      </p>
    </div>
  );
}

/* ---------- User cards ---------- */

function VaultCard() {
  const [tab, setTab] = useState<"deposit" | "redeem">("deposit");
  const [amount, setAmount] = useState("");
  const isDeposit = tab === "deposit";
  const num = Number.parseFloat(amount.replace(/,/g, "")) || 0;
  const receive = isDeposit ? num / SHARE_PRICE : num * SHARE_PRICE;

  return (
    <Card style={{ display: "flex", flexDirection: "column" }}>
      <CardLabel icon="vault">Vault</CardLabel>
      <div style={{ marginTop: 12 }}>
        <H3>{isDeposit ? "Deposit USDC." : "Redeem ALP."}</H3>
      </div>

      <div style={{ marginTop: 14, display: "inline-flex", padding: 4, gap: 4, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, width: "max-content" }}>
        {(["deposit", "redeem"] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} style={{
            border: "none", padding: "6px 14px", borderRadius: 8,
            background: t === tab ? "rgba(255,255,255,0.10)" : "transparent",
            color: t === tab ? "#fff" : "rgba(255,255,255,0.55)",
            fontFamily: "var(--sans-stack)", fontSize: 12, fontWeight: 500, lineHeight: 1,
            transition: "background 200ms ease, color 200ms ease",
          }}>
            {t === "deposit" ? "Deposit" : "Redeem"}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 11, letterSpacing: "0.02em", lineHeight: 1, marginBottom: 8 }}>
          <span style={{ textTransform: "uppercase", fontWeight: 500 }}>Amount</span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>Balance: 0.00 {isDeposit ? "USDC" : "ALP"}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 12px 12px 16px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 14 }}>
          <input inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} style={{
            flex: 1, minWidth: 0,
            background: "transparent", border: "none", outline: "none",
            color: "#fff", fontFamily: "var(--sans-stack)",
            fontSize: 24, fontWeight: 500, letterSpacing: "-0.01em", lineHeight: 1.1, fontVariantNumeric: "tabular-nums",
          }} />
          <button type="button" className="bg-white/[0.08] transition-colors duration-200 ease-out hover:bg-white/[0.14]" style={{
            border: "none", padding: "0 9px", height: 22, borderRadius: 6,
            color: "rgba(255,255,255,0.92)", fontFamily: "var(--sans-stack)",
            fontSize: 11, fontWeight: 600, letterSpacing: "0.04em", lineHeight: 1,
          }}>
            MAX
          </button>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "5px 10px 5px 6px", background: "rgba(255,255,255,0.06)", borderRadius: 999 }}>
            {isDeposit ? <TokenChip entry={TOKENS.USDC} size={18} /> : <AlpChip size={18} />}
            <span style={{ color: "#fff", fontFamily: "var(--sans-stack)", fontSize: 13, fontWeight: 500, lineHeight: 1 }}>
              {isDeposit ? "USDC" : "ALP"}
            </span>
          </span>
        </div>
      </div>

      <div style={{ marginTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 14px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12 }}>
        <span style={{ color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 12, fontWeight: 500 }}>You receive</span>
        <span style={{ color: "#fff", fontFamily: "var(--sans-stack)", fontSize: 13, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
          ≈ {fmtNum(receive)} {isDeposit ? "ALP" : "USDC"}
        </span>
      </div>

      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
        <DetailRow label="Share price" value="$1.0427" />
        <DetailRow label="Withdraw delay" value="Instant up to reserve" />
      </div>

      <button type="button" className="bg-white/[0.20] transition-colors duration-300 ease-out hover:bg-white/[0.32]" style={{
        marginTop: 14, width: "100%",
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
        padding: "12px 16px", borderRadius: 14, border: "none",
        color: "#fff", fontFamily: "var(--sans-stack)",
        fontSize: 13, fontWeight: 600, letterSpacing: "-0.005em", lineHeight: 1,
      }}>
        Connect wallet
        <StrokeIcon kind="arrow" size={13} />
      </button>
    </Card>
  );
}

function PositionCard() {
  return (
    <Card>
      <CardLabel icon="position">Position</CardLabel>
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <StatCell label="Deposited" value="$0.00" />
        <StatCell label="Net APR" value="14.2%" tone="up" />
        <StatCell label="Position" value="0 ALP" />
        <StatCell label="Earnings" value="$0.00" />
      </div>
    </Card>
  );
}

function HistoryCard() {
  const start = APR_30D[0];
  const end = APR_30D[APR_30D.length - 1];
  const delta = end - start;
  const up = delta >= 0;
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <CardLabel icon="position">APR · 30d rolling</CardLabel>
        <span style={{ color: up ? "rgb(134, 239, 172)" : "rgb(252, 165, 165)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.005em", lineHeight: 1, marginTop: 4 }}>
          {up ? "+" : ""}{delta.toFixed(1)}pp
        </span>
      </div>
      <div style={{ marginTop: 10, color: "#fff", fontFamily: "var(--sans-stack)", fontSize: 22, fontWeight: 500, letterSpacing: "-0.015em", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
        {end.toFixed(1)}%
      </div>
      <div style={{ marginTop: 14 }}>
        <Sparkline values={APR_30D} lineColor="rgba(255,255,255,0.70)" fillColor="rgba(255,255,255,0.06)" height={48} />
      </div>
    </Card>
  );
}

function GaugeCell({ pct, color, ariaLabel, slug, centre }: { pct: number; color: string; ariaLabel: string; slug: string; centre: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, minWidth: 60 }}>
      <Gauge pct={pct} color={color} ariaLabel={ariaLabel}>{centre}</Gauge>
      <span style={{ color: "rgba(255,255,255,0.92)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500, letterSpacing: "0.04em", lineHeight: 1, whiteSpace: "nowrap" }}>
        {slug}
      </span>
    </div>
  );
}

function AllocationCard() {
  return (
    <Card>
      <CardLabel icon="allocation">Allocation</CardLabel>
      <div style={{ marginTop: 12 }}>
        <H3>Where deposits sit today.</H3>
      </div>

      <SectionLabel>By token</SectionLabel>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", flexWrap: "wrap" }}>
        {ALLOCATIONS.map((a) => (
          <GaugeCell key={a.slug} pct={a.pct} color={a.color} ariaLabel={`${a.slug} ${a.pct}%`} slug={a.slug} centre={<TokenChip entry={a} size={24} />} />
        ))}
      </div>

      <SectionLabel>Positions</SectionLabel>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {POSITIONS_SORTED.map((p) => (
          <div key={p.slug} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0" }}>
            {p.single ? (
              <TokenChip entry={p.single} size={18} radius={5} />
            ) : (
              <PoolPairChip left={p.pair!.left} right={p.pair!.right} size={16} />
            )}
            <span style={{ flex: 1, color: "rgba(255,255,255,0.92)", fontFamily: "var(--sans-stack)", fontSize: 12, fontWeight: 500, letterSpacing: "-0.005em" }}>
              {p.slug}
            </span>
            <span style={{ color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 12, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
              {p.pct}%
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

/* ---------- Protocol section cards ---------- */

function VaultMetricsCard() {
  return (
    <Card>
      <CardLabel icon="agent">Vault metrics</CardLabel>
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
        <MetricCell icon="vault" label="TVL" value="$3.26M" />
        <MetricCell icon="fees" label="30d fees" value="$42.18k" />
        <MetricCell icon="pools" label="Active pools" value="4" />
        <MetricCell icon="clock" label="Last action" value="2m ago" />
      </div>
    </Card>
  );
}

function ChartCard({ icon, label, value, values, lineColor, fillColor }: { icon: keyof typeof ICONS | string; label: string; value: string; values: number[]; lineColor: string; fillColor: string }) {
  const start = values[0];
  const end = values[values.length - 1];
  const deltaPct = ((end - start) / start) * 100;
  const up = deltaPct >= 0;
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <CardLabel icon={icon}>{label}</CardLabel>
        <span style={{ color: up ? "rgb(134, 239, 172)" : "rgb(252, 165, 165)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.005em", lineHeight: 1, marginTop: 4 }}>
          {up ? "+" : ""}{deltaPct.toFixed(2)}%
        </span>
      </div>
      <div style={{ marginTop: 10, color: "#fff", fontFamily: "var(--sans-stack)", fontSize: 22, fontWeight: 500, letterSpacing: "-0.015em", fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ marginTop: 14 }}>
        <Sparkline values={values} lineColor={lineColor} fillColor={fillColor} height={48} />
      </div>
    </Card>
  );
}

function TvlChartCard() {
  const end = TVL_30D[TVL_30D.length - 1];
  return (
    <ChartCard icon="vault" label="TVL · 30d" value={`$${end.toFixed(2)}M`} values={TVL_30D} lineColor="rgba(255,255,255,0.70)" fillColor="rgba(255,255,255,0.06)" />
  );
}

function SharePriceChartCard() {
  const end = SHARE_PRICE_30D[SHARE_PRICE_30D.length - 1];
  return (
    <ChartCard icon="position" label="Share price · 30d" value={`$${end.toFixed(4)}`} values={SHARE_PRICE_30D} lineColor="rgba(134, 239, 172, 0.85)" fillColor="rgba(134, 239, 172, 0.10)" />
  );
}

/* ---------- Stats section cards ---------- */

function FlowChip({ pool, size = 14 }: { pool: PoolEntry; size?: number }) {
  return pool.single ? (
    <TokenChip entry={pool.single} size={size} radius={4} />
  ) : (
    <PoolPairChip left={pool.pair!.left} right={pool.pair!.right} size={size} />
  );
}

function FlowsCard() {
  return (
    <Card>
      <CardLabel icon="flow">Fund flows</CardLabel>
      <div style={{ marginTop: 12 }}>
        <H3>Where capital moved.</H3>
        <p style={{ margin: "8px 0 0 0", color: "rgba(255,255,255,0.55)", fontFamily: "var(--font-radley)", fontSize: 14, lineHeight: 1.5 }}>
          Recent rotations across pools and the idle reserve.
        </p>
      </div>
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
        {FLOWS.map((f, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.04)" }}>
            <FlowChip pool={POOLS[f.fromIdx]} size={14} />
            <StrokeIcon kind="arrow" size={11} />
            <FlowChip pool={POOLS[f.toIdx]} size={14} />
            <span style={{ flex: 1, color: "rgba(255,255,255,0.92)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500, marginLeft: 4, letterSpacing: "-0.005em" }}>
              {POOLS[f.fromIdx].slug} → {POOLS[f.toIdx].slug}
            </span>
            <span style={{ color: "#fff", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
              {f.amount}
            </span>
            <span style={{ color: "rgba(255,255,255,0.45)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
              {f.time}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RangesCard() {
  const pools = POOLS.filter((p) => p.pair);
  return (
    <Card>
      <CardLabel icon="range">Pool ranges</CardLabel>
      <div style={{ marginTop: 12 }}>
        <H3>How positions adjusted.</H3>
        <p style={{ margin: "8px 0 0 0", color: "rgba(255,255,255,0.55)", fontFamily: "var(--font-radley)", fontSize: 14, lineHeight: 1.5 }}>
          Range bands per pool over the last 30 days.
        </p>
      </div>
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        {pools.map((p) => {
          const data = POOL_RANGES_DATA[p.slug];
          if (!data) return null;
          return (
            <div key={p.slug}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <PoolPairChip left={p.pair!.left} right={p.pair!.right} size={14} />
                <span style={{ color: "rgba(255,255,255,0.92)", fontFamily: "var(--sans-stack)", fontSize: 12, fontWeight: 500, letterSpacing: "-0.005em" }}>
                  {p.slug}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 11, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}>
                  {data.current}
                </span>
              </div>
              <RangeMiniChart upper={data.upper} lower={data.lower} color={p.color} height={32} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ---------- Activity panel content ---------- */

function ActivityPanelContent() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: "20px 16px 18px" }}>
      <div style={{ flexShrink: 0 }}>
        <CardLabel icon="agent">Agent activity</CardLabel>
        <div style={{ marginTop: 10 }}>
          <H3>Continuous decisions.</H3>
          <p style={{ margin: "6px 0 0 0", color: "rgba(255,255,255,0.55)", fontFamily: "var(--font-radley)", fontSize: 13, lineHeight: 1.5 }}>
            247 actions · 30 days
          </p>
        </div>
      </div>

      <div className="panel-scroll" style={{
        marginTop: 14, flex: 1, minHeight: 0,
        overflowY: "auto", overflowX: "hidden",
        display: "flex", flexDirection: "column", gap: 8,
        paddingRight: 4,
      }}>
        {ACTIVITY.map((a, i) => (
          <div key={i} style={{
            display: "flex", alignItems: "flex-start", gap: 9,
            padding: "8px 9px", borderRadius: 9,
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.05)",
            flexShrink: 0,
          }}>
            {a.kind === "pair" ? (
              <PoolPairChip left={a.left} right={a.right} size={14} />
            ) : (
              <TokenChip entry={a.token} size={14} radius={4} />
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                color: "rgba(255,255,255,0.92)",
                fontFamily: "var(--sans-stack)",
                fontSize: 11, lineHeight: 1.35, fontWeight: 400,
              }}>
                {a.text}
              </div>
              <div style={{
                marginTop: 3,
                color: "rgba(255,255,255,0.45)",
                fontFamily: "var(--sans-stack)",
                fontSize: 10, fontWeight: 500,
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "0.02em",
              }}>
                {a.time}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Footer ---------- */

function FooterRow() {
  return (
    <div className="reveal" style={{ marginTop: 22, animationDelay: "500ms", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, color: "rgba(255,255,255,0.55)", fontFamily: "var(--sans-stack)", fontSize: 12 }}>
      <a href="#" className="transition-colors duration-200 hover:text-mist" style={{ color: "rgba(255,255,255,0.55)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
        Vault: 0xA1b2…f9c8
        <StrokeIcon kind="external" size={11} />
      </a>
      <span style={{ color: "rgba(255,255,255,0.45)", fontVariantNumeric: "tabular-nums" }}>v0.0.1</span>
    </div>
  );
}

/* ---------- Page ---------- */

export default function AppPage() {
  const layout = useFullLayout();

  // Body height needs to fit the activity panel below the main panel,
  // plus a small bottom margin. main panel sits at top: layout.main.top,
  // activity sits at top: layout.main.top + layout.main.height + 14.
  const minHeight = layout
    ? `${layout.main.top + 2 * layout.main.height + 14 + 32}px`
    : "100vh";

  return (
    <main style={{
      position: "relative",
      minHeight,
      background: "transparent",
      color: "#fff",
      isolation: "isolate",
    }}>
      <style>{`
        .panel-scroll { scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.10) transparent; }
        .panel-scroll::-webkit-scrollbar { width: 8px; }
        .panel-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.10); border-radius: 999px; }
        .panel-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.18); }
        .panel-scroll::-webkit-scrollbar-track { background: transparent; }

        /* Nav slides up from BEHIND the main panel (covered by the
           panel's higher z-index) to its resting spot 14px above. */
        @keyframes app-nav-enter {
          from { transform: translateY(34px); opacity: 1; }
          to   { transform: translateY(-100%); opacity: 1; }
        }
        .app-nav-enter { animation: app-nav-enter 760ms cubic-bezier(0.16, 1, 0.3, 1) both; }

        /* Exit reverses the entry — nav slides back down behind the panel.
           router.push fires in parallel so the animation runs while /app
           stays mounted, then gets cut cleanly by the route swap. */
        @keyframes app-nav-exit {
          from { transform: translateY(-100%); opacity: 1; }
          to   { transform: translateY(34px); opacity: 1; }
        }
        .app-nav-exit { animation: app-nav-exit 760ms cubic-bezier(0.16, 1, 0.3, 1) forwards; }
      `}</style>

      {layout && <FloatingNav layout={layout.main} />}

      {/* Main panel at the LMC rect. */}
      {layout && (
        <section style={{
          position: "absolute",
          left: layout.main.left, top: layout.main.top, width: layout.main.width, height: layout.main.height,
          borderRadius: 20 * layout.main.scale,
          overflow: "hidden",
          display: "flex", flexDirection: "column",
          isolation: "isolate",
          zIndex: 2,
        }}>
          <PanelLandscape />
          <div className="panel-scroll" style={{
            flex: 1, minHeight: 0,
            overflowY: "auto", overflowX: "hidden",
            // Wheel-over-main scrolls interior only; cursor outside the
            // panel scrolls the page down to the activity panel below.
            overscrollBehavior: "contain",
            position: "relative", zIndex: 1,
          }}>
            <div style={{ padding: "26px 28px 28px" }}>
              <Hero />

              {/* USER — CTA on top, Position+APR sub-row, Allocation full width */}
              <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 14 }}>
                <div className="reveal" style={{ animationDelay: "200ms" }}>
                  <VaultCard />
                </div>
                <div className="reveal" style={{ animationDelay: "260ms", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                  <PositionCard />
                  <HistoryCard />
                </div>
                <div className="reveal" style={{ animationDelay: "320ms" }}>
                  <AllocationCard />
                </div>
              </div>

              {/* PROTOCOL — vault-wide stats */}
              <PageSection label="Protocol">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-3.5 items-start">
                  <div className="reveal" style={{ animationDelay: "180ms" }}>
                    <VaultMetricsCard />
                  </div>
                  <div className="reveal" style={{ animationDelay: "260ms" }}>
                    <TvlChartCard />
                  </div>
                  <div className="reveal" style={{ animationDelay: "340ms" }}>
                    <SharePriceChartCard />
                  </div>
                </div>
              </PageSection>

              {/* STATS — fund flows + pool ranges (placeholder until Uniswap chart goes in) */}
              <PageSection label="Stats">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5 items-start">
                  <div className="reveal" style={{ animationDelay: "180ms" }}>
                    <FlowsCard />
                  </div>
                  <div className="reveal" style={{ animationDelay: "260ms" }}>
                    <RangesCard />
                  </div>
                </div>
              </PageSection>

              <FooterRow />
            </div>
          </div>
        </section>
      )}


      {/* Activity panel — same LMC framing as main, sits below it,
          scrolled into view. Greyscaled landscape so it reads as
          recessed vs the colourful main panel above. */}
      {layout && (
        <section style={{
          position: "absolute",
          left: layout.main.left,
          top: layout.main.top + layout.main.height + 14,
          width: layout.main.width,
          height: layout.main.height,
          borderRadius: 20 * layout.main.scale,
          overflow: "hidden",
          display: "flex", flexDirection: "column",
          isolation: "isolate",
          zIndex: 2,
        }}>
          <PanelLandscape muted />

          <div style={{ position: "relative", zIndex: 1, height: "100%" }}>
            <ActivityPanelContent />
          </div>
        </section>
      )}
    </main>
  );
}
