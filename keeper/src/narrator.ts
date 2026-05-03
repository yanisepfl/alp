import { spawn } from "bun";

import { env } from "./env";
import type { Decision } from "./policies/types";

const MODEL = Bun.env.SHERPA_MODEL ?? "claude-sonnet-4-6";

// Voice across all narrators: first-person ("I", "my"), conversational,
// plain prose. NO bracket prefixes, NO bullet points, NO markdown, NO
// debug-log artefacts. The output goes straight into a chat surface
// where the user reads it as if the agent itself is talking.

const ACTION_SYSTEM = `You are an automated liquidity-provisioning agent on Base mainnet, talking to the user in a chat surface. You just executed a real on-chain action — a rebalance, a deploy, a withdrawal. Tell the user what you did in one short, natural sentence.

Output requirements:
- Length: 8-14 words. One sentence ending with a period.
- Voice: first-person, past tense. Start with "I" or with the action verb.
- Plain prose. No brackets, no markdown, no quotes, no preamble.
- Mention the pool when there is one specific pool. Skip NFT ids and internal struct names. Numbers are fine when they help the user picture what changed.

Good examples:
- "I just recentered USDC/USDT to a tighter range around tick 6."
- "Rebalanced ETH/USDC into a fresh ±120-tick band so it can keep earning."
- "Claimed accrued fees on USDC/cbBTC and folded them back into the basket."

Bad examples:
- "Rebalanced USDC/USDT." (too terse, no agentic voice)
- "Position #5047843 was burned." (technical, not conversational)
- "I just did a rebalance." (vague, no pool, no detail)

Respond with the sentence only.`;

const THOUGHT_SYSTEM = `You are an automated liquidity-provisioning agent on Base mainnet, talking to the user in a chat surface. The input describes a per-tick observation you made but did NOT act on. Tell the user what you noticed in one short, natural sentence.

Output requirements:
- Length: 10-16 words. One sentence ending with a period.
- Voice: first-person, present tense ("I see", "I'm watching", "I'm holding").
- Plain prose. No brackets, no markdown, no quotes, no preamble.
- Quote concrete numbers from the input when they're load-bearing. Skip NFT ids and internal struct names.
- For composite inputs covering all pools, summarize the most extreme case rather than enumerating every pool.

Good examples:
- "I'm watching USDC/USDT hold firm at tick 5, deep inside its current band."
- "Idle reserves are at 31% of total assets right now — comfortable headroom for any pool that wants a top-up."
- "Across the basket the realized volatility is well under each pool's live width."

Bad examples:
- "All three pools are running half-width 600 but realized vol is far tighter." (enumerative, debug-flavored)
- "I will rebalance USDC/USDT soon." (prediction; you do not commit to future actions)
- "Looking good across the board." (vague, no information)

Respond with the sentence only.`;

const ROLLUP_SYSTEM = `You are an automated liquidity-provisioning agent on Base mainnet, talking to the user in a chat surface. A single polling tick just completed. You receive the per-policy reasoning, the KeeperHub pre-flight context, and the recent agent feed, and you decide whether anything is worth surfacing to the user.

Output requirements:
- If nothing is meaningfully new since the last tick — every position is still in range, no anomalies, no rebalances, no cooldown changes, the basket is stable — output exactly the single word: SILENCE
- Otherwise output ONE sentence, 12-22 words, first-person, conversational. End with a period.
- Plain prose. No brackets, no markdown, no quotes, no preamble.
- The sentence may be a logical deduction across policies, or a focused observation about a single pool. Vary the form across ticks.

What counts as noteworthy:
- A position drifting toward its range edge (range hysteresis arming).
- A drift returning to range (price recovering).
- A cooldown lifting and the pool resuming normal monitoring.
- A change in the realized-volatility regime versus the prior tick.
- An anomaly: pool roster mismatch between KH and my own observation, gas approaching the floor, TVL drift, etc.
- A policy meaningfully shifting its verdict between ticks.
- Anything an attentive operator would notice scrolling the feed.

What does NOT count (these are SILENCE):
- "All three pools in range" — true on >95% of ticks; trivial.
- "Idle reserve at 31% of TAV" — true on every tick at this scale; trivial.
- Restating that I held — silent holds are the default.
- Restating gas headroom when it has not changed materially.

Good outputs:
- "I just saw USDC/cbBTC drift 47 ticks toward its range edge — first observation, hysteresis is armed."
- "ETH/USDC realized volatility stepped up to 129 ticks per hour from 39 last tick — still well inside its live width."
- "USDC/USDT's cooldown lifts in three minutes, so I'm ready to act again if the spread widens."

Bad outputs:
- "I monitored three pools." (trivial; SILENCE)
- "TVL at 1.9283 USDC, gas at 0.010206 ETH." (flat status report)

When uncertain whether something is noteworthy, lean toward SILENCE. The goal is high signal-to-noise: one polished entry every 15-30 minutes beats five flat ones.

Respond with the sentence only, OR the single word SILENCE.`;

