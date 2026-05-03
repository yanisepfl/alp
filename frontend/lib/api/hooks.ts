// React hooks over the ApiClient surface.
//
// A single client instance is lazily created per browser tab. Hooks
// open a per-component subscription against it; the client replays
// cached priming frames to new subscribers so multiple consumers of
// the same data share state without an extra context layer.
//
// Snapshot data flows through component-local state (useState +
// useEffect): the contract is push-driven, so there's no HTTP fetch
// for react-query to manage.
//
// `useApiWallet` wires wagmi → ApiClient. The connected wallet's
// lower-cased address is sent on the subscribe frame (trust-on-claim).
// Disconnects/swaps trigger a forced reconnect so the new principal
// binds cleanly.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";

import { createApiClient } from "./client";
import { createStubClient } from "./stub";
import type {
  ApiClient,
  ApiError,
  SendResult,
  UserActivityRow,
  UserPosition,
  UserSnapshot,
  VaultSnapshot,
  VaultTick,
  WireMessage,
} from "./types";

// ---- Singleton client + stub gate ----
//
// `NEXT_PUBLIC_SHERPA_WSS_URL` unset → stub.
const wssUrl = process.env.NEXT_PUBLIC_SHERPA_WSS_URL;

let _client: ApiClient | null = null;

// Park the wallet here if `setApiWallet` is called before the first
// hook mounts. Drained into createApiClient on first getClient() call.
let _pendingWallet: string | undefined;

function forceApiReconnect(): void {
  if (typeof window === "undefined") return;
  _client?.forceReconnect();
}

// Pass-through. Calling with `undefined` drops to public-only topics.
// Function (not a hook) so wagmi event handlers outside React's render
// tree can call it directly.
export function setApiWallet(wallet: string | undefined): void {
  if (typeof window === "undefined") return;
  if (_client) {
    _client.setWallet(wallet);
    return;
  }
  _pendingWallet = wallet;
}

function getClient(): ApiClient {
  if (_client) return _client;
  _client = wssUrl
    ? createApiClient({ url: wssUrl, wallet: _pendingWallet })
    : createStubClient();
  return _client;
}

// ---- Vault ----

function mergeVaultTick(snap: VaultSnapshot, tick: VaultTick): VaultSnapshot {
  return {
    ...snap,
    ts: tick.ts,
    sharePrice:      tick.sharePrice      ?? snap.sharePrice,
    tvl:             tick.tvl             ?? snap.tvl,
    basketApr:       tick.basketApr       ?? snap.basketApr,
    basketEarned30d: tick.basketEarned30d ?? snap.basketEarned30d,
    users:           tick.users           ?? snap.users,
    sharePrice30d:   tick.sharePrice30d   ?? snap.sharePrice30d,
    tvl30d:          tick.tvl30d          ?? snap.tvl30d,
    apr30d:          tick.apr30d          ?? snap.apr30d,
    allocations:     tick.allocations     ?? snap.allocations,
    pools:           tick.pools           ?? snap.pools,
  };
}

export function useVault(): { snapshot: VaultSnapshot | undefined; error: ApiError | null } {
  const [snap, setSnap] = useState<VaultSnapshot | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    const client = getClient();
    return client.subscribeVault({
      onSnapshot: (s) => { setSnap(s); setError(null); },
      onTick: (t) => setSnap((prev) => (prev ? mergeVaultTick(prev, t) : prev)),
      onError: (e) => setError(e),
    });
  }, []);
  return { snapshot: snap, error };
}

export function useVaultSnapshot(): VaultSnapshot | undefined {
  return useVault().snapshot;
}

// ---- User ----

export function useUser(): { snapshot: UserSnapshot | undefined; error: ApiError | null } {
  const [snap, setSnap] = useState<UserSnapshot | undefined>(undefined);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    const client = getClient();
    return client.subscribeUser({
      onSnapshot: (s) => { setSnap(s); setError(null); },
      onError: (e) => setError(e),
    });
  }, []);
  return { snapshot: snap, error };
}

export function useUserPosition(): UserPosition | null | undefined {
  const { snapshot } = useUser();
  return snapshot?.position;
}

export function useUserActivity(): UserActivityRow[] | undefined {
  const { snapshot } = useUser();
  return snapshot?.activity;
}

// ---- Agent ----

export function useAgentStream(): { messages: WireMessage[]; error: ApiError | null } {
  const [messages, setMessages] = useState<WireMessage[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    const client = getClient();
    return client.subscribeAgent({
      onHistory: (events) => {
        setError(null);
        setMessages((prev) => {
          if (prev.length === 0) return events.slice();
          // Reconnect re-sends history; merge by id, preserve order.
          const seen = new Set(prev.map((m) => m.id));
          const merged = prev.slice();
          for (const e of events) if (!seen.has(e.id)) merged.push(e);
          return merged;
        });
      },
      onEvent: (event) => {
        setMessages((prev) => (prev.some((m) => m.id === event.id) ? prev : [...prev, event]));
      },
      onError: (e) => setError(e),
    });
  }, []);
  return { messages, error };
}

export function useSendUserMessage(): (text: string) => SendResult {
  // Stable reference across renders. The client is a singleton, so a
  // captured reference stays valid for the lifetime of the tab.
  const clientRef = useRef<ApiClient | null>(null);
  if (clientRef.current === null && typeof window !== "undefined") {
    clientRef.current = getClient();
  }
  return useCallback((text: string): SendResult => {
    const client = clientRef.current ?? getClient();
    return client.sendUserMessage(text);
  }, []);
}

// Bridge wagmi → ApiClient. Mounts at top of /app. Watches the
// connected address and routes transitions:
//   - undefined → addr  : setWallet(addr) only (additive subscribe)
//   - addr      → undefined : setWallet(undefined) + forceReconnect
//   - addr1     → addr2     : setWallet(addr2) + forceReconnect (rebind)
//
// No async, no signing, no storage. Trust-on-claim.
export function useApiWallet(): void {
  const { address, isConnected } = useAccount();
  const cur = isConnected && address ? address.toLowerCase() : undefined;
  const prevRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!wssUrl) return;
    const prev = prevRef.current;
    if (prev === cur) return;
    prevRef.current = cur;

    setApiWallet(cur);
    // Reconnect on every transition. Backend may not reliably switch
    // principals on an existing connection, so the safest path is to
    // drop and reopen — agentCursor is preserved across the reconnect.
    forceApiReconnect();
  }, [cur]);
}
