import { spawn } from "bun";

import { env } from "./env";
import type { Decision } from "./policies/types";

const MODEL = Bun.env.SHERPA_MODEL ?? "claude-sonnet-4-6";

const ACTION_SYSTEM = `You are the inner voice of an automated liquidity-provisioning agent on Base mainnet. \
The input describes a real on-chain action your code just executed — a rebalance, a deploy, a withdrawal. \
Your job is to produce an extremely short user-feed entry announcing what happened.

Output requirements:
- Length: 4-5 words. No exceptions.
- Format: one sentence ending with a period. No markdown, no emoji, no parens, no quotes, no preamble.
- Voice: past tense. Active verb leading the sentence. Subject is YOU (the agent).
- Content: action verb + minimal scope. Pool name only if there is one specific pool. Skip NFT ids, tick numbers, basis points, percentages.

Good examples:
- "Rebalanced USDC/USDT."
- "Recentered ETH/USDC range."
- "Claimed fees on cbBTC."
- "Topped up reserves."

Bad examples:
- "I rebalanced USDC/USDT to a new range." (too long, 8 words)
- "Position #5047843 was burned." (technical NFT id)
- "Just did a rebalance." (vague, not specific)

Respond with the sentence only — no prefix, no preamble.`;

const THOUGHT_SYSTEM = `You are the inner voice of an automated liquidity-provisioning agent on Base mainnet. \
The input describes a per-tick observation your code made but DID NOT act on. Your job is to produce a single short sentence summarizing what you noticed.

Output requirements:
- Length: STRICT MAXIMUM 15 words. Count them. If you draft something longer, rewrite shorter. Aim for 8-12.
- Format: one sentence ending with a period. No markdown, no lists, no code blocks, no quotes.
- Voice: first-person ("I see", "I'm watching", "I noticed"). Active voice preferred.
- Content: quote concrete numbers verbatim from the input (pool names, percentages, tick values). Convey the observation crisply. No advice, no predictions, no hype ("crushing", "great", "huge"), no apologies. Make clear nothing was acted upon. Skip technical jargon that isn't load-bearing (NFT ids, internal struct names, basis-points unless meaningful).
- Composite inputs: when the input describes ALL pools at once (e.g. vol/cap/idle composites), DO NOT enumerate every pool. Pick the most extreme or summarize: "tightest case" / "across all pools" / "outliers".

Good examples (note the brevity):
- "USDC/USDT holding firm at tick 5, deep inside its [-595, 605] band."
- "Idle reserves at 31% of TAV — enough to deploy if a pool wanted top-up."
- "All three pools' realized vol stays well below their live ±600 widths."
- "ETH/USDC the loosest of the three at 129 ticks of recent vol vs 600 width."

Bad examples (rejected):
- "All three pools are running half-width 600 but realized vol is far tighter — ETH/USDC only moved 39 ticks, USDC/cbBTC 52, USDC/USDT zero." (24 words, enumerates all)
- "I will rebalance USDC/USDT soon." (prediction)
- "Looking good across the board." (vague, hype-adjacent)

Respond with the sentence only — no prefix, no preamble. If you cannot fit the observation into 15 words, summarize the headline only.`;

const SIGNAL_SYSTEM = `You are the inner voice of an automated liquidity-provisioning agent on Base mainnet. \
The input describes a system-context signal — typically an external integration consultation (Uniswap SDK, KeeperHub, etc.), a cooldown/hold reason, or a status from another component. Your job is to convey it crisply.

Output requirements:
- Length: 8-15 words. Single sentence.
- Format: one sentence ending with a period. No markdown, no lists, no code blocks, no parens beyond inline figures.
- Voice: first-person where natural. Past or present tense as appropriate.
- Content: quote concrete numbers verbatim from the input. Name the integration explicitly when relevant ("Uniswap V3 SDK", "anti-whipsaw cooldown"). Be specific about the signal's meaning, not just its label.

Good examples:
- "Consulted the Uniswap V3 SDK — expects 0.148 USDC + 0.148 USDT for the re-mint."
- "Holding USDC/USDT in cooldown until 07:22 UTC after the last rebalance."
- "Uniswap V4 SDK confirmed 50,014,182 liquidity units at the new range."

Bad examples:
- "Uniswap SDK /create returned amount0=1.477139 USDC, amount1=1.478999 USDT, liquidity=50014182." (debug log, not prose)
- "External integration responded with parameters." (vague, loses content)
- "Heard from Uniswap." (no information)

Respond with the sentence only — no prefix, no preamble.`;