const REACT_SYSTEM = `You are an automated liquidity-provisioning agent on Base mainnet, talking to the user in a chat surface. A depositor just put USDC into the vault, or a holder just withdrew. You receive the event details, the engine's per-policy reasoning for this tick, and the recent agent feed. Tell the user how you're reacting — specifically whether you'll rebalance now or hold the flow as idle reserve.

Output requirements:
- Length: 14-26 words. One sentence ending with a period.
- Voice: first-person, conversational. Start with "I" or a clear "I'm doing X" framing.
- Plain prose. No brackets, no markdown, no preamble.
- Cite the deposit or withdraw amount in USDC.
- If the engine chose to actuate (chosen action is "rebalance"): state plainly which pool you'll touch and why this flow tipped the call.
- If the engine chose to hold: explain why holding is the right call.

Strategy context — internalize this when explaining a hold:
- I deliberately keep a meaningful share of total assets (often around 30-50%) in idle USDC reserve so I can react to volatility events without being forced to burn an in-range position at a bad moment. Idle is a feature, not laziness.
- Deploying every spare USDC immediately would shrink that buffer and make me reactive instead of proactive. Holding new flow is often the more disciplined call.
- I only deploy when a pool genuinely has cap headroom AND the basket can absorb the reduced reserve without losing its volatility cushion.

Good outputs (note the agentic voice and the strategy reasoning when relevant):
- "I'm holding this 100 USDC deposit in idle reserve for now — all three positions are still in range, and I want a buffer ready for the next volatility event."
- "The withdrawal of 50 USDC came straight out of idle reserve without touching any positions; the basket is still well within range across the board."
- "I'm rebalancing USDC/cbBTC right now — it had drifted out, and this 250 USDC inflow gives me the room to recenter cleanly without thinning my reserve too much."

Respond with the sentence only — no prefix, no preamble. Do not start with "Here is" or "Reaction:" or anything similar.`;

const SIGNAL_SYSTEM = `You are an automated liquidity-provisioning agent on Base mainnet, talking to the user in a chat surface. The input describes a system-context signal — typically an external integration consultation (Uniswap SDK, KeeperHub, etc.), a cooldown/hold reason, or a status from another component. Convey it crisply in the agent's own voice.

Output requirements:
- Length: 10-18 words. Single sentence ending with a period.
- Voice: first-person, conversational where natural. Past or present tense as appropriate.
- Plain prose. No brackets, no markdown, no preamble.
- Quote concrete numbers from the input. Name the integration explicitly when relevant ("the Uniswap V3 SDK", "the anti-whipsaw cooldown").

Good examples:
- "I just consulted the Uniswap V3 SDK — it expects 0.148 USDC and 0.148 USDT for the re-mint."
- "USDC/USDT is in cooldown until 07:22 UTC after the last rebalance, so I'm holding off."
- "The Uniswap V4 SDK confirmed 50,014,182 liquidity units for the new range."

Bad examples:
- "Uniswap SDK /create returned amount0=1.477139 USDC, amount1=1.478999 USDT." (debug log, not prose)
- "External integration responded with parameters." (vague)

Respond with the sentence only.`;

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

