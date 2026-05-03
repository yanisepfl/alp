# ALPS — Automated Liquidity Positions

Concentrated liquidity on autopilot. Powered by the Uniswap V3 + V4 SDKs, the Uniswap Trading API, and KeeperHub orchestration.

## The Problem

**Swap volume on Uniswap created over $2B in LP fees in 2025. Most of it flows to actively managed positions held by sophisticated LPs. Tapping into that yield requires infrastructure and knowledge most depositors don't have.**

Concentrated liquidity (CL) on Uniswap V3 and V4 is much more capital-efficient than full-range LP, but only while the position is in range. When it drifts out, the LP earns zero fees. Most LPs are passive, they don't monitor tick-by-tick, judge mean reversion, or compare bundle gas costs against expected fee revenue. Manually managing a basket of positions across multiple pools is a 24/7 job that very few LPs do well.

**The result:** roughly half of CL positions sit out of range at any given time, representing hundreds of millions in idle liquidity earning zero. Most LPs would have been better off just holding their tokens.

## The Solution

ALPS is a single-deposit USDC vault that runs a diversified basket of CL positions across Uniswap V3 and V4, with an off-chain agent that monitors and rebalances them autonomously.

Here's how:

1. You deposit USDC into a single ERC4626 vault on Base. The vault holds CL positions across whitelisted pools (e.g. USDC/USDT V3, USDC/cbBTC V3, ETH/USDC V4 with hooks) and accrues fees back to the share price.
2. Agents watch and reason. The off-chain keeper runs a 5-policy decision engine every 5 minutes (range drift, anti-whipsaw cooldowns, realized volatility, idle reserve, cap pressure). Claude narrators curate the keeper's reasoning into a easy to understand chat surface.
3. KeeperHub orchestrates. Three KeeperHub workflows drive the loop: a polling workflow generates fresh chain context every 5 minutes and gates rebalances on a dynamic gas floor; a reactive workflow audits every on-chain rebalance with a basket-wide health snapshot; a manual-trigger workflow allows us to ensure there is a rebalancing event during demo time.
4. The vault executes. When a rebalance is warranted, the keeper consults Uniswap's V3 + V4 SDKs for optimal mint params and the Uniswap Trading API for swap routing and UniversalRouter calldata, then signs `vault.executeRemoveLiquidity → maybe-swap → executeAddLiquidity` as the vault's `agent` role. The vault routes through whitelisted adapter contracts to the V3 NonfungiblePositionManager and V4 PositionManager.

## Architecture

```
        ┌────────────────────────────────────────────────────────────┐
        │  KeeperHub (app.keeperhub.com)                             │
        │  ┌─────────────────┐ ┌──────────────────┐ ┌─────────────┐  │
        │  │ alps-rebalance  │ │ alps-post-       │ │ alps-demo-  │  │
        │  │ Schedule */5    │ │  rebalance       │ │  rebalance  │  │
        │  │  → Read TVL     │ │ Event:           │ │ Manual      │  │
        │  │  → Pool roster  │ │  LiquidityAdded  │ │  trigger    │  │
        │  │  → Agent gas    │ │  → batch read 3  │ │  → /force   │  │
        │  │  → L2 gas price │ │    pool values   │ │             │  │
        │  │  → if gas OK    │ │  → math.sum      │ │             │  │
        │  │     → /scan     │ │  → /post-        │ │             │  │
        │  │     → fired/    │ │     rebalance    │ │             │  │
        │  │       held log  │ │                  │ │             │  │
        │  └────────┬────────┘ └────────┬─────────┘ └──────┬──────┘  │
        └───────────┼───────────────────┼──────────────────┼─────────┘
                    │ POST /scan        │ POST /post-      │ POST /force
                    │ + /log-tick       │   rebalance      │
                    ▼                   ▼                  ▼
        ┌────────────────────────────────────────────────────────────┐
        │  Keeper (Bun + Hono, TypeScript)                           │
        │                                                            │
        │  • 5-policy decision engine (range / anti-whipsaw /        │
        │    vol / idle / cap), actuates or holds each tick          │
        │  • Claude narrators curate: action on actuate, rollup or   │
        │    SILENCE on hold, signal for external integrations       │
        │  • Uniswap V3 + V4 SDK consultation for mint sizing        │
        │  • Anti-whipsaw cooldowns (sqlite-persisted)               │
        │  • viem signs as vault.agent()                             │
        └────────────────────┬───────────────────────────────────────┘
                             │ vault.execute{Remove,Swap,Add}Liquidity
                             ▼
        ┌────────────────────────────────────────────────────────────┐
        │  ALPVault (ERC4626) on Base mainnet                        │
        │  ├── UniV3Adapter      → V3 NonfungiblePositionManager     │
        │  ├── UniV4Adapter      → V4 PositionManager (with hooks)   │
        │  └── URAdapter         → UniversalRouter (swap routing)    │
        └────────────────────┬───────────────────────────────────────┘
                             │ events
                             ▼
        ┌────────────────────────────────────────────────────────────┐
        │  Backend (Bun + Hono + sqlite)                             │
        │  ├── WSS multiplexer (vault / user / agent topics)         │
        │  ├── Indexer auto-folds chain events into the agent feed   │
        │  └── Sherpa chat — claude -p subprocess answers users      │
        │      with live numbers from the agent ring                 │
        └────────────────────┬───────────────────────────────────────┘
                             │ wss://…/stream
                             ▼
        ┌────────────────────────────────────────────────────────────┐
        │  alps frontend, user facing dApp                           │
        │  • Wallet via Reown AppKit + wagmi + viem (Base only)      │
        │  • Live agent feed, vault snapshot, Sherpa chat            │
        └────────────────────────────────────────────────────────────┘
```

