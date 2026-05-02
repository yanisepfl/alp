# ALP — Automated Liquidity Provisioner

> A single-deposit USDC vault on Base mainnet running a diversified basket of concentrated-liquidity positions across Uniswap V3 + V4, rebalanced by an off-chain decision engine and orchestrated by KeeperHub.

## The Problem

Concentrated liquidity captures dramatically more fees than full-range positions, but only while the position is in range. Most depositors deposit and forget — and roughly half of their positions drift out of range within days, earning nothing while exposure compounds. Active range management is a 24/7 job: it requires watching ticks across multiple pools, judging whether drift is mean-reverting, paying gas for re-centers, and avoiding whipsaw rebalances. Almost no LP wants to do this work, and very few are good at it. ALP turns that work into a passive USDC deposit.

## The Solution

1. **Single USDC deposit, diversified basket.** Depositors deposit USDC into a single ERC4626 vault. The vault holds concentrated-liquidity NFTs across multiple Uniswap V3 + V4 pools (USDC/USDT, USDC/cbBTC, ETH/USDC) and accrues fees back to the share price. One token, one decision — the vault is the only thing the user touches.
2. **Off-chain decision engine, on-chain actuator.** A keeper service runs a 5-policy decision engine every 5 minutes: range drift, anti-whipsaw cooldowns, realized volatility, idle reserve, and cap-pressure are evaluated on every tick. Each policy emits real-signal narration into a chat surface. When a rebalance is warranted, the keeper signs as the vault's `agent` role and routes a `remove → maybe-swap → add` bundle through whitelisted adapter contracts.
3. **KeeperHub as the orchestration plane.** Three KeeperHub workflows drive the loop: a polling workflow hydrates the brain with fresh chain context (TVL, pool roster, agent gas, live L2 gas price) every 5 minutes and gates rebalances on a dynamic gas floor; a reactive workflow listens for `vault.LiquidityAdded` events and audits the post-rebalance basket via Multicall3 + a math/aggregate node; a Manual-trigger workflow is the operator override for demos and on-call. KeeperHub is the data plane between Base and the brain — not a glorified cron.

## Architecture

```
        ┌────────────────────────────────────────────────────────────┐
        │  KeeperHub (app.keeperhub.com)                             │
        │  ┌─────────────────┐ ┌──────────────────┐ ┌─────────────┐  │
        │  │ alp-rebalance   │ │ alp-post-        │ │ alp-demo-   │  │
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
                ┌────────────────────────────────────────┐
                │  Keeper (Bun + Hono, TypeScript)       │
                │  • 5-policy decision engine            │
                │  • Per-kind Claude narrator            │
                │  • Uniswap V3 + V4 SDK consultation    │
                │  • Anti-whipsaw cooldowns (sqlite)     │
                │  • viem signs as vault.agent()         │
                └─────────┬──────────────────────────────┘
                          │ vault.execute{Remove,Swap,Add}Liquidity
                          ▼
                ┌────────────────────────────────────────┐
                │  ALPVault (ERC4626) on Base            │
                │  → UniV3Adapter / UniV4Adapter / UR    │
                │  → Uniswap V3 NPM + V4 PositionManager │
                └─────────┬──────────────────────────────┘
                          │ events
                          ▼
                ┌────────────────────────────────────────┐
                │  Backend (Bun + Hono + sqlite)         │
                │  • WSS multiplexer (vault/user/agent)  │
                │  • Indexer auto-folds chain events     │
                │  • Sherpa: claude -p chat surface      │
                └─────────┬──────────────────────────────┘
                          │ ws://…/stream
                          ▼
                ┌────────────────────────────────────────┐
                │  Next.js 15 dashboard                  │
                │  • Reown AppKit + wagmi + viem         │
                │  • Live agent feed + Sherpa chat       │
                └────────────────────────────────────────┘
```

The keeper, backend, and KeeperHub workflows are independently deployable but speak well-defined contracts. The keeper exposes `/scan` (polling tick), `/post-rebalance` (reactive audit), `/force` (operator override), and `/log-tick` (workflow outcome log) — all bearer-authed. The backend exposes `/ingest/signal` for narration. KeeperHub talks to the keeper over HTTPS via a Cloudflare Tunnel.

## The Rebalance Flow

