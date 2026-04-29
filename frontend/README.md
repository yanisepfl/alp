# ALP Frontend

Next.js 15 (App Router) dashboard + landing for the Alphix ALP vault. Wallet via Reown AppKit on top of wagmi + viem; targets **Base mainnet only** (chain ID 8453).

## Quickstart

```bash
npm install
cp .env.local.example .env.local   # fill in NEXT_PUBLIC_REOWN_PROJECT_ID
npm run dev                        # http://localhost:3000
```

Production build sanity check: `npm run build`.

## Required env vars

| var | required | where to get it |
|-----|----------|-----------------|
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | **yes** — `lib/wagmi.ts` throws at boot if missing | [cloud.reown.com](https://cloud.reown.com) |
| `NEXT_PUBLIC_SHERPA_WSS_URL` | optional | Backend WSS endpoint (e.g. `ws://<vm-ip>:8787/stream`). **If unset**, the dev stub serves contract-shaped mocks so the UI runs offline. |
| `NEXT_PUBLIC_VAULT_ADDRESS`  | **yes** — `lib/contracts.ts` throws at boot if missing | Deployed ALPVault on Base mainnet. Must match the backend's `VAULT_ADDRESS`. Stub-mode dev accepts any 0x-prefixed 42-char placeholder. |

See [.env.local.example](.env.local.example).

## Data layer

All UI reads via hooks in [`lib/api/`](lib/api/). Without `NEXT_PUBLIC_SHERPA_WSS_URL` set, hooks resolve from a local stub ([`lib/api/stub.ts`](lib/api/stub.ts)) that emits frames matching [`../CONTRACT.md`](../CONTRACT.md). With the env var set, the same hooks subscribe to the real backend over WSS — the UI does not branch on dev-vs-real, only the hook source does.

The stub mirrors the contract's frame shapes intentionally so that switching sources is a one-line env change.

## Wallet

[`components/web3-provider.tsx`](components/web3-provider.tsx) wires Reown AppKit + wagmi for the connection surface. Auth is bridged into the WSS client by [`lib/api/auth-bridge.ts`](lib/api/auth-bridge.ts), mounted once at the top of [`app/app/page.tsx`](app/app/page.tsx).

**Current state (Phase 7c):** the bridge mints session tokens via real EIP-4361 SIWE — `GET /auth/nonce` → wagmi `signMessage` → `POST /auth/verify`. The wallet popup prompts on connect; cancelling silently leaves the user in the `auth_required` CTA state. Backend's `AUTH_DEV_BYPASS` should be `0` in any non-test environment — `getDevToken` is retained in [`lib/api/auth.ts`](lib/api/auth.ts) only as an integration-test helper.

The SIWE message binds `domain = window.location.host`, `uri = window.location.origin`, and `chainId = 8453` (Base mainnet). Backend's `EXPECTED_DOMAIN` / `EXPECTED_URI` must match the frontend origin exactly (defaults align with `localhost:3000` for dev). For deploys, set both backend env vars to the production frontend host.

Tokens are memory-only — disconnecting the wallet, swapping addresses, or hitting a 4001 close all re-prompt SIWE via `getAuthSession`.

## Phase 7d — write actions

The deposit input reads the connected wallet's USDC balance live via wagmi's `useBalance`. The Deposit CTA runs the standard ERC20 two-step: an `approve(VAULT_ADDRESS, amount)` if allowance is short, then `deposit(assets, receiver)` against the ERC4626 vault. Withdraw signs `redeem(shares, receiver, owner)`. ABI fragments + `VAULT_ADDRESS` env handling live in [`lib/contracts.ts`](lib/contracts.ts).

After a deposit or withdraw confirms on-chain, the backend's event indexer (`../backend/README.md` "User position (B4)") pushes a fresh `user.snapshot` over WSS — the position card updates without an explicit refetch. User-rejected wallet popups are silent; on-chain reverts surface as a single inline "Transaction failed — try again" stripe under the CTA.

## Architecture pointers

- [`lib/api/`](lib/api/) — typed client + hooks. `types.ts` mirrors the contract; `stub.ts` is the offline source; the WSS client lives here too.
- [`components/web3-provider.tsx`](components/web3-provider.tsx) — wallet provider tree (Reown AppKit + wagmi config).
- [`app/app/page.tsx`](app/app/page.tsx) — the dashboard surface. Reads exclusively through `lib/api/` hooks.
- [`components/landing-face.tsx`](components/landing-face.tsx) — the landing page (frozen content; static animation data, not wired to live state).
- [`lib/agent-stream.ts`](lib/agent-stream.ts) — original agent-stream wire framework. The contract extends this rather than replacing it.

## Reference docs

- [`../CONTRACT.md`](../CONTRACT.md) — the wire contract (source of truth)
- [`../DATA_INVENTORY.md`](../DATA_INVENTORY.md) — placeholder catalogue
