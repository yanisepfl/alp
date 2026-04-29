// React hooks over the ApiClient surface.
//
// A single client instance is lazily created per browser tab. Hooks
// open a per-component subscription against it; the client replays
// cached priming frames to new subscribers so multiple consumers of
// the same data share state without an extra context layer.
//
// Snapshot data flows through component-local state (useState +
// useEffect): the contract is purely push-driven, so there's no HTTP
// fetch for react-query to manage. Quote/preview endpoints, when
// added, are the natural home for useQuery.
//
// Error handling: each topic-aware hook returns `{ snapshot|messages,
// error }`. `error` carries non-fatal recoverable failures (rejected
// subscriptions, server-emitted error frames). Snapshots clear the
// error on the next successful push. See client.ts for the full
// "rejected vs error vs close" doctrine.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

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
// `setApiAuthToken` may be called before any hook mounts (e.g. wagmi
// session restored at boot). Park the token here so the live client
// picks it up on first creation, avoiding a setAuthToken round-trip.
let _pendingAuthToken: string | undefined;

// Auth-invalid subscriber set. The auth bridge registers here at mount
// to react to backend's 4001/4003 close codes (re-mint and reconnect).
// Module-level rather than passed at createApiClient time so the bridge
// can attach after the client is already running.
const _authInvalidListeners = new Set<(closeCode: number) => void>();

export function onApiAuthInvalid(fn: (closeCode: number) => void): () => void {
  _authInvalidListeners.add(fn);
  return () => { _authInvalidListeners.delete(fn); };
}

export function forceApiReconnect(): void {
  if (typeof window === "undefined") return;
  _client?.forceReconnect();
}

function getClient(): ApiClient {
  if (_client) return _client;
  _client = wssUrl
    ? createApiClient({
        url: wssUrl,
        authToken: _pendingAuthToken,
        onAuthInvalid: (code) => {
          // Token was rejected (4001/4003). Drop the pending copy so
          // a re-mount doesn't re-present the same expired JWT, then
          // fan out to subscribers (the auth bridge re-mints).
          _pendingAuthToken = undefined;
          for (const fn of _authInvalidListeners) fn(code);
        },
      })
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

// Pass-through for SIWE wiring. Calling with `undefined` drops to
// public-only topics. A function (not a hook) so wagmi event handlers
// outside React's render tree can call it directly.
export function setApiAuthToken(token: string | undefined): void {
  if (typeof window === "undefined") return;
  if (_client) {
    _client.setAuthToken(token);
    return;
  }
  // Hook hasn't materialised the client yet — park the token so the
  // first getClient() call passes it through `authToken` directly.
  _pendingAuthToken = token;
}
