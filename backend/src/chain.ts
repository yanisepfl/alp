// Read-only viem client for Base mainnet. Lazy singleton — null if
// BASE_RPC_URL is unset, so the caller can branch to the B1 mock ticker.
//
// Reference (do NOT call): USDC on Base mainnet is
//   0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 (6 decimals)
// All reads in B3 go through the vault (ERC4626) — never USDC directly.

import { createPublicClient, http, type PublicClient } from "viem";
import { base } from "viem/chains";
import type { TokenSymbol } from "./types";

// USDC on Base — used by the B3b indexer to determine which side of a
// FeesCollected event is the base asset (USDC). Lower-cased; compare with
// .toLowerCase() on counterparts.
export const USDC_BASE_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;

// Address → display symbol resolver for B5 action messages. Keys are
// lower-cased Base mainnet addresses. UNI on Base is intentionally absent —
// no canonical bridged address pinned at hackathon time; falls through to
// the unknown-token warning path and is rendered as "USDC" so the chip
// stays readable. Add to this map as new pools are tracked.
export const TOKEN_BY_ADDRESS: Record<string, TokenSymbol> = {
  "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
  "0x4200000000000000000000000000000000000006": "ETH",   // WETH on Base
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "BTC",   // cbBTC on Base
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": "USDT",
};

const warnedUnknownTokens = new Set<string>();
export function tokenSymbolForAddress(addr: string): TokenSymbol {
  const k = addr.toLowerCase();
  const sym = TOKEN_BY_ADDRESS[k];
  if (sym) return sym;
  if (!warnedUnknownTokens.has(k)) {
    warnedUnknownTokens.add(k);
    console.warn(`[chain] unknown token address ${addr} — defaulting to USDC for display`);
  }
  return "USDC";
}

const TOKEN_DECIMALS: Record<TokenSymbol, number> = {
  USDC: 6,
  USDT: 6,
  ETH: 18,
  BTC: 8,
  UNI: 18,
};

export function tokenDecimals(sym: TokenSymbol): number {
  return TOKEN_DECIMALS[sym] ?? 18;
}

export const erc4626Abi = [
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "convertToAssets",
    stateMutability: "view",
    inputs: [{ name: "shares", type: "uint256" }],
    outputs: [{ name: "assets", type: "uint256" }],
  },
] as const;

// Event ABIs consumed by the B3b indexer. Transfer is the inherited ERC20
// event on the vault's own share token; FeesCollected and PoolTracked are
// declared on ALPVault (see alp/contracts/src/ALPVault.sol L126,L133).
export const vaultEventsAbi = [
  {
    type: "event", name: "Transfer",
    inputs: [
      { name: "from",  type: "address", indexed: true },
      { name: "to",    type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "FeesCollected",
    inputs: [
      { name: "poolKey",    type: "bytes32", indexed: true },
      { name: "positionId", type: "uint256", indexed: false },
      { name: "amount0",    type: "uint256", indexed: false },
      { name: "amount1",    type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "PoolTracked",
    inputs: [
      { name: "poolKey",      type: "bytes32", indexed: true },
      { name: "nonBaseToken", type: "address", indexed: true },
    ],
  },
  // B5 — agent-action surface. The vault emits these when the agent's
  // executeAddLiquidity / executeRemoveLiquidity / executeSwap /
  // executeCollectFees calls land on chain (or, for the position-tracking
  // pair, when ALPVault's bookkeeping mints/burns a position id). The
  // indexer fans them out via subscribeAgentActions to topics/agent.ts,
  // which translates each into an action WireMessage carrying the real
  // tx hash.
  {
    type: "event", name: "LiquidityAdded",
    inputs: [
      { name: "poolKey",     type: "bytes32", indexed: true },
      { name: "positionId",  type: "uint256", indexed: false },
      { name: "amount0Used", type: "uint256", indexed: false },
      { name: "amount1Used", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "LiquidityRemoved",
    inputs: [
      { name: "poolKey",    type: "bytes32", indexed: true },
      { name: "positionId", type: "uint256", indexed: false },
      { name: "amount0Out", type: "uint256", indexed: false },
      { name: "amount1Out", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "Swapped",
    inputs: [
      { name: "poolKey",   type: "bytes32", indexed: true },
      { name: "tokenIn",   type: "address", indexed: true },
      { name: "amountIn",  type: "uint256", indexed: false },
      { name: "amountOut", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "PositionTracked",
    inputs: [
      { name: "poolKey",    type: "bytes32", indexed: true },
      { name: "positionId", type: "uint256", indexed: true },
    ],
  },
  {
    type: "event", name: "PositionUntracked",
    inputs: [
      { name: "poolKey",    type: "bytes32", indexed: true },
      { name: "positionId", type: "uint256", indexed: true },
    ],
  },
  // ERC4626 Deposit / Withdraw — drive B4 per-wallet lot tracking +
  // activity rows. `owner` is the share-holding party we key state by.
  {
    type: "event", name: "Deposit",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "owner",  type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event", name: "Withdraw",
    inputs: [
      { name: "sender",   type: "address", indexed: true },
      { name: "receiver", type: "address", indexed: true },
      { name: "owner",    type: "address", indexed: true },
      { name: "assets",   type: "uint256", indexed: false },
      { name: "shares",   type: "uint256", indexed: false },
    ],
  },
] as const;

let _client: PublicClient | null = null;

export function getPublicClient(): PublicClient | null {
  if (_client) return _client;
  const rpc = Bun.env.BASE_RPC_URL;
  if (!rpc) return null;
  // The default-generic PublicClient widens the chain-bound client returned
  // by createPublicClient; cast keeps the rest of the code generic without
  // dragging the chain type parameter through every helper signature.
  _client = createPublicClient({ chain: base, transport: http(rpc) }) as PublicClient;
  return _client;
}

export function vaultAddress(): `0x${string}` | null {
  const a = Bun.env.VAULT_ADDRESS;
  if (!a || a === "mock") return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  return a as `0x${string}`;
}
