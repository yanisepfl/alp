# ALP — Automated Liquidity Provisioner

A single-deposit USDC vault that runs a diversified, agent-managed basket of concentrated-liquidity positions on Base mainnet. Depositors hand over USDC; the agent allocates across pools, rebalances, and accrues fees on the depositor's behalf — no hedging, no perps. Built for **ETHGlobal OpenAgents** as Alphix's hackathon submission.

## Repo layout

| path | what's there |
|------|--------------|
| [frontend/](frontend/) | Next.js 15 App Router dashboard + landing. Wallet via Reown AppKit (wagmi + viem); Base mainnet only. Functionally complete. |
| [backend/](backend/) | Bun + TypeScript + Hono WSS server. Phase B1 (mocked wire layer) onward; backend lead's territory. |
| [contracts/](contracts/) | Foundry workspace for the on-chain vault + agent contracts. |
| [CONTRACT.md](CONTRACT.md) | **The wire contract.** Frame schemas, topic dispatcher, lifecycle, auth — what the WSS speaks. |
| [DATA_INVENTORY.md](DATA_INVENTORY.md) | Catalogue of every placeholder/mock the UI consumes today, mapped to where it lives in the frontend code. |
| [FEEDBACK.md](FEEDBACK.md) | Running notes on Uniswap API integration friction (V3 + V4). |

## Source of truth

[`CONTRACT.md`](CONTRACT.md) is the contract both teams build against — the frontend's `lib/api/` layer consumes it; the backend's WSS produces it. If the contract and either side disagree, fix the side that's drifted, not the contract — or update the contract by mutual agreement and bump the version.

[`DATA_INVENTORY.md`](DATA_INVENTORY.md) is descriptive (what the UI currently uses) rather than prescriptive; it pairs with `CONTRACT.md` to show exactly which placeholder each contract field replaces.