The keeper, backend, and KeeperHub workflows are independently deployable. The keeper exposes `/scan` (polling tick), `/post-rebalance` (reactive audit), `/force` (operator override), `/log-tick` (workflow outcome log), and `/react` (user-flow reaction). All bearer-authed.

## The Rebalance Flow

1. **Tick** — KeeperHub's `alps-rebalance` Schedule trigger fires every 5 minutes. KeeperHub itself reads `vault.totalAssets()` (TVL), `vault.getActivePools()` (pool roster), the agent EOA's ETH balance, and Base's L2 gas-price oracle.
2. **Gas gate** — A Condition node short-circuits the workflow when the agent can't cover ≥ 2 rebalance bundles at the current L2 gas price (floor scales with congestion). Otherwise the workflow proceeds.
3. **Evaluate** — KeeperHub POSTs to the keeper's `/scan` with the chain reads composed into the body via template syntax. The keeper cross-checks KH-supplied TVL against its own observation, runs all five policies, and picks the highest-priority Candidate.
4. **Plan** — When the chosen Decision is `rebalance`, the keeper consults the Uniswap V3 + V4 SDKs (`Position.fromAmounts`, `mintAmountsWithSlippage`, `burnAmountsWithSlippage`) to compute optimal mint amounts and slippage floors. If a swap is needed, the Uniswap Trading API at `trade-api.gateway.uniswap.org` returns multi-hop UniversalRouter calldata that gets embedded in the bundle.
5. **Sign + submit** — viem signs `vault.executeRemoveLiquidity` then (optionally) `executeSwap` then `executeAddLiquidity` as the vault's `agent` role. The vault dispatches to the relevant adapter contracts which call the V3 / V4 position managers.
6. **Log** — A second Condition branches on whether the keeper actuated. Both branches POST to `/log-tick` with structured outcome (`fired` or `held`), so the dashboard's run history pairs each tick with a narrated agent-feed entry.
7. **Audit** — `alps-post-rebalance`'s Blockchain Event trigger detects `vault.LiquidityAdded` within ~8 seconds. It reads `vault.poolValueExternal()` for all three pools in a single Multicall3 call (`web3/batch-read-contract`), sums the deployed total in-workflow (`math/aggregate`), then POSTs the basket-wide audit to the keeper. KeeperHub provides a second pair of eyes on every actuation.

The Uniswap stack is central to this flow: the V3 + V4 SDKs handle all position math (mint sizing, slippage floors, burn previews), the Trading API picks the best multi-hop route on each swap leg and returns ready-to-sign UniversalRouter calldata that the keeper drops straight into the bundle, and the V3/V4 PositionManager contracts execute the on-chain mint/burn.

## User Flow Reactions

