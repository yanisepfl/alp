import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { env } from "./env";

const transport = http(env.BASE_RPC_URL);

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

// Canonical Base-mainnet deployment addresses for V3 + V4 contracts the
// keeper reads from. The V4 PoolManager `pools` mapping lives at slot 6.
export const V3_FACTORY: `0x${string}` = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
export const V3_NPM: `0x${string}` = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";
export const V4_POSITION_MANAGER: `0x${string}` = "0x7C5f5A4bBd8fD63184577525326123B519429bDc";
export const V4_POOL_MANAGER: `0x${string}` = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
export const V4_POOLS_SLOT = 6n;
