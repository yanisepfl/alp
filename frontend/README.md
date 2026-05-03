# ALPS Frontend

Next.js 15 (App Router) dashboard + landing for the Alphix ALPS vault. Wallet via Reown AppKit on top of wagmi + viem; targets **Base mainnet only** (chain ID 8453).

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

All UI reads via hooks in [`lib/api/`](lib/api/). Without `NEXT_PUBLIC_SHERPA_WSS_URL` set, hooks resolve from a local stub ([`lib/api/stub.ts`](lib/api/stub.ts)) that emits frames in the same shape as the live backend. With the env var set, the same hooks subscribe to the real backend over WSS — the UI does not branch on dev-vs-real, only the hook source does.

## Wallet

[`components/web3-provider.tsx`](components/web3-provider.tsx) wires Reown AppKit + wagmi for the connection surface. The connected wallet's lower-cased address is sent on the WSS subscribe frame (trust-on-claim — every served field is derivable from public chain).

## Write actions

The deposit input reads the connected wallet's USDC balance live via wagmi's `useReadContract`. The Deposit CTA runs the standard ERC20 two-step: an `approve(VAULT_ADDRESS, amount)` if allowance is short, then `deposit(assets, receiver)` against the ERC4626 vault. Withdraw signs `redeem(shares, receiver, owner)`. ABI fragments + `VAULT_ADDRESS` env handling live in [`lib/contracts.ts`](lib/contracts.ts).

After a deposit or withdraw confirms on-chain, the backend's event indexer pushes a fresh `user.snapshot` over WSS — the position card updates without an explicit refetch. User-rejected wallet popups are silent; on-chain reverts surface as a toast.

## Architecture pointers

- [`lib/api/`](lib/api/) — typed client + hooks. `types.ts` is the wire-type source of truth; `stub.ts` is the offline source; `client.ts` is the WSS client.
- [`components/web3-provider.tsx`](components/web3-provider.tsx) — wallet provider tree (Reown AppKit + wagmi config).
- [`app/app/page.tsx`](app/app/page.tsx) — the dashboard surface. Reads exclusively through `lib/api/` hooks.
- [`components/landing-face.tsx`](components/landing-face.tsx) — the landing page (frozen content; static animation data).
- [`lib/agent-stream.ts`](lib/agent-stream.ts) — Sherpa chat wire types shared with the backend.