1. **KeeperHub `alp-rebalance` fires.** Every 5 minutes the Schedule trigger fans out four chain reads from KeeperHub itself: `vault.totalAssets()` (TVL), `vault.getActivePools()` (pool roster), the agent's ETH balance, and the L2 gas-price oracle on Base.
2. **Dynamic gas gate.** A Condition node short-circuits to a log-only branch when the agent's ETH won't cover ≥2 rebalance bundles at the current L2 gas price (floor scales with congestion, no hardcoded number). Otherwise the workflow proceeds.
3. **KeeperHub POSTs to `/scan` with pre-flight context.** The HTTP node composes a body via KeeperHub's template syntax (`{{@nodeId:Label.field}}`) carrying the four chain reads. The keeper cross-checks KH-supplied TVL against its own observation and narrates the comparison — KH's reads are load-bearing, not decorative.
4. **Keeper runs the 5-policy engine.** The keeper observes its tracked positions, then runs all five policies (range, anti-whipsaw, vol, idle, cap). Each emits a `Candidate` with a priority and a reasoning string. The engine picks the highest-priority actuating Candidate; if none, it rotates among non-actuators so the agent feed reads as varied. Per-kind Claude prompts polish each entry (4-5 word actions, ≤15 word thoughts, ~10 word signals).
5. **Actuation through vault adapters.** When the chosen Decision is `rebalance`, the keeper consults the Uniswap V3 + V4 SDK (`Position.fromAmounts`, `mintAmountsWithSlippage`) for optimal mint params, then signs `vault.executeRemoveLiquidity → maybe-swap → executeAddLiquidity` with viem. The vault routes through whitelisted adapter contracts to the V3 NonfungiblePositionManager / V4 PositionManager.
6. **Workflow logs the outcome.** A second Condition branches on the keeper's response. Both branches POST to `/log-tick` with structured outcome (`fired` or `held`) so the dashboard's run history pairs each tick with a narrated agent-feed entry.
7. **`alp-post-rebalance` audits the chain.** A separate workflow's Blockchain Event trigger detects `vault.LiquidityAdded` on Base within ~8 seconds. It reads `vault.poolValueExternal()` for all three pools in a single Multicall3 call (`web3/batch-read-contract`), sums the deployed total in-workflow with `math/aggregate`, then POSTs the basket-wide audit to the keeper. KeeperHub provides a second pair of eyes on every actuation.
8. **`alp-demo-rebalance` is the operator override.** A Manual-trigger workflow that fires `/force?pool=<key>` against the keeper, bypassing anti-whipsaw cooldowns. Used in the demo recording's scene 4 to land a live rebalance on cue.

The Uniswap Trading API at `trade-api.gateway.uniswap.org` provides multi-hop quoting for the optional middle-leg swap when a rebalance returns asymmetric amounts. Single-hop direct routing is the fallback if the API errors.

## Security Model

The keeper signs with a hot key and runs from a single VM. The vault's contracts enforce every safety bound that matters.

| Layer | What it blocks | How |
|---|---|---|
| Vault `agent` role | Unauthorized actuation by any other key | `onlyAgent` modifier on `executeRemoveLiquidity` / `executeAddLiquidity` / `executeSwap` |
| Pool whitelist | Rebalances into rogue pools | `PoolRegistry.isPoolKnown(key)` checked on every execute |
| Slippage caps | MEV / sandwich loss on swap and mint | `amount0Min` / `amount1Min` enforced by adapter; tolerances pulled from tested defaults (50 bps swap, 100 bps liquidity) |
| Pre-flight simulation | Bad inputs on the REMOVE step | viem `simulateContract` surfaces vault custom errors before signing; SWAP and ADD skip simulation to avoid the eventual-consistency window between two writes |

> Even with a fully compromised agent key, the worst an attacker can do is rebalance vault positions within whitelisted pools at slippage tolerances the adapter enforces — the agent cannot withdraw to an external address, change the pool whitelist, or transfer the vault's underlying USDC.

*Hackathon caveats:* the agent key is held in a `.env` on the VM rather than a hardware-backed signer or KeeperHub Direct Execution / Turnkey wallet. The Cloudflare Tunnel exposing the keeper to KeeperHub is an ephemeral quick-tunnel; a production deployment would use a named tunnel with a stable subdomain. The `cap` policy emits real-signal narration but does not actuate redistribution — full cross-pool USD valuation is v2 work.

## Uniswap Stack Integration

Three distinct Uniswap developer surfaces are exercised on every rebalance.

| Component | Usage |
|---|---|
| `@uniswap/v3-sdk` | `Pool` and `Position` entities for V3 mint/burn math; `mintAmountsWithSlippage` and `burnAmountsWithSlippage` to compute the slippage floors fed into vault adapter calls. |
| `@uniswap/v4-sdk` | V4 hooked-pool entities including the Alphix dynamic-fee hook on ETH/USDC; `Position.fromAmounts` for optimal mint sizing under V4's exact-input semantics. |
| `@uniswap/sdk-core` | `Token`, `Ether`, `Currency`, `Percent` primitives shared across V3 and V4 paths; consistent decimal handling between USDC (6), cbBTC (8), and ETH (18). |
| Trading API REST (`trade-api.gateway.uniswap.org`) | Multi-hop quoting via `/quote`; calldata via `/swap` for the optional middle-leg swap when a rebalance returns asymmetric amounts. |
| V3 NonfungiblePositionManager | Target of `UniV3Adapter` for V3 mint, burn, and fee collection on whitelisted V3 pools. |
| V4 PositionManager | Target of `UniV4Adapter` for V4 hooked-pool position management; consumes `modifyLiquidities` action-encoded calldata composed locally. |
| Uniswap V4 hook (Alphix `0x7cBbf…9044`) | The ETH/USDC pool ALP rebalances is a V4 dynamic-fee pool with our hook — the integration exercises real V4 hooked-pool LP, not just the canonical V4 flow. |

