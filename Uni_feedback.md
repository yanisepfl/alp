# Uniswap API Feedback

## Context

ALPS is an autonomous concentrated-liquidity vault on Base. The keeper rebalances V3 and V4 positions every 5 minutes; **swap routing goes through the Uniswap Trading API**, **all LP math goes through the V3/V4 SDKs**. Three real on-chain bundles linked from the README, including one V4 ETH/USDC bundle under the Alphix dynamic-fee hook.

- **Trading API surface used:** `POST /v1/quote` only — we use the legacy auto-router response that returns `methodParameters.calldata` alongside the quote, and skip `/v1/swap`.
- **SDKs:** `@uniswap/v3-sdk`, `@uniswap/v4-sdk`, `@uniswap/sdk-core`.
- **Code:** [keeper/src/quoting.ts](keeper/src/quoting.ts), [keeper/src/uniswapSdk.ts](keeper/src/uniswapSdk.ts).

## What worked well

- **Multi-hop routing in one call.** `/v1/quote` returns a quote plus ready-to-execute UniversalRouter calldata. The API key is optional for our usage; we never hit rate limits in testing or during the demo.
- **`swapper` / `recipient` separation works as advertised.** We pass the vault address for both, since the rebalance swaps from vault custody and keeps the output there.
- **Errors are plain text with meaningful HTTP status.** Surfaced verbatim in keeper logs ([quoting.ts:83](keeper/src/quoting.ts#L83)) — no JSON-error ceremony to parse.
- **V4 hooks are first-class in `@uniswap/v4-sdk`.** `new V4Pool(c0, c1, fee, tickSpacing, hooksAddress, ...)` at [uniswapSdk.ts:167](keeper/src/uniswapSdk.ts#L167) lets us reason about ETH/USDC under the Alphix dynamic-fee hook without the SDK treating the hook as opaque.

## Issues encountered

### 1. `/v1/quote`'s calldata response is undocumented in the new docs

**Problem:** The keeper depends on `methodParameters.calldata` in the `/v1/quote` response. The current `/api-reference/swapping/quote` page describes only routing and pricing fields. The embedded calldata is legacy auto-router behavior that the gateway still honors but no longer documents.

**Workaround:** Accept the risk — keep using the field knowing it could change without notice.

**Suggestion:** Either re-document it as the canonical adapter fast-path or sunset it loudly with a deprecation date. Right now it's undocumented production surface area that silently breaks every adapter-pattern integration if it changes.

### 2. Calldata ships with the `execute(...)` selector pre-attached

**Problem:** Adapter contracts wrapping UniversalRouter need the inner `(commands, inputs, deadline)` tuple, not the full `execute(bytes,bytes[],uint256)` ABI call.

**Workaround:** Strip the first 4 bytes (10 hex chars) at [quoting.ts:88-90](keeper/src/quoting.ts#L88).

**Suggestion:** Add a `wrapForAdapter: true` request flag returning the inner tuple — same shape on `/v1/quote` and `/v1/liquidity_provisioning/create_position`.

### 3. Slippage tolerance is a percent string

**Problem:** `slippageTolerance: "0.50"` for 50 bps. Every other DeFi tool we touch uses bps.

**Workaround:** Divide by 100 at the boundary ([quoting.ts:71](keeper/src/quoting.ts#L71)).

**Suggestion:** Accept bps as an alternate unit.

### 4. The two-step `/quote → /swap` flow is EOA-shaped, not adapter-shaped

**Problem:** The documented flow assumes an EOA that signs Permit2 typed data, then calls `/v1/swap` to compose the final `TransactionRequest`. Our `URAdapter` is a contract that does Permit2 on-chain — pre-approves Permit2 max once per token at [UniversalRouterAdapter.sol:235](contracts/src/adapters/UniversalRouterAdapter.sol#L235), then calls `permit2.approve(token, router, amount, deadline)` before each swap at [line 125](contracts/src/adapters/UniversalRouterAdapter.sol#L125). No signature, no `from` field, no need for `/v1/swap` to compose anything.

**Workaround:** Use `/v1/quote`'s legacy auto-router calldata and skip `/v1/swap` entirely.

**Suggestion:** Document the contract-mode path explicitly. Adapter patterns (vaults, intent solvers, batchers) are increasingly common; the current docs treat them as second-class.

## Why SDKs for LP, not `/v1/liquidity_provisioning/*`

The LP REST surface exists. We chose the SDKs:

- **Determinism in the hot path.** Mint sizing has to be byte-exact on-chain to avoid `MaxAllocationExceeded` reverts. The SDKs reproduce `Position.fromAmounts` against live `slot0` in-process, no network failure mode.
- **V4 hooks first-class.** Same `V4Pool(..., hooksAddress)` reason as above.
- **Adapter custody.** The vault holds the LP NFT (V3) or position (V4) end-to-end via `UniV3Adapter` / `UniV4Adapter`; we need raw mint params, not signer-shaped `TransactionRequest` objects.

Same `wrapForAdapter` ask applies — a contract-mode response on the LP REST surface would let the vault-keeper pattern use it.

## Summary

The Trading API carried the swap path for us cleanly — `/v1/quote` is doing real work, and three V3 + V4 mainnet rebalance bundles landed unattended on it. Most of the friction we hit comes from one observation: the documented flow is shaped for EOA wallets, and our vault is a contract handling Permit2 directly through the adapter. Anything that nudged the API toward first-class support for the contract/adapter pattern (a `wrapForAdapter` flag, or clearer status on the legacy `methodParameters` field on `/v1/quote`) would have made the integration smoother. Hackathon scope, single integration; sharing it in case any of it is useful.
