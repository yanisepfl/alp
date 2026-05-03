// Mock VaultSnapshot used in mock mode (when VAULT_ADDRESS is unset).

import type { VaultSnapshot, VaultTick } from "../types";

const VAULT_ADDRESS = "0xA1b2C3d4E5F6789012345678901234567890ABcd"; // placeholder

function genSeries(start: number, end: number, len: number, jitter: number, decimals: number): number[] {
 const arr: number[] = [];
 for (let i = 0; i < len; i++) {
 const t = i / (len - 1);
 const drift = start + (end - start) * t;
 const noise = (Math.random() - 0.5) * 2 * jitter;
 arr.push(Number((drift + noise).toFixed(decimals)));
 }
 arr[len - 1] = Number(end.toFixed(decimals));
 return arr;
}

const snapshot: VaultSnapshot = {
 address: VAULT_ADDRESS,
 chainId: 8453,
 sharePrice: 1.0427,
 tvl: 3.26,
 basketApr: 14.2,
 basketEarned30d: 2666.60,
 users: 247,
 sharePrice30d: genSeries(1.0184, 1.0427, 30, 0.0008, 4),
 tvl30d: genSeries(2.85, 3.26, 30, 0.04, 3),
 apr30d: genSeries(13.0, 14.2, 30, 0.4, 2),
 allocations: [
 { token: "USDC", pct: 38 },
 { token: "ETH", pct: 24 },
 { token: "BTC", pct: 18 },
 { token: "USDT", pct: 12 },
 { token: "UNI", pct: 8 },
 ],
 pools: [
 { slug: "eth-usdc-005", label: "ETH/USDC", pct: 24, position: { kind: "pair", left: "ETH", right: "USDC" }, apr: 18.0, earned30d: 880.00 },
 { slug: "btc-usdc-005", label: "BTC/USDC", pct: 18, position: { kind: "pair", left: "BTC", right: "USDC" }, apr: 16.0, earned30d: 720.00 },
 { slug: "usdt-usdc-001", label: "USDT/USDC", pct: 12, position: { kind: "pair", left: "USDT", right: "USDC" }, apr: 8.0, earned30d: 380.00 },
 { slug: "uni-usdc-03", label: "UNI/USDC", pct: 8, position: { kind: "pair", left: "UNI", right: "USDC" }, apr: 22.0, earned30d: 510.00 },
 { slug: "idle-reserve", label: "Idle reserve", pct: 38, position: { kind: "single", token: "USDC" }, apr: 5.0, earned30d: 176.60 },
 ],
 ts: new Date().toISOString(),
};

export function currentVaultSnapshot(): VaultSnapshot {
 return { ...snapshot, ts: new Date().toISOString() };
}

// Mutate the live scalars and return a partial tick. Random-walk only;
// the 30-point series arrays stay fixed in mock mode.
export function stepVault(): VaultTick {
 snapshot.sharePrice = clamp(snapshot.sharePrice + (Math.random() - 0.5) * 0.001, 1.00, 1.10);
 snapshot.tvl = clamp(snapshot.tvl + (Math.random() - 0.5) * 0.01, 2.50, 4.00);
 snapshot.basketApr = clamp(snapshot.basketApr + (Math.random() - 0.5) * 0.10, 10.0, 20.0);
 snapshot.sharePrice = round(snapshot.sharePrice, 4);
 snapshot.tvl = round(snapshot.tvl, 3);
 snapshot.basketApr = round(snapshot.basketApr, 2);
 snapshot.ts = new Date().toISOString();
 return {
 ts: snapshot.ts,
 sharePrice: snapshot.sharePrice,
 tvl: snapshot.tvl,
 basketApr: snapshot.basketApr,
 };
}

function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
function round(n: number, d: number): number { return Number(n.toFixed(d)); }