## Deployed Contracts

| Contract | Chain | Address |
|---|---|---|
| ALPVault (ERC4626) | Base mainnet | [`0x3F0e6cef3a75f52F1E55806Afe40317f51199CaE`](https://basescan.org/address/0x3F0e6cef3a75f52F1E55806Afe40317f51199CaE) |
| PoolRegistry | Base mainnet | [`0x6911dC2e50C4D89f244aB9D65E89A847Beee1634`](https://basescan.org/address/0x6911dC2e50C4D89f244aB9D65E89A847Beee1634) |
| UniV3Adapter | Base mainnet | [`0x145Deaf02fDd2F56630DC64afFbd4bdDf36A3D79`](https://basescan.org/address/0x145Deaf02fDd2F56630DC64afFbd4bdDf36A3D79) |
| UniV4Adapter | Base mainnet | [`0xB6871C8cd995fF015DBa7373b371426E80cBBCF0`](https://basescan.org/address/0xB6871C8cd995fF015DBa7373b371426E80cBBCF0) |
| UniversalRouterAdapter | Base mainnet | [`0x6BeE052D58Ba95bae9fd23d81a2B96145095a962`](https://basescan.org/address/0x6BeE052D58Ba95bae9fd23d81a2B96145095a962) |

## Project Structure

```
alp/
├── keeper/              # The brain. Bun + Hono. 5-policy engine, Claude narrator,
│                        # Uniswap SDK consultation, viem-signed actuation.
├── agent/               # Original keeper (Cloudflare Worker reference) + KeeperHub
│   └── keeperhub-workflows/   # alp-{rebalance,post-rebalance,demo-rebalance}.live.json
├── backend/             # WSS multiplexer, sqlite indexer, Sherpa chat surface.
├── frontend/            # Next.js 15 dashboard. Reown AppKit + wagmi + viem.
├── contracts/           # Foundry workspace. ALPVault, PoolRegistry, adapters.
└── scripts/             # Local dev helpers (fork, bootstrap, seed).
```

## Try It Live

Open the deployed frontend (or run locally per the next section), connect a Base-mainnet wallet, and deposit any USDC amount. The KeeperHub workflows are publicly visible in the dashboard at [app.keeperhub.com](https://app.keeperhub.com) under the `alp-rebalance` and `alp-post-rebalance` workflows.

## Local Setup

**Prerequisites:**
- [Bun](https://bun.sh) ≥ 1.3 (keeper + backend)
- [Node.js](https://nodejs.org) 20 + npm (frontend)
- [Foundry](https://book.getfoundry.sh) (contracts)
- A Base-mainnet RPC URL (Alchemy recommended; drpc as fallback)
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
cp .env.example .env  # fill AGENT_PRIVATE_KEY, BASE_RPC_URL, KEEPER_INBOUND_BEARER, INGEST_SECRET
bun run typecheck
bun run src/index.ts  # listens on :8788
```

### Backend

```bash
cd backend
bun install
cp .env.example .env  # fill BASE_RPC_URL, VAULT_ADDRESS, INGEST_SECRET,
                      # WS_ALLOWED_ORIGINS (comma-separated; supports *.vercel.app)
bun run src/index.ts  # listens on :8787
```

### Frontend

```bash
cd frontend
npm install
cp .env.local.example .env.local  # NEXT_PUBLIC_REOWN_PROJECT_ID, NEXT_PUBLIC_VAULT_ADDRESS,
                                  # NEXT_PUBLIC_SHERPA_WSS_URL=ws://<backend-host>:8787/stream
npm run dev  # http://localhost:3000
```

## On-Chain Proof

The keeper has executed real rebalances across all three live pools. Each rebalance is a multi-step bundle with a `LiquidityRemoved` and `LiquidityAdded` event pair (plus an optional `Swapped` middle leg).

**V3 USDC/USDT (stable pair):**
- Rebalance: [`0x8386cc9a55a683644f2d6c8524ffc7ccbf499e7908130ae52733f75ef02ff774`](https://basescan.org/tx/0x8386cc9a55a683644f2d6c8524ffc7ccbf499e7908130ae52733f75ef02ff774)

**V3 USDC/cbBTC (manual + autonomous):**
- Manual rebalance: [`0xbc5195ff039edb77189fed6ab8e23231f92c808204a8ccea778f945d8b27f542`](https://basescan.org/tx/0xbc5195ff039edb77189fed6ab8e23231f92c808204a8ccea778f945d8b27f542)
- Autonomous rebalance (range hysteresis fired unattended overnight): [tx visible on the agent address's basescan history](https://basescan.org/address/0x8cf03f65ffC08a514dA09063b5632deC0b11475D)

**V4 ETH/USDC (with Alphix dynamic-fee hook):**
- Rebalance: [`0x9e108bd4e7b50bb07b5a3629f50eb2579263ea7fcdaffe5e506bd7899b581dc9`](https://basescan.org/tx/0x9e108bd4e7b50bb07b5a3629f50eb2579263ea7fcdaffe5e506bd7899b581dc9)

The agent EOA at [`0x8cf03f65ffC08a514dA09063b5632deC0b11475D`](https://basescan.org/address/0x8cf03f65ffC08a514dA09063b5632deC0b11475D) owns the `agent` role on the vault and is the only address that has ever moved liquidity through the adapter contracts.

## Future Work

The hackathon scope was deliberately narrowed to ship a defensible decision engine + dual-track integration. Several pieces are designed-for but not actuated.

### Smarter Strategies

- **Full 5-policy actuation.** Idle, cap, and vol policies emit real-signal narration today but do not actuate. v2 wires `idle` to a `deploy_idle` actuator that tops up the pool with the most cap headroom; `cap` to a `redistribute` actuator when one pool exceeds its allocation; `vol` to advisory width adjustments on the next rebalance.
- **Cross-pool USD valuation.** All pools currently have a 100% cap (TAV is denominated in USDC, but multi-asset pool valuations are approximate). v2 introduces a spot-pricing layer (Chainlink + Uniswap TWAP) so cap pressure is enforced precisely.
- **Subgraph-driven volatility.** The `vol` policy currently buffers 12 chain ticks before emitting recommendations. v2 reads Uniswap's GraphQL subgraph for historical pool tick/price data, eliminating the warm-up window and enabling longer-horizon vol estimates.
- **Anti-whipsaw on EV.** Today's anti-whipsaw is a fixed time cooldown. v2 gates rebalances on expected-value: if the gas-adjusted EV of recentering is negative, the keeper holds even after cooldown lifts.

### Security Hardening

- **Hardware-backed signer.** Move the agent key from a VM `.env` to a Turnkey wallet, and use KeeperHub's Direct Execution path so transactions are signed by KeeperHub's signing layer rather than a local hot key.
- **Named tunnel.** Replace the ephemeral Cloudflare quick-tunnel with a named tunnel + stable subdomain backed by a Cloudflare account, so the KeeperHub workflow URLs are stable across keeper restarts.
- **Multi-sig vault owner.** The vault `owner` role (separate from `agent`) is currently a single key. v2 makes it a Safe multisig so guardian and pool-whitelist changes require co-signature.
- **Rotation discipline.** Document a runbook for rotating `KEEPER_INBOUND_BEARER`, `INGEST_SECRET`, and the `kh_…` API key on a regular cadence.

### Broader Protocol

- **More chains.** ALPVault is Base-only today. The vault contract is chain-agnostic; v2 deploys the same shape to Arbitrum and Unichain, with KeeperHub Schedule + Event triggers spanning all three.
- **More pools.** Add stETH/ETH, USDe/USDC, and additional Uniswap V4 hooked pools as they launch on Base. The PoolRegistry already supports cap-bps per pool; the keeper's policy stack already iterates registry membership at boot.

### Additional Features

- **Sherpa-native deposits.** Let depositors execute deposits / redeems via natural language in the Sherpa chat surface (an LLM tool layer over the existing wagmi write paths). Keeps the single-deposit ergonomics while removing one wallet-click for power users.
- **Real-time fee accrual surface.** The frontend currently shows TAV and per-pool allocations; v2 surfaces estimated-fee-per-second per position so depositors see fees ticking in real time during the demo.
- **Advisory mode.** Expose the keeper's decision feed as a public read-only endpoint so external LPs can mirror its signals without depositing into the vault.

## Team

Built for ETHGlobal OpenAgents by the Alphix team.

**Carl Lerhinox** — backend + frontend lead. Built the keeper service, KeeperHub workflow integration, and the Sherpa chat surface. Background in trading systems and DeFi infrastructure.

**Yanis Pellet** — contracts + initial keeper. Designed the vault, PoolRegistry, and adapter contracts. Built the original Cloudflare Worker keeper that the current Bun service was evolved from. Background in EVM research and protocol engineering.

## License

MIT.
