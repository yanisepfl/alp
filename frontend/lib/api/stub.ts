// Dev stub — satisfies the ApiClient surface with frozen mock data.
//
// Selected by hooks.ts when `NEXT_PUBLIC_SHERPA_WSS_URL` is unset.
// Everything below is mock data scoped to this file; renaming or
// reshaping it doesn't propagate to the live client.

import { clientId } from "@/lib/agent-stream";
import type {
  AgentHandlers,
  ApiClient,
  SendResult,
  Unsubscribe,
  UserHandlers,
  UserSnapshot,
  VaultHandlers,
  VaultSnapshot,
  WireMessage,
} from "./types";

// ---- Mock values ----

const sharePrice = 1.0427;

const sharePrice30d = [
  1.0000, 0.9994, 1.0008, 1.0021, 1.0014, 1.0035, 1.0028, 1.0049, 1.0061, 1.0078,
  1.0090, 1.0089, 1.0103, 1.0118, 1.0127, 1.0145, 1.0162, 1.0179, 1.0184, 1.0202,
  1.0218, 1.0228, 1.0218, 1.0234, 1.0252, 1.0268, 1.0290, 1.0312, 1.0349, 1.0427,
];
const tvl30d = [
  3.05, 3.07, 3.08, 3.06, 3.09, 3.11, 3.13, 3.12, 3.15, 3.16,
  3.18, 3.19, 3.17, 3.20, 3.22, 3.21, 3.24, 3.23, 3.25, 3.27,
  3.25, 3.26, 3.27, 3.28, 3.26, 3.27, 3.29, 3.28, 3.27, 3.26,
];
const apr30d = [
  11.2, 11.5, 11.8, 12.1, 11.9, 12.3, 12.8, 12.6, 13.0, 13.2,
  13.5, 13.3, 13.4, 13.7, 13.9, 14.2, 14.0, 13.8, 13.6, 13.9,
  14.1, 14.3, 14.0, 13.8, 14.0, 14.2, 14.4, 14.1, 14.0, 14.2,
];
const basketApr = 14.2;
const usersCount = 247;

const userDepositTs  = "2026-02-27T10:14:00";
const userDepositAmt = 5000;
// Full 66-char hash. Backend always sends full hashes
// (../../../CONTRACT.md §1); the frontend shortens for display.
const userDepositTx  = "0x82a3000000000000000000000000000000000000000000000000000000004d91";
const userEntryPrice = 1.0184;

const userSharesNum  = userDepositAmt / userEntryPrice;
const userValueUsd   = userSharesNum * sharePrice;
const userDaysHeld   = 60;

// Wei-precision shares string the contract requires. ALP shares are
// 1e18-scaled like USDC's vault-token convention.
const sharesWei = BigInt(Math.round(userSharesNum * 1e6)) * 10n ** 12n;

const vaultAddress = "0xA1b2C3d4E5f6789012345678901234567890f9C8";

// ---- Snapshot builders ----

function buildVaultSnapshot(): VaultSnapshot {
  const ts = new Date().toISOString();
  const earned: Record<string, number> = {
    "eth-usdc":   1240.50,
    "btc-usdc":    890.20,
    "usdc-usdt":   320.10,
    "uni-usdc":    215.80,
    "idle-reserve": 0.00,
  };
  return {
    address: vaultAddress,
    chainId: 8453,
    sharePrice,
    tvl: tvl30d[tvl30d.length - 1],
    basketApr,
    basketEarned30d: Object.values(earned).reduce((a, n) => a + n, 0),
    users: usersCount,
    sharePrice30d,
    tvl30d,
    apr30d,
    allocations: [
      { token: "USDC", pct: 38 },
      { token: "ETH",  pct: 24 },
      { token: "BTC",  pct: 18 },
      { token: "USDT", pct: 12 },
      { token: "UNI",  pct:  8 },
    ],
    pools: [
      { slug: "eth-usdc",     label: "ETH/USDC",     pct: 24, position: { kind: "pair",   left: "ETH",  right: "USDC" }, apr: 18.4, earned30d: earned["eth-usdc"] },
      { slug: "btc-usdc",     label: "BTC/USDC",     pct: 18, position: { kind: "pair",   left: "BTC",  right: "USDC" }, apr: 14.2, earned30d: earned["btc-usdc"] },
      { slug: "usdc-usdt",    label: "USDC/USDT",    pct: 12, position: { kind: "pair",   left: "USDC", right: "USDT" }, apr:  8.6, earned30d: earned["usdc-usdt"] },
      { slug: "uni-usdc",     label: "UNI/USDC",     pct:  8, position: { kind: "pair",   left: "UNI",  right: "USDC" }, apr: 22.1, earned30d: earned["uni-usdc"] },
      { slug: "idle-reserve", label: "Idle reserve", pct: 38, position: { kind: "single", token: "USDC" },                apr:  0.0, earned30d: earned["idle-reserve"] },
    ],
    ts,
  };
}

