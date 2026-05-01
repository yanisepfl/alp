// POST /ingest/signal helper. Backend route accepts { text, ts?, sources? };
// sources let the frontend group the keeper's narrated entry with the
// indexer's auto-generated kind:"action" entries on the same tx hash.
//
// Auth: Authorization: Bearer <INGEST_SECRET>, shared with backend .env.

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
  const url = `${env.BACKEND_INGEST_URL.replace(/\/+$/, "")}/ingest/signal`;
  const body: { text: string; ts?: string; sources?: WireSource[] } = { text };
  if (opts.ts !== undefined) body.ts = opts.ts;
  if (opts.sources !== undefined && opts.sources.length > 0) body.sources = opts.sources;
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
    return { ok: true, status, id: respBody.id };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

export function decisionToSignalText(d: Decision): string {
  // Compact one-liner: policy → action → pool → reasoning. Sherpa quotes
  // these verbatim, so keep it human-readable.
  const head = d.action === "thought"
    ? `[${d.policy}] thought`
    : d.action === "hold"
      ? `[${d.policy}] hold`
      : `[${d.policy}] ${d.action.toUpperCase()}`;
  return `${head}: ${d.reasoning}`;
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}
