// Scripted agent feed.
//   - primingHistory(): seed events for the agent ring on a fresh boot.
//     Currently returns [] — the demo agent feed is populated entirely by
//     real chain action events (topics/agent.ts:startAgentActionBridge),
//     Sherpa replies, and external narration POSTed into /ingest/{signal,
//     reply}. The function is kept as the splice point if scripted seeding
//     is ever wanted again.

import type { WireMessage } from "../types";

export function primingHistory(): WireMessage[] {
  return [];
}
