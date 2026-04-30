// Idle-reserve policy. Real-signal narrating-only stub: every tick we read
// vault.totalAssets() and sum poolValueExternal across active pools to
// compute the idle ratio. The policy never actuates in v1 — it emits a
// thought Decision describing whether the reserve sits below a "deploy"
// threshold or above a "refill" threshold.
//
// Why narrate-only: actuating deploy_idle / refill_idle requires deciding
// *which* pool to top up, which needs cross-pool USD valuation we don't
// have for non-USDC sides yet. v2 unlocks this. v1 surfaces the reasoning
// to Sherpa so the user sees the brain considered it.

import { erc20BalanceAbi } from "../abi";
import { publicClient } from "../chain";
import { env } from "../env";
import { readPoolValueExternal, readTotalAssets, type TrackedPool } from "../vault";
import type { Candidate } from "./types";

const DEPLOY_THRESHOLD_BPS = 2000; // idle > 20% of TAV → would deploy in v2.
const REFILL_THRESHOLD_BPS = 200;  // idle <  2% of TAV → would refill in v2.

const USDC_BASE: `0x${string}` = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export async function run(pools: readonly TrackedPool[]): Promise<Candidate[]> {
  // The vault's base asset is USDC; idle = USDC.balanceOf(vault).
  // poolValueExternal(key) is denominated in vault asset units (USDC raw).
  // totalAssets() == idleUsdc + sum(poolValueExternal). So we can derive
  // either from the other; we read totalAssets for the headline number and
  // USDC balance directly for the idle figure (cheaper than summing).
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
        reasoning: "idle policy: TAV is zero (vault unfunded); nothing to deploy.",
        policy: "idle",
      },
    }];
  }

  const idleBps = Number((idle * 10000n) / totalAssets);
  const deployedBps = Number((poolSum * 10000n) / totalAssets);

  // Sanity reconciliation: idle + deployed should sum to roughly 100%.
  // Tolerance is loose on tiny TAV (rounding noise dominates a few-USDC
  // dev vault) and strict on real-money TAV. Below 100 USDC TAV → 30pp
  // tolerance; otherwise 5pp. When the divergence is real (broken
  // poolValueExternal or missing cross-pool pricing), we degrade to
  // qualitative reasoning rather than narrating fabricated shares.
  const reconciled = idleBps + deployedBps;
  const tinyTav = totalAssets < 100_000_000n; // < 100 USDC
  const tolPp = tinyTav ? 30 : 5;
  if (reconciled < 10000 - tolPp * 100 || reconciled > 10000 + tolPp * 100) {
    return [{
      priority: 50,
      decision: {
        action: "thought",
        reasoning: `idle (qualitative): ${formatUsdc(idle)} USDC sitting in vault; on-chain poolValueExternal sum = ${formatUsdc(poolSum)} (reconciliation off by ${Math.abs(reconciled - 10000) / 100}pp from TAV ${formatUsdc(totalAssets)}). Skipping precise % share until adapter pricing is reliable.`,
        policy: "idle",
      },
    }];
  }

  let verdict: string;
  if (idleBps > DEPLOY_THRESHOLD_BPS) {
    verdict = `above ${DEPLOY_THRESHOLD_BPS / 100}% deploy threshold — would top up the pool with the most cap headroom (deferred to v2 actuator).`;
  } else if (idleBps < REFILL_THRESHOLD_BPS) {
    verdict = `below ${REFILL_THRESHOLD_BPS / 100}% refill threshold — would skim the most overweight pool (deferred to v2 actuator).`;
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
  // USDC has 6 decimals on Base.
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
  return `${whole.toString()}.${frac}`;
}
