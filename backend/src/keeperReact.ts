// Backend → keeper bridge. When the indexer sees a vault Deposit or
// Withdraw on the live tail, it fires this notifier so the keeper can
// react immediately (one signal naming the flow, one reaction-thought,
// optionally one rebalance) instead of waiting up to 5 minutes for the
// next polling tick.
//
// Fire-and-forget by design: a slow keeper or claude subprocess must
// never back-pressure the indexer. Configurable via
//   KEEPER_REACT_URL    — base URL of the keeper (defaults to localhost)
//   KEEPER_REACT_BEARER — bearer that matches the keeper's auth secret
// If the bearer is not set, the notifier becomes a no-op.

const KEEPER_REACT_URL = (Bun.env.KEEPER_REACT_URL ?? "http://localhost:8788").replace(/\/+$/, "");
const KEEPER_REACT_BEARER = Bun.env.KEEPER_REACT_BEARER ?? "";
const REACT_TIMEOUT_MS = 8_000;

export function notifyKeeperReact(
  kind: "deposit" | "withdraw",
  assets: bigint,
  user: string,
  tx: string,
): void {
  if (!KEEPER_REACT_BEARER) return;
  const body = JSON.stringify({ kind, assets: assets.toString(), user, tx });
  void (async () => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REACT_TIMEOUT_MS);
      const res = await fetch(`${KEEPER_REACT_URL}/react`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${KEEPER_REACT_BEARER}`,
        },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        console.warn(`[keeper-react] ${kind} ${tx.slice(0, 10)} → ${res.status}: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      console.warn(`[keeper-react] ${kind} ${tx.slice(0, 10)} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
}
