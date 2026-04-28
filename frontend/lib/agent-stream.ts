// Sherpa chat wire protocol + stream client.
//
// Wire is presentation-free: ISO-8601 timestamps, token symbols,
// tx hashes (no explorer URLs). View layer adapts.
//
// Auth: SIWE on connect → session JWT → first WSS frame is
// `subscribe` with `auth: <jwt>`. Server binds wallet to connection
// and ignores any client-supplied `wallet` field on user messages.

export type TokenSymbol = "USDC" | "ETH" | "BTC" | "USDT" | "UNI";

export type WireChip =
  | { type: "single"; token: TokenSymbol }
  | { type: "pair"; left: TokenSymbol; right: TokenSymbol };

// vault/basescan: tx hash, frontend builds explorer URL.
// uniswap: app URL (pool pages aren't tx-derived).
export type WireSource =
  | { kind: "vault";    label: string; tx: string }
  | { kind: "basescan"; label: string; tx: string }
  | { kind: "uniswap";  label: string; url: string };

// `id` is server-issued ULID, EXCEPT for `user` events: the server
// MUST persist user_message frames with id === clientId so the
// echoed event reconciles with the optimistic local row by id.
// `ts` is ISO-8601.
// `wallet` deliberately omitted from `user` — the server binds the
// wallet to the connection from the SIWE-bound JWT, not from the body.
// Action `category` lets surfaces show short, kind-aware titles
// (e.g. "Swap", "Claim fees") without parsing the body text.
export type ActionCategory = "swap" | "edit_position" | "claim_fees";

export type WireMessage =
  | { id: string; ts: string; kind: "signal";  text: string }
  | { id: string; ts: string; kind: "action";  title: string; category: ActionCategory; chip: WireChip; tx: string; text: string; thought?: string }
  | { id: string; ts: string; kind: "user";    text: string }
  | { id: string; ts: string; kind: "reply";   text: string; replyTo?: string; sources?: WireSource[] };

export type StreamFrame =
  | { v: 1; type: "history"; events: WireMessage[]; cursor?: string }
  | { v: 1; type: "event";   event: WireMessage }
  | { v: 1; type: "ping" };

// `clientId` on user_message is an idempotency key — server echoes
// it on the persisted event so optimistic UI can reconcile.
export type ClientFrame =
  | { v: 1; type: "subscribe";    since?: string; auth?: string }
  | { v: 1; type: "user_message"; text: string;  clientId: string };

export type StreamHandle = {
  send(frame: ClientFrame): void;
  close(): void;
};

// Without `url`, runs as a dev stub: replays `seed` via onHistory
// and no-ops outgoing frames.
export type StreamOptions = {
  url?: string;
  authToken?: string;
  since?: string;
  seed?: WireMessage[];
  onHistory?: (events: WireMessage[], cursor?: string) => void;
  onEvent?: (event: WireMessage) => void;
  onPing?: () => void;
  onClose?: (ev: CloseEvent | null) => void;
};

export function subscribeAgentStream(opts: StreamOptions): StreamHandle {
  if (!opts.url) {
    if (opts.seed && opts.seed.length > 0) {
      queueMicrotask(() => opts.onHistory?.(opts.seed!, undefined));
    }
    let closed = false;
    return {
      send: () => {},
      close: () => { if (!closed) { closed = true; opts.onClose?.(null); } },
    };
  }

  let ws: WebSocket | null = null;
  let cursor: string | undefined = opts.since;
  let manuallyClosed = false;
  let retry = 0;

  const connect = () => {
    if (manuallyClosed) return;
    ws = new WebSocket(opts.url!);
    ws.addEventListener("open", () => {
      retry = 0;
      const sub: ClientFrame = { v: 1, type: "subscribe", since: cursor, auth: opts.authToken };
      ws!.send(JSON.stringify(sub));
    });
    ws.addEventListener("message", (e) => {
      let frame: StreamFrame;
      try { frame = JSON.parse(e.data); } catch { return; }
      if (!frame || frame.v !== 1) return;
      if (frame.type === "history") {
        cursor = frame.cursor ?? cursor;
        opts.onHistory?.(frame.events, frame.cursor);
      } else if (frame.type === "event") {
        cursor = frame.event.id;
        opts.onEvent?.(frame.event);
      } else if (frame.type === "ping") {
        opts.onPing?.();
      }
    });
    ws.addEventListener("close", (e) => {
      opts.onClose?.(e);
      if (manuallyClosed) return;
      // Exponential backoff capped at ~10s; resubscribe with cursor.
      const delay = Math.min(10000, 500 * Math.pow(2, retry++));
      window.setTimeout(connect, delay);
    });
  };
  connect();

  return {
    send: (f) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f)); },
    close: () => { manuallyClosed = true; ws?.close(); },
  };
}

export function clientId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
