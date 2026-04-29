// User topic dispatcher. Two modes:
//
//   - Chain mode (VAULT_ADDRESS set, indexer running): snapshots come from
//     the indexer's per-wallet lot lists + activity rows + the live
//     sharePrice. Tx-driven re-emits fire when Deposit/Withdraw events for
//     the wallet are folded in; share-price-driven re-emits piggyback on
//     the vault's 5s poll loop with the FE-approved debounce
//     (|delta valueUsd| >= $0.01 OR >= 2s elapsed since last emission with
//     any change).
//   - Mock mode (VAULT_ADDRESS unset): the B1 demoUserSnapshot stub is
//     served on subscribe and never re-emitted. No watchers are registered.
//
// Per-connection state lives here so vault.ts can drive the debounced
// share-price re-emit without owning user-topic concerns.
//
// Cost-basis policy is server-authoritative (CONTRACT.md §4.2) — see
// indexer.getUserSnapshot for WAVG + FIFO accounting.

import type { StreamFrame } from "../types";
import { demoUserSnapshot } from "../mocks/user-state";
import { getUserSnapshot, getWalletShares, subscribeUserUpdates } from "../indexer";
import { currentSharePrice, isChainMode, isIndexerEnabled } from "./vault";

type Deliver = (f: StreamFrame) => void;

type Sub = {
  wallet: string;             // echoed verbatim (preserves checksum case the JWT delivered)
  walletKey: string;          // lower-cased; for indexer reads + watcher key
  deliver: Deliver;
  unsubscribe: (() => void) | null; // tx-driven watcher disposer; null in mock mode
  lastEmitTs: number;         // wall-clock ms of last user.snapshot emission
  lastValueUsd: number;       // for share-price-driven debounce
};

const subs = new Map<string, Sub>();

const SHARE_PRICE_DEBOUNCE_VALUE_USD = 0.01;
const SHARE_PRICE_DEBOUNCE_MS = 2000;

export function subscribeUser(cid: string, wallet: string, deliver: Deliver): void {
  const walletKey = wallet.toLowerCase();
  // Seed the debounce state from the same source that ws.ts is about to
  // emit as the priming snapshot — so the first 5s vault tick after
  // subscribe doesn't fire a duplicate "delta from 0" re-emit.
  const seedValueUsd = isChainMode() && isIndexerEnabled()
    ? (Number(getWalletShares(walletKey)) / 1e18) * currentSharePrice()
    : 0;

  const sub: Sub = {
    wallet,
    walletKey,
    deliver,
    unsubscribe: null,
    lastEmitTs: Date.now(),
    lastValueUsd: seedValueUsd,
  };
  subs.set(cid, sub);

  // Chain mode only: register a tx-driven watcher. The indexer fires it
  // after Deposit/Withdraw events for this wallet are folded in.
  if (isChainMode() && isIndexerEnabled()) {
    sub.unsubscribe = subscribeUserUpdates(walletKey, () => {
      const frame = userSnapshotFrame(wallet);
      sub.deliver(frame);
      sub.lastEmitTs = Date.now();
      if (frame.type === "snapshot" && frame.topic === "user" && frame.snapshot.position) {
        sub.lastValueUsd = frame.snapshot.position.valueUsd;
      } else {
        sub.lastValueUsd = 0;
      }
    });
  }
}

export function unsubscribeUser(cid: string): void {
  const sub = subs.get(cid);
  if (!sub) return;
  if (sub.unsubscribe) sub.unsubscribe();
  subs.delete(cid);
}

export function userSnapshotFrame(wallet: string): StreamFrame {
  if (isChainMode() && isIndexerEnabled()) {
    const snapshot = getUserSnapshot(wallet, currentSharePrice());
    return { v: 1, type: "snapshot", topic: "user", snapshot };
  }
  return { v: 1, type: "snapshot", topic: "user", snapshot: demoUserSnapshot(wallet) };
}

// Called once per successful chain-mode vault poll (5s cadence). For each
// user-topic subscription, recompute the cheap valueUsd projection
// (balance × sharePriceNow) and decide whether the debounce window allows
// a fresh user.snapshot emission. Mock mode is a no-op.
export function reEmitOnSharePriceTick(): void {
  if (!isChainMode() || !isIndexerEnabled()) return;
  if (subs.size === 0) return;
  const sharePriceNow = currentSharePrice();
  const now = Date.now();

  for (const sub of subs.values()) {
    const balance = getWalletShares(sub.walletKey);
    const newValueUsd = (Number(balance) / 1e18) * sharePriceNow;
    const delta = Math.abs(newValueUsd - sub.lastValueUsd);
    const elapsed = now - sub.lastEmitTs;

    // Debounce — match FE clarification 1: emit when value moved meaningfully
    // OR when the elapsed-window allows AND there's any change to report.
    const meaningfulDelta = delta >= SHARE_PRICE_DEBOUNCE_VALUE_USD;
    const elapsedAllows = elapsed >= SHARE_PRICE_DEBOUNCE_MS && newValueUsd !== sub.lastValueUsd;
    if (!meaningfulDelta && !elapsedAllows) continue;

    const frame = userSnapshotFrame(sub.wallet);
    sub.deliver(frame);
    sub.lastEmitTs = now;
    sub.lastValueUsd = newValueUsd;
  }
}
