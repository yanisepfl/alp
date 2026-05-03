# Uniswap API Feedback

Notes from integrating Uniswap as an API consumer for the ALP rebalancer. Two API surfaces exist for what we needed: the Trading API for swaps, and (as we found out) nothing public for LP. Hackathon scope, single VM, Base mainnet only.

## What we used (and didn't)

| Need | API we wanted | What we actually used |
|---|---|---|
| Swap routing for the optional middle leg of a rebalance | Trading API REST `POST /v1/quote` | Trading API REST, exactly as advertised |
| LP mint, burn, range math across V3 and V4 | An equivalent LP API | Did not exist. We had to use `@uniswap/v3-sdk` and `@uniswap/v4-sdk` instead |

The keeper hits the Trading API in [keeper/src/quoting.ts](keeper/src/quoting.ts) and falls back to the SDKs for everything LP-shaped in [keeper/src/uniswapSdk.ts](keeper/src/uniswapSdk.ts).

## Trading API: what worked

* `POST /v1/quote` with an `EXACT_INPUT` body returns a quote plus `methodParameters.calldata` ready to push at the UniversalRouter. One call, multi-hop path discovery included, no router writing on our side.
* Free for our volume. The `apiKey` field is optional in our wiring and we never had to set it. Rate limits never bit us during testing or the demo.
* Good split of responsibilities. We encode trivial single-hop V3 swaps locally with `encodePacked` because the path is one line, and use the API for anything that might need multi-hop. The keeper picks the right path automatically based on whether tokenIn and tokenOut share a direct pool.

## Trading API: what was painful

* `methodParameters.calldata` ships with the `execute(bytes,bytes[],uint256)` 4-byte selector still attached. Our adapter wraps UniversalRouter and expects just the inner `(commands, inputs, deadline)` tuple, so we slice the first 10 hex chars off the response in [quoting.ts:88-90](keeper/src/quoting.ts#L88). Workable but it's the kind of off-by-four bug that bites anyone wrapping the router.
* Slippage is a percent string (`"0.50"` for 50 bps). Every other DeFi tool we touch uses bps. We divide by 100 at the boundary in [quoting.ts:71](keeper/src/quoting.ts#L71). Trivial, but every consumer is going to write the same line.
* Round-trip latency to `trade-api.gateway.uniswap.org` is the dominant cost on a fast rebalance, around 200 to 400 ms in our logs. Fine for a 5-minute polling loop, less fine if anyone wanted to actuate per block.
* No way to ask for just the inner tuple, or to ask for the calldata pre-shaped for "I am calling UniversalRouter from another contract". A second response shape that returns the inner tuple would let adapter patterns work without string slicing.

## The LP API gap

This is the part we want to flag clearly.

The Trading API exists for swaps. Nothing equivalent exists for LP. If you want to mint, burn, or range-manage a position with optimal token splits, slippage floors, and tick math, your only choices are:

1. The TypeScript SDKs (`@uniswap/v3-sdk`, `@uniswap/v4-sdk`)
2. The smart contracts directly, with your own math

We went with option 1 because writing a full LP math layer for both V3 and V4 (V4 with hooks) was outside scope. The result is that our LP integration, which is most of the Uniswap-shaped code we wrote, runs through the SDKs.

That has two consequences worth naming:

* **The integration only ships in TypeScript.** Anyone building LP tooling in Rust, Go, Python, or any other language has to either reimplement the SDK math or stand up a Node sidecar. The Trading API works fine from any language. LP work does not.
* **It does not count as API integration.** Uniswap's prize structure rewards API usage. The SDK is not the API. We built real LP infrastructure against three pools across V3 and V4 including the Alphix dynamic-fee hook on ETH/USDC, but under the prize criteria that work is invisible because no public LP API exists for us to hit.

A `POST /v1/lp/quote` shaped like the Trading API, taking a pool key, a tick range, and available amounts, returning the optimal `(amount0, amount1)`, the slippage-floored mins, and ready-to-use calldata for the V3 NPM or V4 PositionManager, would let LP tooling get built the same way swap tooling already does. It would also let a project like ours show up under the same banner as the swap projects, instead of being functionally an SDK consumer.

## Smaller things on the Trading API

* The `swapper` and `recipient` fields work as expected. We pass our vault address as both, since the rebalance does the swap from vault custody and keeps the output there.
* `EXACT_INPUT` is the right default for our use case. We have a known input amount (the asymmetric leftover from the `remove`) and we want as much of the other token as the router can find.
* Errors come back as plain text bodies with a meaningful HTTP status. We surface the first 200 chars in our error message in [quoting.ts:83](keeper/src/quoting.ts#L83). Could not ask for less ceremony there.

## Hackathon caveats

* We never used `@uniswap/router-sdk` directly. Trading API is the path of least resistance for one swap per rebalance.
* We are stuck on `@uniswap/v4-sdk` for V4 work because of the LP API gap above. If a V4 LP API ever lands, we'd switch over for the same reasons we use the Trading API for swaps.
