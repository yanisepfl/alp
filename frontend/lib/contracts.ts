// Onchain addresses + ABI fragments the frontend writes against.
// Reads come from the backend's user.snapshot push, so we don't keep a
// parallel chain-read layer here. The fragments below are the minimum
// ABI needed for the deposit/redeem write path plus the allowance +
// balance reads that gate the deposit two-step flow.

import { erc20Abi } from "viem";

// Base mainnet (chainId 8453). Bridge-issued USDC at the standard
// circle.com address.
export const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

// Required at boot — fail fast like NEXT_PUBLIC_REOWN_PROJECT_ID
// (lib/wagmi.ts) so misconfiguration surfaces at module-import
// time rather than in the deposit handler.
const _vaultAddress = process.env.NEXT_PUBLIC_VAULT_ADDRESS;
if (!_vaultAddress) {
 throw new Error(
 "NEXT_PUBLIC_VAULT_ADDRESS is not set. Add it to .env.local — must match the backend's VAULT_ADDRESS env (the deployed ALPVault on Base mainnet).",
 );
}
if (!/^0x[0-9a-fA-F]{40}$/.test(_vaultAddress)) {
 throw new Error(`NEXT_PUBLIC_VAULT_ADDRESS is not a valid 0x-prefixed 42-char address: ${_vaultAddress}`);
}
export const VAULT_ADDRESS = _vaultAddress as `0x${string}`;

// USDC: re-export viem's stock ERC20 ABI. We use it for `balanceOf`,
// `allowance`, and `approve` against the USDC contract.
export const usdcAbi = erc20Abi;

// ALPVault: ERC4626 surface. Hand-rolled because we don't have the
// upstream ABI. Only the methods we actually call are listed; viem's
// type inference picks up the literal const tuple shape.
export const vaultAbi = [
 {
 type: "function",
 name: "deposit",
 stateMutability: "nonpayable",
 inputs: [
 { name: "assets", type: "uint256" },
 { name: "receiver", type: "address" },
 ],
 outputs: [{ name: "shares", type: "uint256" }],
 },
 {
 type: "function",
 name: "redeem",
 stateMutability: "nonpayable",
 inputs: [
 { name: "shares", type: "uint256" },
 { name: "receiver", type: "address" },
 { name: "owner", type: "address" },
 ],
 outputs: [{ name: "assets", type: "uint256" }],
 },
 {
 type: "function",
 name: "convertToShares",
 stateMutability: "view",
 inputs: [{ name: "assets", type: "uint256" }],
 outputs: [{ name: "", type: "uint256" }],
 },
 {
 type: "function",
 name: "convertToAssets",
 stateMutability: "view",
 inputs: [{ name: "shares", type: "uint256" }],
 outputs: [{ name: "", type: "uint256" }],
 },
] as const;

// Token decimal scales — referenced by the deposit/withdraw input
// parsers. USDC is 6 decimals. ALP vault overrides ERC4626
// `_decimalsOffset()` to 6, so its share token is 12 decimals
// (asset 6 + offset 6). Must match `SHARE_DECIMALS` in
// backend/src/chain.ts.
export const USDC_DECIMALS = 6;
export const ALP_DECIMALS = 12;
