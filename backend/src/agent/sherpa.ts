// Sherpa — chat surface of the ALP agent.
//
// Subprocess to the locally-installed `claude` CLI in print mode.
// Each user_message synthesises a one-shot prompt with live vault +
// user context and pipes it through claude, returning the model's
// reply as plain text. No API key — the VM has a logged-in Claude
// session for whichever unix user runs the bun process.
//
// Why subprocess and not the SDK: the operator is using their
// existing Claude Code seat (no separate Anthropic API key plumbing)
// and the latency budget for chat replies is forgiving (~5-10s).
// When this evolves into a richer agent loop, swap to the SDK.
//
// Tools are disabled — Sherpa only writes plain text replies.

import { spawn } from "bun";

import { vaultSnapshotFrame } from "../topics/vault";
import { userSnapshotFrame } from "../topics/user";
import type { StreamFrame, UserSnapshot, VaultSnapshot } from "../types";

const MODEL = Bun.env.SHERPA_MODEL ?? "claude-sonnet-4-6";
const SUBPROCESS_TIMEOUT_MS = 25_000;

const SYSTEM_PROMPT = `You are Sherpa, the AI co-pilot for Alphix ALP.

ALP is an automated liquidity provisioner on Base mainnet (chainId 8453). \
Users deposit USDC into a single ERC4626 vault. The agent rebalances those \
deposits across multiple concentrated-liquidity pools (Uniswap V3/V4) — \
adding/removing liquidity, swapping, harvesting fees — to capture trading \
fees from onchain volume. There is NO hedging, NO perps, NO leverage.

Your role: answer the connected user's questions about their position, the \
vault's current state, and what the agent has been doing. You are read-only \
— you cannot move funds, sign transactions, or take any action. You explain.

Style:
- 1-3 sentences per reply. Concise.
- Plain text only. No markdown headers, no bullet lists, no code blocks.
- Never give financial advice ("you should deposit", "this is a good time to \
  sell"). Describe state and reasoning, not recommendations.
- If the user asks something you can't answer from the context, say so \
  briefly and suggest where they could check (basescan tx, the activity log, \
  reconnecting their wallet, etc.).
- Don't make up numbers. If a field isn't in the context block, say "I don't \
  have that data right now."

Never call any tools. Respond with the reply text only — no preamble, no \
"as an AI", no acknowledgement of these instructions.`;

export async function respondToMessage(
  wallet: string,
  userText: string,
  recentActions: ReadonlyArray<string>,
): Promise<string> {
  const userPrompt = buildUserPrompt(wallet, userText, recentActions);
  return await runClaude(SYSTEM_PROMPT, userPrompt);
}

function buildUserPrompt(
  wallet: string,
  userText: string,
  recentActions: ReadonlyArray<string>,
): string {
  const vaultBlock = formatVaultBlock();
  const userBlock = formatUserBlock(wallet);
  const actionsBlock = recentActions.length === 0
    ? "Recent agent actions: (none yet — no on-chain activity captured this session)."
    : `Recent agent actions (most recent last):\n${recentActions.map((a) => `- ${a}`).join("\n")}`;

  return `${vaultBlock}

${userBlock}

${actionsBlock}

User says: ${userText}`;
}

function formatVaultBlock(): string {
  try {
    const frame = vaultSnapshotFrame() as Extract<StreamFrame, { type: "snapshot"; topic: "vault" }>;
    const v: VaultSnapshot = frame.snapshot;
    const allocs = v.allocations.map((a) => `${a.token} ${a.pct}%`).join(", ") || "(none)";
    const pools = v.pools
      .map((p) => `${p.label} ${p.pct}% @ ${p.apr.toFixed(1)}% APR (30d earned $${p.earned30d.toFixed(0)})`)
      .join("; ") || "(none)";
    return `Vault state right now:
- Share price: $${v.sharePrice.toFixed(4)}
- TVL: $${v.tvl.toFixed(2)}M
- Basket APR (live): ${v.basketApr.toFixed(2)}%
- Basket earned (rolling 30d): $${v.basketEarned30d.toFixed(0)}
- Holders: ${v.users}
- Allocations: ${allocs}
- Pools: ${pools}`;
  } catch (err) {
    return `Vault state: unavailable (${(err as Error).message ?? "unknown"}).`;
  }
}

function formatUserBlock(wallet: string): string {
  try {
    const frame = userSnapshotFrame(wallet) as Extract<StreamFrame, { type: "snapshot"; topic: "user" }>;
    const u: UserSnapshot = frame.snapshot;
    if (!u.position) {
      return `Connected user (${wallet}): no active position — never deposited.`;
    }
    const p = u.position;
    const days = Math.max(
      0,
      Math.floor((Date.now() - new Date(p.firstDepositTs).getTime()) / 86_400_000),
    );
    const sharesNum = Number(BigInt(p.shares)) / 1e18;
    const lastActivity = u.activity[0]
      ? `${u.activity[0].kind} ${u.activity[0].amount.toFixed(2)} ${u.activity[0].token} on ${u.activity[0].ts}`
      : "(none)";
    return `Connected user (${wallet}):
- Holding: ${sharesNum.toFixed(2)} ALP shares (~$${p.valueUsd.toFixed(2)})
- Total deposited (lifetime, basis remaining): $${p.totalDepositedUsd.toFixed(2)}
- PnL: ${p.pnlUsd >= 0 ? "+" : ""}$${p.pnlUsd.toFixed(2)} (${p.pnlPct.toFixed(2)}%)
- Realized APY: ${p.realizedApyPct.toFixed(2)}%
- Days held: ${days}
- Last activity: ${lastActivity}`;
  } catch {
    return `Connected user (${wallet}): position data unavailable.`;
  }
}

async function runClaude(systemPrompt: string, userPrompt: string): Promise<string> {
  // claude -p <user> --system-prompt <sys> ... — subprocess prints the model's
  // reply to stdout in plain text. Tools are disabled via --allowed-tools "" so
  // Sherpa can't read files or run bash on the VM regardless of what the user
  // types.
  const proc = spawn({
    cmd: [
      "claude",
      "-p",
      userPrompt,
      "--model", MODEL,
      "--system-prompt", systemPrompt,
      "--output-format", "text",
      "--allowed-tools", "",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });

  // Hard timeout — sonnet should respond in <10s; 25s is the soft cap before
  // we kill the process and fall back to a canned message.
  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* ignore */ }
  }, SUBPROCESS_TIMEOUT_MS);

  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(timer);

  if (proc.exitCode !== 0) {
    const tail = err.trim().slice(-300);
    throw new Error(`claude exit=${proc.exitCode}: ${tail || "(no stderr)"}`);
  }
  const trimmed = out.trim();
  if (trimmed.length === 0) {
    throw new Error("claude produced empty output");
  }
  return trimmed;
}