Deposits and withdrawals don't wait for the next polling tick. The backend's vault indexer watches the live tail for `Deposit` and `Withdraw` events and forwards each one to the keeper's `/react` endpoint. The keeper emits one signal naming the flow ("Deposit of 5.0000 USDC by 0x1234…7890."), runs the engine immediately, emits one reaction-thought reasoning about whether to rebalance, and, if the engine chose to actuate, fires the rebalance and emits the action narration. So a user who deposits sees up to three feed entries within seconds: the deposit, the agent's thinking, and (when warranted) the matching rebalance.

## Agent Feed Narration

A 5-policy engine across three pools produces a lot of raw reasoning per tick, surfacing it unfiltered would bury the user under spam. ALPS curates everything into a high-signal feed using multiple narrators. Every narrator emits a short, focused line — no walls of text — and each one answers a different question:

| Narrator | Fires when | Output |
|---|---|---|
| **Action** | The keeper just submitted a transaction | A past-tense recap of what landed ("Rebalanced USDC/USDT.") |
| **Rollup** | A tick finished without actuating (the common case) | Either a deduction across policies, a focused observation lifted from one — *or* `SILENCE`, in which case nothing is emitted at all. The rollup sees all five policies' reasoning, the KeeperHub pre-flight context, and the recent feed, and decides whether anything is worth surfacing. |
| **React** | A user just deposited or withdrew | A reasoning about whether to rebalance to absorb the flow, citing the actual amount. Always emits — the depositor or withdrawer is owed an explanation even when the answer is "holding as idle reserve". |
| **Signal** | An external integration speaks: KeeperHub post-rebalance audit, inline Uniswap-SDK consult during a rebalance, low-gas alert | A remark quoting concrete numbers ("Uniswap V3 SDK expects 0.148 USDC + 0.148 USDT for the re-mint.") |

The rollup prompt explicitly leans toward `SILENCE` to minimize messages to highly contextual ones. Narration runs in `claude -p` subprocesses after the tx, never blocking on-chain actuation.

## Security Model

The keeper signs with a hot key. The vault contracts enforce every safety bound that matters.

| Layer | What it blocks | How |
|---|---|---|
| Vault `agent` role | Unauthorized actuation by any other key | `onlyAgent` modifier on `executeRemoveLiquidity` / `executeAddLiquidity` / `executeSwap` |
| Pool whitelist | Rebalances into rogue pools | `PoolRegistry.isPoolKnown(key)` checked on every execute; only whitelisted (adapter, token0, token1, fee, tickSpacing, hooks) tuples are routable |
| Slippage caps | MEV / sandwich loss on swap and mint | `amount0Min` / `amount1Min` enforced by the adapter; tolerances pulled from tested defaults (50 bps swap, 100 bps liquidity) |
| Pre-flight simulation | Bad inputs on the REMOVE step | viem `simulateContract` surfaces vault custom errors before signing; SWAP and ADD skip simulation to avoid the eventual-consistency window between two writes |
| KeeperHub gas gate | Rebalances during gas spikes that wouldn't be EV-positive | Dynamic floor in the polling workflow: `agentEth > gasPrice × 14M wei` (~ 2 bundles of margin); skipping fires the low-gas log path |

Even with a fully compromised agent key, an attacker cannot withdraw the vault's underlying USDC, transfer tokens to an external address, change the pool whitelist, or route to an unwhitelisted pool. The worst they can do is rebalance vault positions within whitelisted pools at adapter-enforced slippage tolerances.

**Hackathon caveats:** the agent key is held in a `.env` on the VM rather than a hardware-backed signer or KeeperHub Direct Execution / Turnkey wallet. The Cloudflare Tunnel exposing the keeper to KeeperHub uses a quick-tunnel; a production deployment would use a named tunnel with a stable subdomain. The `cap` policy emits real-signal narration but does not yet actuate cross-pool redistribution.

## Uniswap Stack Integration

ALPS is built end-to-end on the Uniswap stack:

