// Read-only viem client for Base mainnet. Lazy singleton — null if
// BASE_RPC_URL is unset, so the caller can branch to the mock ticker.

import { createPublicClient, fallback, http, type PublicClient } from "viem";
import { base } from "viem/chains";
import type { TokenSymbol } from "./types";

// USDC on Base — used by the indexer to determine which side of a
// FeesCollected event is the base asset. Lower-cased.
export const USDC_BASE_ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as const;

// ALPVault overrides ERC4626 _decimalsOffset() to 6, so the share token's
// decimals are USDC's 6 + offset 6 = 12 (NOT the OZ-default 18). All
// share-amount math (sharePrice computation, balance → valueUsd, basis
// lot WAVG) must use this scale.
export const SHARE_DECIMALS = 12;
export const SHARE_UNIT = 10n ** BigInt(SHARE_DECIMALS);

// Address → display symbol resolver for action messages. Keys are
// lower-cased Base mainnet addresses. Native ETH (0x0…0) is the V4
// convention for the chain's native asset; several V4 pools (including
// the deployed ETH/USDC dynamic-fee pool) list it as token0. Same display
// symbol as WETH (`0x420…06`) since the FE has only one ETH chip.
export const TOKEN_BY_ADDRESS: Record<string, TokenSymbol> = {
 "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": "USDC",
 "0x0000000000000000000000000000000000000000": "ETH", // native ETH (V4 token0 convention)
 "0x4200000000000000000000000000000000000006": "ETH", // WETH on Base
 "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "BTC", // cbBTC on Base
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

// Composition reads against ALPVault. The Pool tuple mirrors
// PoolRegistry.Pool's storage layout. All four functions are pure view,
// called from topics/vault-composition.ts to populate snapshot.pools +
// snapshot.allocations.
export const vaultCompositionAbi = [
 {
 type: "function",
 name: "getActivePools",
 stateMutability: "view",
 inputs: [],
 outputs: [{ name: "", type: "bytes32[]" }],
 },
 {
 type: "function",
 name: "trackedPool",
 stateMutability: "view",
 inputs: [{ name: "key", type: "bytes32" }],
 outputs: [{
 name: "", type: "tuple",
 components: [
 { name: "adapter", type: "address" },
 { name: "token0", type: "address" },
 { name: "token1", type: "address" },
 { name: "hooks", type: "address" },
 { name: "fee", type: "uint24" },
 { name: "tickSpacing", type: "int24" },
 { name: "maxAllocationBps", type: "uint16" },
 { name: "enabled", type: "bool" },
 ],
 }],
 },
 {
 type: "function",
 name: "getPositionIds",
 stateMutability: "view",
 inputs: [{ name: "poolKey", type: "bytes32" }],
 outputs: [{ name: "", type: "uint256[]" }],
 },
 {
 type: "function",
 name: "poolValueExternal",
 stateMutability: "view",
 inputs: [{ name: "key", type: "bytes32" }],
 outputs: [{ name: "", type: "uint256" }],
 },
] as const;

// Adapter views for per-position token decomposition + spot pricing. The
// Pool tuple is identical to vaultCompositionAbi's `trackedPool` return.
export const adapterAbi = [
 {
 type: "function",
 name: "getPositionAmountsAtPrice",
 stateMutability: "view",
 inputs: [
 {
 name: "pool", type: "tuple",
 components: [
 { name: "adapter", type: "address" },
 { name: "token0", type: "address" },
 { name: "token1", type: "address" },
 { name: "hooks", type: "address" },
 { name: "fee", type: "uint24" },
 { name: "tickSpacing", type: "int24" },
 { name: "maxAllocationBps", type: "uint16" },
 { name: "enabled", type: "bool" },
 ],
 },
 { name: "positionId", type: "uint256" },
 { name: "sqrtPriceX96", type: "uint160" },
 ],
 outputs: [
 { name: "amount0", type: "uint256" },
 { name: "amount1", type: "uint256" },
 ],
 },
 {
 type: "function",
 name: "getSpotSqrtPriceX96",
 stateMutability: "view",
 inputs: [
 {
 name: "pool", type: "tuple",
 components: [
 { name: "adapter", type: "address" },
 { name: "token0", type: "address" },
 { name: "token1", type: "address" },
 { name: "hooks", type: "address" },
 { name: "fee", type: "uint24" },
 { name: "tickSpacing", type: "int24" },
 { name: "maxAllocationBps", type: "uint16" },
 { name: "enabled", type: "bool" },
 ],
 },
 ],
 outputs: [{ name: "sqrtPriceX96", type: "uint160" }],
 },
] as const;

// USDC.balanceOf(vault) read for the idle reserve.
export const erc20BalanceAbi = [
 {
 type: "function",
 name: "balanceOf",
 stateMutability: "view",
 inputs: [{ name: "account", type: "address" }],
 outputs: [{ name: "", type: "uint256" }],
 },
] as const;

// Event ABIs consumed by the indexer. Transfer is the inherited ERC20
// event on the vault's own share token; FeesCollected and PoolTracked are
// declared on ALPVault.
export const vaultEventsAbi = [
 {
 type: "event", name: "Transfer",
 inputs: [
 { name: "from", type: "address", indexed: true },
 { name: "to", type: "address", indexed: true },
 { name: "value", type: "uint256", indexed: false },
 ],
 },
 {
 type: "event", name: "FeesCollected",
 inputs: [
 { name: "poolKey", type: "bytes32", indexed: true },
 { name: "positionId", type: "uint256", indexed: false },
 { name: "amount0", type: "uint256", indexed: false },
 { name: "amount1", type: "uint256", indexed: false },
 ],
 },
 {
 type: "event", name: "PoolTracked",
 inputs: [
 { name: "poolKey", type: "bytes32", indexed: true },
 { name: "nonBaseToken", type: "address", indexed: true },
 ],
 },
 // Agent-action events. The indexer fans them out via subscribeAgentActions
 // to topics/agent.ts, which translates each into an action WireMessage
 // carrying the real tx hash.
 {
 type: "event", name: "LiquidityAdded",
 inputs: [
 { name: "poolKey", type: "bytes32", indexed: true },
 { name: "positionId", type: "uint256", indexed: false },
 { name: "amount0Used", type: "uint256", indexed: false },
 { name: "amount1Used", type: "uint256", indexed: false },
 ],
 },
 {
 type: "event", name: "LiquidityRemoved",
 inputs: [
 { name: "poolKey", type: "bytes32", indexed: true },
 { name: "positionId", type: "uint256", indexed: false },
 { name: "amount0Out", type: "uint256", indexed: false },
 { name: "amount1Out", type: "uint256", indexed: false },
 ],
 },
 {
 type: "event", name: "Swapped",
 inputs: [
 { name: "poolKey", type: "bytes32", indexed: true },
 { name: "tokenIn", type: "address", indexed: true },
 { name: "amountIn", type: "uint256", indexed: false },
 { name: "amountOut", type: "uint256", indexed: false },
 ],
 },
 {
 type: "event", name: "PositionTracked",
 inputs: [
 { name: "poolKey", type: "bytes32", indexed: true },
 { name: "positionId", type: "uint256", indexed: true },
 ],
 },
 {
 type: "event", name: "PositionUntracked",
 inputs: [
 { name: "poolKey", type: "bytes32", indexed: true },
 { name: "positionId", type: "uint256", indexed: true },
 ],
 },
 // ERC4626 Deposit / Withdraw — drive per-wallet lot tracking + activity
 // rows. `owner` is the share-holding party we key state by.
 {
 type: "event", name: "Deposit",
 inputs: [
 { name: "sender", type: "address", indexed: true },
 { name: "owner", type: "address", indexed: true },
 { name: "assets", type: "uint256", indexed: false },
 { name: "shares", type: "uint256", indexed: false },
 ],
 },
 {
 type: "event", name: "Withdraw",
 inputs: [
 { name: "sender", type: "address", indexed: true },
 { name: "receiver", type: "address", indexed: true },
 { name: "owner", type: "address", indexed: true },
 { name: "assets", type: "uint256", indexed: false },
 { name: "shares", type: "uint256", indexed: false },
 ],
 },
] as const;

let _client: PublicClient | null = null;

export function getPublicClient(): PublicClient | null {
 if (_client) return _client;
 const rpc = Bun.env.BASE_RPC_URL;
 if (!rpc) return null;
 // Optional secondary RPC — wired through viem's fallback() so we try the
 // primary first and only spill to the fallback on transport errors
 // (rate-limit, timeout, network). Default rank=false keeps strict primary
 // ordering rather than racing for the fastest.
 const fallbackRpc = Bun.env.BASE_RPC_URL_FALLBACK;
 const transport = fallbackRpc
 ? fallback([http(rpc), http(fallbackRpc)])
 : http(rpc);
 console.log(`[chain] transport: primary=${rpc}${fallbackRpc ? ` fallback=${fallbackRpc}` : ""}`);
 // Cast keeps callers generic without dragging the chain type parameter
 // through every helper signature.
 _client = createPublicClient({ chain: base, transport }) as PublicClient;
 return _client;
}

export function vaultAddress(): `0x${string}` | null {
 const a = Bun.env.VAULT_ADDRESS;
 if (!a || a === "mock") return null;
 if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
 return a as `0x${string}`;
}