function buildUserSnapshot(): UserSnapshot {
  const pnlUsd = userValueUsd - userDepositAmt;
  const pnlPct = (pnlUsd / userDepositAmt) * 100;
  const realizedApyPct = ((userValueUsd / userDepositAmt) ** (365 / userDaysHeld) - 1) * 100;
  const ts = new Date().toISOString();
  return {
    wallet: "0x0000000000000000000000000000000000000000",
    position: {
      shares: sharesWei.toString(),
      valueUsd: userValueUsd,
      costBasisSharePrice: userEntryPrice,
      totalDepositedUsd: userDepositAmt,
      firstDepositTs: userDepositTs,
      pnlUsd,
      pnlPct,
      realizedApyPct,
    },
    activity: [
      {
        id: "act_dep_001",
        kind: "deposit",
        amount: userDepositAmt,
        token: "USDC",
        ts: userDepositTs,
        tx: userDepositTx,
      },
    ],
    ts,
  };
}

const seedAgentMessages: WireMessage[] = [
  { id: "evt_001", ts: "2026-04-28T05:18:00", kind: "signal", text: "USDC/USDT stable-pair fees: $890 accrued." },
  { id: "evt_002", ts: "2026-04-28T05:24:00", kind: "action", title: "Action submitted", category: "claim_fees", chip: { type: "single", token: "USDT" }, tx: "0xc4e20000000000000000000000000000000000000000000000000000000077f9",
    text: "Compounded $890 from USDC/USDT into LP." },
  { id: "evt_003", ts: "2026-04-28T08:11:00", kind: "signal", text: "ETH/USDC mid drifted to $4,124, +1.4% from band center." },
  { id: "evt_004", ts: "2026-04-28T08:24:00", kind: "action", title: "Action submitted", category: "edit_position", chip: { type: "single", token: "ETH" }, tx: "0x9f150000000000000000000000000000000000000000000000000000000c0780",
    thought: "Drift exceeds the rebalance threshold. Recentering before fees decay further.",
    text: "Rebalanced ETH/USDC at $4,124 mid. New range ±1.0%." },
  { id: "evt_005", ts: "2026-04-28T09:55:00", kind: "signal", text: "TWAP divergence between USDC and USDT widening to 4 bps." },
  { id: "evt_006", ts: "2026-04-28T11:20:00", kind: "signal", text: "UNI/USDC price re-entered the inner range." },
  { id: "evt_007", ts: "2026-04-28T11:25:00", kind: "action", title: "Action submitted", category: "edit_position", chip: { type: "single", token: "UNI" }, tx: "0x2e91000000000000000000000000000000000000000000000000000000044ab0",
    text: "Closed UNI/USDC outer band to reserve. Price action settled inside the inner range." },
  { id: "evt_008", ts: "2026-04-28T13:18:00", kind: "signal", text: "UNI 1h volume +43% post-governance vote." },
  { id: "evt_009", ts: "2026-04-28T13:25:00", kind: "action", title: "Action submitted", category: "swap", chip: { type: "pair", left: "BTC", right: "UNI" }, tx: "0xa7d3000000000000000000000000000000000000000000000000000000091f20",
    thought: "Volume regime shift on UNI looks structural, not a wick. Reallocating exposure.",
    text: "Rotated 5% from BTC/USDC into UNI/USDC." },
  { id: "evt_010", ts: "2026-04-28T14:01:00", kind: "signal", text: "Accrued fees on BTC/USDC: $1.21k." },
  { id: "evt_011", ts: "2026-04-28T14:08:00", kind: "action", title: "Action submitted", category: "claim_fees", chip: { type: "single", token: "BTC" }, tx: "0xb1c200000000000000000000000000000000000000000000000000000008e4d0",
    text: "Harvested $1.2k in fees from BTC/USDC and compounded back into the position." },
  { id: "evt_012", ts: "2026-04-28T14:15:00", kind: "signal", text: "ETH/USDC realized vol −22% over the last 4h." },
  { id: "evt_013", ts: "2026-04-28T14:23:00", kind: "action", title: "Action submitted", category: "edit_position", chip: { type: "single", token: "ETH" }, tx: "0x4f8a00000000000000000000000000000000000000000000000000000000c3b1",
    thought: "Vol contracting cleanly. A tighter band captures more of the spread without raising rebalance frequency.",
    text: "Tightened ETH/USDC to ±0.8%. Realized vol dropped 22% in the last 4h, capturing more of the spread in a tighter band." },
];