| Component | Usage |
|---|---|
| Uniswap V3 SDK (`@uniswap/v3-sdk`) | `Pool` and `Position` entities for V3 mint/burn math; `Position.fromAmounts` + `mintAmountsWithSlippage` to compute optimal mint amounts; `burnAmountsWithSlippage` for slippage floors on remove |
| Uniswap V4 SDK (`@uniswap/v4-sdk`) | V4 hooked-pool entities including the Alphix dynamic-fee hook on ETH/USDC; `Position.fromAmounts` for optimal mint sizing under V4's exact-input semantics |
| Uniswap SDK Core (`@uniswap/sdk-core`) | `Token`, `Ether`, `Currency`, `Percent` primitives shared across V3 and V4 paths; consistent decimal handling between USDC (6), cbBTC (8), and ETH (18) |
| Uniswap Trading API | `/quote` finds the best multi-hop route for swap legs; `/swap` returns production-grade UniversalRouter calldata that the keeper embeds into the rebalance bundle |
| V3 NonfungiblePositionManager | Target of `UniV3Adapter` for V3 mint, burn, and fee collection on whitelisted V3 pools |
| V4 PositionManager | Target of `UniV4Adapter` for V4 hooked-pool position management; consumes `modifyLiquidities` action-encoded calldata |
| UniversalRouter | Swap execution target (called via Trading API-generated calldata wrapped in a vault adapter call) |
| V4 hook (Alphix dynamic-fee) | The ETH/USDC pool ALPS rebalances is a V4 dynamic-fee pool with the Alphix hook — exercises real V4 hooked-pool LP, not just the canonical V4 flow |

## Deployed Contracts

