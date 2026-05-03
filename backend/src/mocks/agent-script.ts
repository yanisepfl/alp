// Scripted agent feed seam. primingHistory() currently returns [] — the
// agent feed is populated entirely by chain action events
// (topics/agent.ts:startAgentActionBridge), Sherpa replies, and external
// narration POSTed into /ingest/{signal,reply}. Retained as the splice
// point if scripted seeding is ever wanted again.

import type { WireMessage } from "../types";

export function primingHistory(): WireMessage[] {
  return [];
}
