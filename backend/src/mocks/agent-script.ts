// Scripted agent feed.
//   - primingHistory(): seed events timestamped in the recent past — SIGNAL
//     ONLY. Action events were stripped at B5 because every action
//     WireMessage must carry a real on-chain tx hash; the FE prefixes
//     https://basescan.org/tx/ to action.tx, and basescan-clickthrough
//     credibility breaks if hashes are fabricated. Real chain action events
//     are emitted by topics/agent.ts:startAgentActionBridge in chain mode.
//   - liveSignalText(i): canned text used by the periodic signal broadcaster
//     (still runs in both modes — quiet-chain demo color).
//   - cannedReply(text): scripted reply for user messages.

import type { WireMessage } from "../types";
import { ulid } from "../ulid";

type SeedEntry = { kind: "signal"; offsetMs: number; text: string };

const SEEDS: SeedEntry[] = [
  { kind: "signal", offsetMs: 0,           text: "ETH/USDC realised vol ticked up — fee APR window 18–22%." },
  { kind: "signal", offsetMs: 12 * 60_000, text: "BTC/USDC pool fees accruing — claim queued for the next rebalance." },
  { kind: "signal", offsetMs: 25 * 60_000, text: "UNI swap volume +14% over the last hour; UNI/USDC APR drifting higher." },
];

export function primingHistory(): WireMessage[] {
  const baseMs = Date.now() - 30 * 60_000;
  const out: WireMessage[] = [];
  for (const s of SEEDS) {
    const t = baseMs + s.offsetMs;
    out.push({
      id: ulid(t),
      ts: new Date(t).toISOString(),
      kind: "signal",
      text: s.text,
    });
  }
  return out;
}

const LIVE_SIGNALS = [
  "ETH/USDC mid drifting; range still in band.",
  "BTC/USDC pool fees crossed $50 threshold this hour.",
  "USDT/USDC depeg risk: monitoring chainlink feed.",
  "UNI volatility cooling; will re-evaluate range width at next bar.",
  "Idle reserve at 38% — ample for instant withdrawals.",
  "ETH/USDC tick density up; tighter ranges look attractive.",
];

export function liveSignalText(i: number): string {
  return LIVE_SIGNALS[i % LIVE_SIGNALS.length]!;
}

export function cannedReply(_userText: string): string {
  return "Got it. The basket is currently weighted USDC 38 / ETH 24 / BTC 18 / USDT 12 / UNI 8. I'll keep watching the pools and surface any rebalances here.";
}