| Contract | Chain | Address |
|---|---|---|
| ALPVault (ERC4626) | Base | [`0x3F0e6cef3a75f52F1E55806Afe40317f51199CaE`](https://basescan.org/address/0x3F0e6cef3a75f52F1E55806Afe40317f51199CaE) |
| PoolRegistry | Base | [`0x6911dC2e50C4D89f244aB9D65E89A847Beee1634`](https://basescan.org/address/0x6911dC2e50C4D89f244aB9D65E89A847Beee1634) |
| UniV3Adapter | Base | [`0x145Deaf02fDd2F56630DC64afFbd4bdDf36A3D79`](https://basescan.org/address/0x145Deaf02fDd2F56630DC64afFbd4bdDf36A3D79) |
| UniV4Adapter | Base | [`0xB6871C8cd995fF015DBa7373b371426E80cBBCF0`](https://basescan.org/address/0xB6871C8cd995fF015DBa7373b371426E80cBBCF0) |
| UniversalRouterAdapter | Base | [`0x6BeE052D58Ba95bae9fd23d81a2B96145095a962`](https://basescan.org/address/0x6BeE052D58Ba95bae9fd23d81a2B96145095a962) |

## Project Structure

```
alps/
├── contracts/    # Foundry — ALPVault (ERC4626), PoolRegistry, V3/V4/UR adapters
├── keeper/       # Bun + Hono — 5-policy decision engine, Uniswap SDK consultation, viem signer
├── agent/        # KeeperHub workflow snapshots + reference Cloudflare Worker keeper
├── backend/      # Bun + Hono + sqlite — WSS multiplexer, vault-event indexer, Sherpa chat
└── frontend/     # Next.js 15 — wallet, live agent feed, Sherpa chat, vault dashboard
```

## Try It Live

The deployed dApp is at **[alps-six.vercel.app](https://alps-six.vercel.app/)** — no local setup needed.

Connect your wallet, deposit USDC, and watch the keeper narrate every decision in real time. The three KeeperHub workflows that drive the loop (`alps-rebalance`, `alps-post-rebalance`, `alps-demo-rebalance`) are checked in as JSON snapshots under [agent/keeperhub-workflows/](agent/keeperhub-workflows/).

## Local Setup

### Prerequisites

- [Foundry](https://book.getfoundry.sh) (for contracts)
- [Bun](https://bun.sh) ≥ 1.3 (for keeper and backend)
- Node.js 20+ (for frontend)
- A Base mainnet RPC URL (Alchemy recommended)
- A funded EOA with the vault's `agent` role (or owner key to call `setAgent`)
- Optional: a [KeeperHub](https://app.keeperhub.com) account + `kh_…` API key

### Contracts

```bash
cd contracts
forge install
forge build
forge test
```

### Keeper

```bash
cd keeper
bun install
cp .env.example .env   # fill AGENT_PRIVATE_KEY, BASE_RPC_URL, KEEPER_INBOUND_BEARER, INGEST_SECRET
bun run typecheck
bun run src/index.ts   # listens on http://localhost:8788
```

### Backend

```bash
cd backend
bun install
cp .env.example .env   # fill BASE_RPC_URL, VAULT_ADDRESS, INGEST_SECRET,
                       # WS_ALLOWED_ORIGINS (comma-separated; supports *.vercel.app)
bun run src/index.ts   # listens on http://localhost:8787
```

### Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local  # NEXT_PUBLIC_REOWN_PROJECT_ID, NEXT_PUBLIC_VAULT_ADDRESS,
                                  # NEXT_PUBLIC_SHERPA_WSS_URL=ws://<backend-host>:8787/stream
npm run dev   # http://localhost:3000
```

## On-Chain Proof

Real rebalance bundles executed by the keeper across all three live pools. Each is a multi-step on-chain bundle (`LiquidityRemoved → maybe-swap → LiquidityAdded`).

**V3 USDC/USDT (stable pair):**
- [`0x8386cc9a55a683644f2d6c8524ffc7ccbf499e7908130ae52733f75ef02ff774`](https://basescan.org/tx/0x8386cc9a55a683644f2d6c8524ffc7ccbf499e7908130ae52733f75ef02ff774) — recenter, 50:50 in-range, no swap

**V3 USDC/cbBTC:**
- [`0xbc5195ff039edb77189fed6ab8e23231f92c808204a8ccea778f945d8b27f542`](https://basescan.org/tx/0xbc5195ff039edb77189fed6ab8e23231f92c808204a8ccea778f945d8b27f542) — manual recenter via `/force`
- Autonomous recenter — visible on the agent address's [basescan history](https://basescan.org/address/0x8cf03f65ffC08a514dA09063b5632deC0b11475D); range hysteresis fired unattended overnight

**V4 ETH/USDC (with Alphix dynamic-fee hook):**
- [`0x9e108bd4e7b50bb07b5a3629f50eb2579263ea7fcdaffe5e506bd7899b581dc9`](https://basescan.org/tx/0x9e108bd4e7b50bb07b5a3629f50eb2579263ea7fcdaffe5e506bd7899b581dc9) — V4 hooked-pool recenter

The agent EOA at [`0x8cf03f65ffC08a514dA09063b5632deC0b11475D`](https://basescan.org/address/0x8cf03f65ffC08a514dA09063b5632deC0b11475D) holds the vault's `agent` role and is the only address that has ever moved liquidity through the adapter contracts.

## Future Work

ALPS was built in a hackathon sprint. Here's what a production-grade version would address:

- **Smarter strategies.** Promote `idle`, `cap`, and `vol` from narration-only to real actuators; size range widths from realized volatility; and gate each bundle on expected fee gain vs total cost (today's gas gate only checks the agent can afford the bundle, not that it's net-positive).
- **Security hardening.** Move the agent key from a VM `.env` to a Turnkey-backed signer behind KeeperHub Direct Execution, promote the vault's `owner` role to a Safe multisig, and add per-IP rate limits on top of the existing per-wallet Sherpa caps.
- **Broader protocol support.** Deploy the same vault shape to Arbitrum and Unichain, onboard more pools (stETH/ETH, USDe/USDC, additional V4 hooks), and expose the agent's decision feed as a read-only public endpoint for external LPs to mirror.
- **Additional features.** Sherpa-native natural-language deposits and redeems, position analytics (fee APR, IL, rebalance P&L), and Telegram/Discord/email alerts on rebalances and gas-runway thresholds.

## Team

Built at ETHGlobal OpenAgents 2026 by Carl & Yanis.

**Carl Schmidt** — Business & Product. B.A. Economics & Computer Science (University of Zurich). 7+ years in crypto across product, content, and strategy. Designed early product material for Balancer, published commissioned articles on Starknet, and supported go-to-market for deBridge's Solana expansion.

**Yanis Berkani** — Engineering & Security. B.Sc. Computer Science (EPF Lausanne), M.Sc. Cyber Security (ETH Zurich). 5+ years in DeFi. Lead Smart Contract Developer at Spectra for 3 years, where he built the first permissionless yield derivatives protocol and scaled it to $250M TVL.

## License

MIT
