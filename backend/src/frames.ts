// Frame parse / encode. Encoding is just JSON — kept here so future versioning
// work has a single seam. Parsing distinguishes:
//   - returns ClientFrame on a valid v=1 frame of a known type
//   - returns null on v !== 1 (server drops silently per CONTRACT.md §7)
//   - throws BadFrameError on malformed JSON / unknown shape (caller emits an
//     `error` frame with code "bad_frame", connection stays open)

import type { ClientFrame, StreamFrame } from "./types";

export class BadFrameError extends Error {
  constructor(public reason: string) { super(reason); }
}

export function parseClientFrame(raw: string): ClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadFrameError("malformed json");
  }
  if (!parsed || typeof parsed !== "object") throw new BadFrameError("not an object");
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) return null;
  if (typeof obj.type !== "string") throw new BadFrameError("missing type");
  if (obj.type !== "subscribe" && obj.type !== "user_message" && obj.type !== "unsubscribe") {
    throw new BadFrameError(`unknown frame type: ${obj.type}`);
  }
  return obj as unknown as ClientFrame;
}

export function encode(frame: StreamFrame): string {
  return JSON.stringify(frame);
}

// Compact one-line summary used by the DEBUG_FRAMES log.
export function summarize(frame: StreamFrame | ClientFrame): string {
  switch (frame.type) {
    case "ack":
      return `type=ack subscribed=[${frame.subscribed.join(",")}]${frame.rejected ? ` rejected=[${frame.rejected.map(r => `${r.topic}:${r.reason}`).join(",")}]` : ""}`;
    case "ping":      return `type=ping`;
    case "error":     return `type=error code=${frame.code}`;
    case "history":   return `type=history topic=agent n=${frame.events.length}${frame.cursor ? ` cursor=${frame.cursor}` : ""}`;
    case "event":     return `type=event topic=agent kind=${frame.event.kind} id=${frame.event.id}`;
    case "snapshot":  return `type=snapshot topic=${frame.topic}`;
    case "tick":      return `type=tick topic=vault keys=[${Object.keys(frame.tick).filter(k => k !== "ts").join(",")}]`;
    case "subscribe": return `type=subscribe topics=[${(frame.topics ?? ["agent"]).join(",")}]${frame.auth ? " auth=<set>" : ""}${frame.since?.agent ? ` since.agent=${frame.since.agent}` : ""}`;
    case "user_message": return `type=user_message clientId=${frame.clientId} text="${frame.text.slice(0, 32)}${frame.text.length > 32 ? "…" : ""}"`;
    case "unsubscribe":  return `type=unsubscribe topics=[${frame.topics.join(",")}]`;
  }
}
