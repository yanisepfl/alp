// Viem clients shared by every read/write path. Booted once and reused.
//
// Read path: PublicClient over BASE_RPC_URL.
// Write path: WalletClient signing with AGENT_PRIVATE_KEY (the prefunded
// hot wallet that owns vault.agent()).

import { createPublicClient, createWalletClient, fallback, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { env } from "./env";

// We deliberately do not annotate with `: PublicClient` / `: WalletClient`.
// Base's chain definition includes OP-stack-specific types (deposit txs)
// that don't match the generic-client return type, which surfaces as a
// "two different types with this name exist" tsc error when the alias is
// re-applied. Letting viem infer the concrete type keeps things consistent.
//
// Transport layering (Fix A): when BASE_RPC_URL_FALLBACK is set, primary
// is Alchemy (single dedicated endpoint, no LB-routing staleness across
// consecutive eth_call/getBalance/etc.) and drpc is the fallback. Without
// fallback, just use the primary. State-at-block reads we issue from
// the executor are also pinned via simulateAtBlock (Fix B), so even if
// fallback ever kicks in we read at a deterministic block.
const transport = env.BASE_RPC_URL_FALLBACK
  ? fallback([http(env.BASE_RPC_URL), http(env.BASE_RPC_URL_FALLBACK)])
  : http(env.BASE_RPC_URL);

export const account = privateKeyToAccount(env.AGENT_PRIVATE_KEY as `0x${string}`);

export const publicClient = createPublicClient({
  chain: base,
  transport,
});

export const walletClient = createWalletClient({
  chain: base,
  transport,
  account,
});

// Constants reused across modules. The V4 PositionManager / PoolManager and
// V3 Factory addresses are the canonical Base mainnet deployments — same
// values Yanis uses in ~/alp/agent/src/monitor.ts, hoisted here so they
// aren't redeclared per-module.
export const V3_FACTORY: `0x${string}` = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
export const V3_NPM: `0x${string}` = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";
export const V4_POSITION_MANAGER: `0x${string}` = "0x7C5f5A4bBd8fD63184577525326123B519429bDc";
export const V4_POOL_MANAGER: `0x${string}` = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
// Storage slot index of the V4 PoolManager `pools` mapping. Cross-checked
// with v4-core StateLibrary; see ~/alp/agent/src/monitor.ts L11.
export const V4_POOLS_SLOT = 6n;
