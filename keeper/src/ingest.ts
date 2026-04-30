// POST /ingest/signal helper. Backend route is at ~/alp/backend/src/routes/
// ingest.ts and accepts only `{ text, ts? }` — structured payloads aren't
// part of the wire contract, so we flatten Decision into a one-line text
// summary that Sherpa can quote.
//
// Auth: Authorization: Bearer <INGEST_SECRET>, shared with backend .env.

import { env } from "./env";
import type { Decision } from "./policies/types";

export interface IngestResult {
  ok: boolean;
  id?: string;
  status: number;
  error?: string;
}

export async function signal(text: string, ts?: string): Promise<IngestResult> {
  const url = `${env.BACKEND_INGEST_URL.replace(/\/+$/, "")}/ingest/signal`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.INGEST_SECRET}`,
      },
      body: JSON.stringify(ts ? { text, ts } : { text }),
    });
    const status = res.status;
    if (!res.ok) {
      const body = await safeText(res);
      return { ok: false, status, error: body };
    }
    const body = (await res.json()) as { id?: string };
    return { ok: true, status, id: body.id };
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