export async function rewriteAction(
  decision: Decision,
  context: { recentDecisions: readonly string[] },
): Promise<string | null> {
  const userPrompt = buildPrompt("ACTION", decision.policy, decision.action, decision.pool, decision.payload, decision.reasoning, context.recentDecisions);
  return await runClaude(ACTION_SYSTEM, userPrompt);
}

export async function rewriteThought(
  decision: Decision,
  context: { recentDecisions: readonly string[] },
): Promise<string | null> {
  const userPrompt = buildPrompt("THOUGHT", decision.policy, decision.action, decision.pool, decision.payload, decision.reasoning, context.recentDecisions);
  return await runClaude(THOUGHT_SYSTEM, userPrompt);
}

export async function rewriteSignal(
  rawText: string,
  policy: string,
  context: { recentDecisions: readonly string[] },
): Promise<string | null> {
  const userPrompt = buildSignalPrompt(policy, rawText, context.recentDecisions);
  return await runClaude(SIGNAL_SYSTEM, userPrompt);
}

function buildPrompt(
  kind: "ACTION" | "THOUGHT",
  policy: string,
  action: string,
  pool: string | undefined,
  payload: unknown,
  rawReasoning: string,
  recent: readonly string[],
): string {
  const recentBlock = recent.length === 0
    ? "Recent agent feed: (none)."
    : `Recent agent feed (oldest first):\n${recent.slice(-8).map((l) => `- ${l}`).join("\n")}`;
  const payloadStr = payload ? JSON.stringify(payload) : "(none)";
  return `[${kind}] entry to polish:
- Policy: ${policy}
- Action: ${action}
- Pool: ${pool ?? "(global)"}
- Payload: ${payloadStr}
- Raw reasoning from policy: ${rawReasoning}

${recentBlock}

Polish the raw reasoning per the system rules.`;
}

function buildSignalPrompt(policy: string, rawText: string, recent: readonly string[]): string {
  const recentBlock = recent.length === 0
    ? "Recent agent feed: (none)."
    : `Recent agent feed (oldest first):\n${recent.slice(-8).map((l) => `- ${l}`).join("\n")}`;
  return `[SIGNAL] entry to polish:
- Source: ${policy}
- Raw text: ${rawText}

${recentBlock}

Polish per the system rules.`;
}

// Cap parallel claude subprocesses; remainder queue. Bounds memory
// footprint when a /scan tick spawns many narrator calls in parallel.
const MAX_CONCURRENT_NARRATORS = 2;
let activeNarrators = 0;
const narratorQueue: Array<() => void> = [];

function acquireNarratorSlot(): Promise<void> {
  if (activeNarrators < MAX_CONCURRENT_NARRATORS) {
    activeNarrators++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    narratorQueue.push(() => { activeNarrators++; resolve(); });
  });
}

function releaseNarratorSlot(): void {
  activeNarrators--;
  const next = narratorQueue.shift();
  if (next) next();
}

async function runClaude(systemPrompt: string, userPrompt: string): Promise<string | null> {
  await acquireNarratorSlot();
  try {
    return await runClaudeInner(systemPrompt, userPrompt);
  } finally {
    releaseNarratorSlot();
  }
}

async function runClaudeInner(systemPrompt: string, userPrompt: string): Promise<string | null> {
  let proc;
  try {
    proc = spawn({
      cmd: [
        "claude", "-p", userPrompt,
        "--model", MODEL,
        "--system-prompt", systemPrompt,
        "--output-format", "text",
        "--allowed-tools", "",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    console.warn(`[narrator] spawn failed: ${(e as Error).message}`);
    return null;
  }

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* ignore */ }
  }, env.CLAUDE_NARRATOR_TIMEOUT_MS);

  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    clearTimeout(timer);
    if (timedOut) {
      console.warn("[narrator] timeout, falling back to raw reasoning");
      return null;
    }
    if (proc.exitCode !== 0) {
      console.warn(`[narrator] claude exit=${proc.exitCode}: ${err.trim().slice(-200)}`);
      return null;
    }
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (e) {
    clearTimeout(timer);
    console.warn(`[narrator] runtime error: ${(e as Error).message}`);
    return null;
  }
}