// ---- Stub client ----

export function createStubClient(): ApiClient {
  const agentListeners = new Set<AgentHandlers>();
  const vaultListeners = new Set<VaultHandlers>();
  const userListeners = new Set<UserHandlers>();

  const vaultSnap = buildVaultSnapshot();
  const userSnap = buildUserSnapshot();
  const agentSeed = seedAgentMessages.slice();
  let agentCursor: string | undefined = agentSeed.at(-1)?.id;

  return {
    subscribeAgent(h: AgentHandlers): Unsubscribe {
      agentListeners.add(h);
      queueMicrotask(() => h.onHistory?.(agentSeed.slice(), agentCursor));
      return () => { agentListeners.delete(h); };
    },
    subscribeVault(h: VaultHandlers): Unsubscribe {
      vaultListeners.add(h);
      queueMicrotask(() => h.onSnapshot?.(vaultSnap));
      return () => { vaultListeners.delete(h); };
    },
    subscribeUser(h: UserHandlers): Unsubscribe {
      userListeners.add(h);
      queueMicrotask(() => h.onSnapshot?.(userSnap));
      return () => { userListeners.delete(h); };
    },
    sendUserMessage(text: string): SendResult {
      const cid = clientId();
      // Echo a synthetic reply on a short delay so optimistic UI rows
      // get the same reconcile path the live client provides. The
      // stub never reports a disconnected/rejected send — error
      // surfaces are dormant in stub mode.
      const userMsg: WireMessage = { id: cid, ts: new Date().toISOString(), kind: "user", text };
      agentSeed.push(userMsg);
      agentCursor = cid;
      for (const h of agentListeners) h.onEvent?.(userMsg);
      window.setTimeout(() => {
        const replyId = `r_${Date.now().toString(36)}`;
        const reply: WireMessage = {
          id: replyId,
          ts: new Date().toISOString(),
          kind: "reply",
          text: "Stub reply — connect a real backend to replace this.",
          replyTo: cid,
        };
        agentSeed.push(reply);
        agentCursor = replyId;
        for (const h of agentListeners) h.onEvent?.(reply);
      }, 1200);
      return { ok: true, clientId: cid };
    },
    setWallet(_wallet: string | undefined): void {
      // No-op; the stub serves the same data regardless of wallet.
    },
    forceReconnect(): void {
      // No-op; the stub has no transport.
    },
    close(): void {
      agentListeners.clear();
      vaultListeners.clear();
      userListeners.clear();
    },
  };
}
