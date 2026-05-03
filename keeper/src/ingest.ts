import { pushRecentRingText } from "./db";
import { env } from "./env";
import type { Decision } from "./policies/types";

export type WireSource =
  | { kind: "vault";    label: string; tx: string }
  | { kind: "basescan"; label: string; tx: string }
  | { kind: "uniswap";  label: string; url: string };

export interface IngestResult {
  ok: boolean;
  id?: string;
  status: number;
  error?: string;
}

export interface SignalOpts {
  ts?: string;
  sources?: WireSource[];
}

export async function signal(text: string, opts: SignalOpts = {}): Promise<IngestResult> {
  return await postIngest("signal", text, opts);
}

/** Emit a "thought" — agent's own reasoning sentence. The FE renders
 *  this as a left-bordered italic quote, distinct from "New context"
 *  signals. Use signal() for plain context (deposit headers, kh-event,
 *  etc.) and thought() for first-person reasoning the agent itself
 *  wrote (rollup distillation, deposit reaction, etc.). */
export async function thought(text: string, opts: { ts?: string } = {}): Promise<IngestResult> {
  return await postIngest("thought", text, { ts: opts.ts });
}

async function postIngest(
  path: "signal" | "thought",
  text: string,
  opts: SignalOpts,
): Promise<IngestResult> {
  const url = `${env.BACKEND_INGEST_URL.replace(/\/+$/, "")}/ingest/${path}`;
  const body: { text: string; ts?: string; sources?: WireSource[] } = { text };
  if (opts.ts !== undefined) body.ts = opts.ts;
  if (path === "signal" && opts.sources !== undefined && opts.sources.length > 0) {
    body.sources = opts.sources;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.INGEST_SECRET}`,
      },
      body: JSON.stringify(body),
    });
    const status = res.status;
    if (!res.ok) {
      const errBody = await safeText(res);
      return { ok: false, status, error: errBody };
    }
    const respBody = (await res.json()) as { id?: string };
    pushRecentRingText(text);
    return { ok: true, status, id: respBody.id };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export function decisionToSignalText(d: Decision): string {
  // Compact one-liner: policy + action + reasoning. Used as Claude
  // prompt context, not as a user-facing feed entry — so no brackets,
  // no log-style prefixes; keep it as plain prose Claude can read
  // without echoing the format back.
  const head = d.action === "thought"
    ? `${d.policy} policy observed`
    : d.action === "hold"
      ? `${d.policy} policy held`
      : `${d.policy} policy chose ${d.action}`;
  return `${head}: ${d.reasoning}`;
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}
