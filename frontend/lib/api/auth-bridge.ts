// Bridge wagmi wallet state → ApiClient auth.
//
// One mount-point in /app drives this: when the user's connected
// address changes, mint a SIWE session and route it into
// `setApiAuthToken` (additive subscribe) or `forceReconnect`
// (mid-session wallet swap / disconnect — backend convention "the
// wallet does not switch mid-connection").
//
// State machine, keyed on `(prevAddress, currentAddress)`:
//   none  → none  : no-op
//   none  → addr  : sign + verify, setApiAuthToken(token)         — additive
//   addr  → none  : setApiAuthToken(undefined), forceReconnect    — drop principal
//   addr1 → addr2 : sign + verify, setApiAuthToken(token), forceReconnect  — rebind
//
// 4001/4003 (JWT rejected mid-session) → re-mint once and reconnect.
// User-cancelled signature is silent: the user explicitly declined,
// and the auth_required CTA already covers that state.

"use client";

import { useEffect, useRef } from "react";
import { useAccount, useSignMessage } from "wagmi";

import { toast } from "../toast";

import { AuthError, getAuthSession } from "./auth";
import { clearStoredSession, forceApiReconnect, loadStoredSession, onApiAuthInvalid, saveStoredSession, setApiAuthToken } from "./hooks";

const wssUrl = process.env.NEXT_PUBLIC_SHERPA_WSS_URL;

export function useAuthBridge(): void {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  // Lowercase for stable identity comparison — wagmi sometimes
  // returns checksum, sometimes lower; backend treats wallets
  // case-insensitively (B7 reply routing).
  const cur = isConnected && address ? address.toLowerCase() : undefined;

  const prevRef = useRef<string | undefined>(undefined);
  // Mirror of `cur` for the 4001 listener — refs let the effect
  // below capture the latest value without re-binding the listener
  // on every address change.
  const curRef = useRef<string | undefined>(undefined);
  curRef.current = cur;
  // Same for the signer: hook value rebinds every render, but the
  // 4001 listener is registered once. Read through the ref.
  const signRef = useRef<typeof signMessageAsync>(signMessageAsync);
  signRef.current = signMessageAsync;

  // Connect / disconnect / wallet-swap.
  useEffect(() => {
    // Stub mode: auth is meaningless against the local stub and
    // /auth/* isn't reachable. The bridge is dormant.
    if (!wssUrl) return;

    const prev = prevRef.current;
    if (prev === cur) return;
    prevRef.current = cur;

    if (prev === undefined && cur !== undefined) {
      // anon → authed. Additive subscribe; existing connection stays.
      // Skip SIWE if a valid JWT for this wallet is already in storage
      // (24h TTL backend-side); a refresh-within-day inherits the
      // existing session without prompting the wallet again.
      const stored = loadStoredSession();
      if (stored && stored.wallet.toLowerCase() === cur) {
        setApiAuthToken(stored.token);
        return;
      }
      let cancelled = false;
      (async () => {
        try {
          const session = await getAuthSession(cur, (m) => signMessageAsync({ message: m }));
          if (cancelled) return;
          setApiAuthToken(session.token);
          saveStoredSession({ token: session.token, wallet: session.wallet, exp: session.exp });
        } catch (err) {
          handleAuthFailure(err);
        }
      })();
      return () => { cancelled = true; };
    }

    if (prev !== undefined && cur === undefined) {
      // authed → anon. Reconnect without auth so the new socket
      // subscribes anon and the user topic is rejected via
      // ack.rejected → the CTA renders. Drop any stored session too —
      // we don't reuse it for a different wallet on the next connect.
      clearStoredSession();
      setApiAuthToken(undefined);
      forceApiReconnect();
      return;
    }

    if (prev !== undefined && cur !== undefined) {
      // Wallet swap. Reconnect bound to the new principal — backend
      // ignores token swaps on an already-authed connection. The
      // stored session was minted for the OLD wallet, so clear it
      // before re-minting to avoid presenting it on the next reload.
      clearStoredSession();
      let cancelled = false;
      (async () => {
        try {
          const session = await getAuthSession(cur, (m) => signMessageAsync({ message: m }));
          if (cancelled) return;
          setApiAuthToken(session.token);
          saveStoredSession({ token: session.token, wallet: session.wallet, exp: session.exp });
          forceApiReconnect();
        } catch (err) {
          handleAuthFailure(err);
          if (cancelled) return;
          // Even if the new wallet's signature failed/cancelled, the
          // OLD principal is no longer the connected wallet — drop
          // the stale token and reconnect anon.
          setApiAuthToken(undefined);
          forceApiReconnect();
        }
      })();
      return () => { cancelled = true; };
    }
  }, [cur, signMessageAsync]);

  // Mid-session JWT rejection. Best-effort single re-mint. Failure
  // (including user-cancel) leaves the user in auth_required state
  // — the next wallet event will trigger another attempt naturally.
  useEffect(() => {
    if (!wssUrl) return;
    return onApiAuthInvalid(async () => {
      const addr = curRef.current;
      const sign = signRef.current;
      if (!addr) return;
      try {
        const session = await getAuthSession(addr, (m) => sign({ message: m }));
        if (curRef.current !== addr) return;
        setApiAuthToken(session.token);
        saveStoredSession({ token: session.token, wallet: session.wallet, exp: session.exp });
        forceApiReconnect();
      } catch (err) {
        handleAuthFailure(err);
      }
    });
  }, []);
}

// Single funnel for SIWE failures so the noise level stays consistent.
// User-cancel surfaces as an info toast (cancellation is intentional,
// not a failure); other reasons log at warn so a config issue
// (wrong_domain) shows up in dev consoles AND give the user an error
// toast so they don't silently end up stuck in the disconnected state.
function handleAuthFailure(err: unknown): void {
  if (err instanceof AuthError) {
    if (err.reason === "user_rejected") {
      toast("info", "Sign-in rejected");
      return;
    }
    console.warn(`[auth] ${err.reason}: ${err.message}`);
    toast("error", "Sign-in failed, try again");
    return;
  }
  console.warn("[auth] unexpected error", err);
  toast("error", "Sign-in failed, try again");
}
