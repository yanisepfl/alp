// Claude narrator. Mirrors the backend's Sherpa subprocess pattern from
// ~/alp/backend/src/agent/sherpa.ts: spawn `claude -p` with no tools, pipe
// the raw policy reasoning + tick context, capture stdout, return the
// polished text. Hard timeout via setTimeout + proc.kill so a stuck
// subprocess never blocks /scan responses.
//
// Phase 2b wires this up so /scan first POSTs the raw decision to /ingest/
// signal (immediate), then fires this in the background and POSTs the
// polished version on success. /scan does NOT await this.

import { spawn } from "bun";

import { env } from "./env";
import type { Decision } from "./policies/types";

const MODEL = Bun.env.SHERPA_MODEL ?? "claude-sonnet-4-6";

const NARRATOR_SYSTEM = `You are the inner voice of an automated liquidity \
provisioner agent on Base mainnet. You polish a single raw policy decision \
into one or two sentences of plain text suitable for showing to a non-technical \
user in a chat feed.

Style:
- 1-2 sentences. No more. No markdown, no bullets, no headers, no code blocks.
- Speak in first person ("I noticed", "I'm holding off") — you ARE the agent.
- Quote the live numbers from the input verbatim. Don't round, don't reword.
- No advice. No predictions. No hype words ("crushing", "great", "huge").
- If the input describes a "thought" (no action taken), the polished output \
  must also clearly state nothing was done.

Respond with the polished sentence(s) only — no preamble, no acknowledgement.`;

export async function rewrite(
  decision: Decision,
  context: { recentDecisions: readonly string[] },
): Promise<string | null> {
  const userPrompt = buildPrompt(decision, context.recentDecisions);
  return await runClaude(NARRATOR_SYSTEM, userPrompt);
}

function buildPrompt(decision: Decision, recent: readonly string[]): string {
  const recentBlock = recent.length === 0
    ? "Recent agent feed: (none)."
    : `Recent agent feed (oldest first):\n${recent.map((l) => `- ${l}`).join("\n")}`;
  const payload = decision.payload ? JSON.stringify(decision.payload) : "(none)";
  return `Raw policy decision:
- Policy: ${decision.policy}
- Action: ${decision.action}
- Pool: ${decision.pool ?? "(global)"}
- Payload: ${payload}
- Raw reasoning: ${decision.reasoning}

${recentBlock}

Polish the raw reasoning into a 1-2 sentence first-person feed entry.`;
}

async function runClaude(systemPrompt: string, userPrompt: string): Promise<string | null> {
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