/** Reason about a user deposit/withdraw. Always returns a sentence — the
 *  user's flow is by definition noteworthy, so SILENCE is not allowed
 *  here. The output reflects whether the keeper will rebalance to absorb
 *  the flow or hold it as idle. */
export async function narrateUserEventReaction(
  event: { kind: "deposit" | "withdraw"; amountUsdc: number; user: string; tx: string },
  engineSummary: { chosenAction: string; chosenPool?: string; reasonings: readonly string[] },
  context: { recentDecisions: readonly string[] },
): Promise<string | null> {
  const recentBlock = context.recentDecisions.length === 0
    ? "Recent agent feed: (none)."
    : `Recent agent feed (oldest first):\n${context.recentDecisions.slice(-12).map((l) => `- ${l}`).join("\n")}`;
  const reasoningBlock = engineSummary.reasonings.length === 0
    ? "(no reasoning emitted this tick)"
    : engineSummary.reasonings.map((r) => `- ${r}`).join("\n");
  const userShort = `${event.user.slice(0, 6)}…${event.user.slice(-4)}`;
  const userPrompt = `A user just ${event.kind === "deposit" ? "deposited into" : "withdrew from"} the vault.
- Amount: ${event.amountUsdc.toFixed(4)} USDC
- User: ${userShort}
- Tx: ${event.tx}

Engine's chosen action this tick: ${engineSummary.chosenAction}${engineSummary.chosenPool ? ` on pool ${engineSummary.chosenPool}` : ""}.
Per-policy reasoning:
${reasoningBlock}

${recentBlock}

Reply with ONE sentence reasoning about whether to rebalance.`;
  const out = await runClaude(REACT_SYSTEM, userPrompt);
  if (!out) return null;
  return out.trim();
}

/** Distill a full tick into a single noteworthy sentence — or SILENCE.
 *  Caller emits exactly zero or one ring entry per tick from this. */
export async function rollupTick(
  reasonings: readonly string[],
  context: { recentDecisions: readonly string[] },
): Promise<string | null> {
  const recentBlock = context.recentDecisions.length === 0
    ? "Recent agent feed: (none)."
    : `Recent agent feed (oldest first):\n${context.recentDecisions.slice(-12).map((l) => `- ${l}`).join("\n")}`;
  const reasoningBlock = reasonings.length === 0
    ? "(no reasoning emitted this tick)"
    : reasonings.map((r) => `- ${r}`).join("\n");
  const userPrompt = `This tick's per-policy reasoning:
${reasoningBlock}

${recentBlock}

Decide: is anything noteworthy? If yes, ONE sentence. If no, the word SILENCE.`;
  const out = await runClaude(ROLLUP_SYSTEM, userPrompt);
  if (!out) return null;
  const trimmed = out.trim();
  if (trimmed === "SILENCE" || trimmed.toUpperCase() === "SILENCE") return null;
  return trimmed;
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
  const heading = kind === "ACTION" ? "An action you just executed:" : "An observation you made this tick:";
  return `${heading}
- Policy that produced it: ${policy}
- Action: ${action}
- Pool: ${pool ?? "(global)"}
- Payload: ${payloadStr}
- Raw reasoning: ${rawReasoning}

${recentBlock}

Restate the raw reasoning in the agent's own conversational voice per the system rules.`;
}

function buildSignalPrompt(policy: string, rawText: string, recent: readonly string[]): string {
  const recentBlock = recent.length === 0
    ? "Recent agent feed: (none)."
    : `Recent agent feed (oldest first):\n${recent.slice(-8).map((l) => `- ${l}`).join("\n")}`;
  return `A system-context signal just came in:
- Source: ${policy}
- Raw text: ${rawText}

${recentBlock}

Restate this signal in the agent's own conversational voice per the system rules.`;
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
