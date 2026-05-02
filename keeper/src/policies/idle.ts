import { erc20BalanceAbi } from "../abi";
import { publicClient } from "../chain";
import { env } from "../env";
import { readPoolValueExternal, readTotalAssets, type TrackedPool } from "../vault";
import type { Candidate } from "./types";

const DEPLOY_THRESHOLD_BPS = 2000;
const REFILL_THRESHOLD_BPS = 200;

const USDC_BASE: `0x${string}` = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export async function run(pools: readonly TrackedPool[]): Promise<Candidate[]> {
  let totalAssets = 0n;
  let idle = 0n;
  let poolSum = 0n;
  try {
    [totalAssets, idle] = await Promise.all([
      readTotalAssets(),
      publicClient.readContract({
        address: USDC_BASE,
        abi: erc20BalanceAbi,
        functionName: "balanceOf",
        args: [env.VAULT_ADDRESS as `0x${string}`],
      }) as Promise<bigint>,
    ]);
    for (const p of pools) {
      poolSum += await readPoolValueExternal(p.lpKey);
    }
  } catch (e) {
    return [{
      priority: 10,
      decision: {
        action: "thought",
        reasoning: `idle policy: read failed (${(e as Error).message}); skipping this tick.`,
        policy: "idle",
      },
    }];
  }

  if (totalAssets === 0n) {
    return [{
      priority: 10,
      decision: {
        action: "thought",
        reasoning: "idle policy: TAV is zero; nothing to deploy.",
        policy: "idle",
      },
    }];
  }

  const idleBps = Number((idle * 10000n) / totalAssets);
  const deployedBps = Number((poolSum * 10000n) / totalAssets);

  // Reconciliation tolerance — wide on dev-scale TAV where rounding
  // dominates, tight on real-money TAV.
  const reconciled = idleBps + deployedBps;
  const tinyTav = totalAssets < 100_000_000n;
  const tolPp = tinyTav ? 30 : 5;
  if (reconciled < 10000 - tolPp * 100 || reconciled > 10000 + tolPp * 100) {
    return [{
      priority: 50,
      decision: {
        action: "thought",
        reasoning: `idle (qualitative): ${formatUsdc(idle)} USDC sitting in vault; on-chain poolValueExternal sum = ${formatUsdc(poolSum)} (reconciliation off by ${Math.abs(reconciled - 10000) / 100}pp from TAV ${formatUsdc(totalAssets)}).`,
        policy: "idle",
      },
    }];
  }

  let verdict: string;
  if (idleBps > DEPLOY_THRESHOLD_BPS) {
    verdict = `above ${DEPLOY_THRESHOLD_BPS / 100}% deploy threshold — would top up the pool with the most cap headroom.`;
  } else if (idleBps < REFILL_THRESHOLD_BPS) {
    verdict = `below ${REFILL_THRESHOLD_BPS / 100}% refill threshold — would skim the most overweight pool.`;
  } else {
    verdict = "within deploy/refill band, no action.";
  }

  return [{
    priority: 50,
    decision: {
      action: "thought",
      reasoning: `idle: ${formatUsdc(idle)} USDC reserve = ${(idleBps / 100).toFixed(2)}% of ${formatUsdc(totalAssets)} TAV (deployed ${(deployedBps / 100).toFixed(2)}%). ${verdict}`,
      policy: "idle",
    },
  }];
}

function formatUsdc(raw: bigint): string {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole.toString()}.${frac}`;
}
