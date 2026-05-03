# Uniswap API Feedback

Notes from integrating Uniswap as an API consumer for the ALPS rebalancer. Two API surfaces existed for what we needed: the Trading API for swaps, and the Liquidity API for LP work. We landed on the first one in production and bounced off the second one. Hackathon scope, single VM, Base mainnet only.

## What we used (and didn't)

| Need | API we wanted | What we actually used |
|---|---|---|
| Swap routing for the optional middle leg of a rebalance | Trading API REST `POST /v1/quote` | Trading API REST, exactly as advertised |
| LP mint, burn, range math across V3 and V4 | Liquidity API REST under `/v1/lp/*` | Got 403 on every `/v1/lp/*` path with the same key that worked on `/v1/quote`. Fell back to `@uniswap/v3-sdk` and `@uniswap/v4-sdk` |

The keeper hits the Trading API in [keeper/src/quoting.ts](keeper/src/quoting.ts) and runs all LP math through the SDKs in [keeper/src/uniswapSdk.ts](keeper/src/uniswapSdk.ts).

## Trading API: what worked

* `POST /v1/quote` with an `EXACT_INPUT` body returns a quote plus `methodParameters.calldata` ready to push at the UniversalRouter. One call, multi-hop path discovery included, no router writing on our side.
* Free for our volume. The `apiKey` field is optional in our wiring and we never had to set it for `/v1/quote` itself. Rate limits never bit us during testing or the demo.
* Good split of responsibilities. We encode trivial single-hop V3 swaps locally with `encodePacked` because the path is one line, and use the API for anything that might need multi-hop. The keeper picks the right path automatically based on whether tokenIn and tokenOut share a direct pool.

## Trading API: what was painful

* `methodParameters.calldata` ships with the `execute(bytes,bytes[],uint256)` 4-byte selector still attached. Our adapter wraps UniversalRouter and expects just the inner `(commands, inputs, deadline)` tuple, so we slice the first 10 hex chars off the response in [quoting.ts:88-90](keeper/src/quoting.ts#L88). Workable but it's the kind of off-by-four bug that bites anyone wrapping the router.
* Slippage is a percent string (`"0.50"` for 50 bps). Every other DeFi tool we touch uses bps. We divide by 100 at the boundary in [quoting.ts:71](keeper/src/quoting.ts#L71). Trivial, but every consumer is going to write the same line.
* Round-trip latency to `trade-api.gateway.uniswap.org` is the dominant cost on a fast rebalance, around 200 to 400 ms in our logs. Fine for a 5-minute polling loop, less fine if anyone wanted to actuate per block.
* No way to ask for just the inner tuple, or to ask for the calldata pre-shaped for "I am calling UniversalRouter from another contract". A second response shape that returns the inner tuple would let adapter patterns work without string slicing.

## The Liquidity API problem

This is the part we want to flag clearly, because it's the difference between "Uniswap API integration" being one half of our system and being most of it.

The Liquidity API exists. The endpoints under `/v1/lp/` cover the full LP lifecycle:
- `/v1/lp/quote` — quote a mint/burn/increase
- `/v1/lp/create`, `/v1/lp/increase`, `/v1/lp/decrease` — calldata for the position lifecycle
- `/v1/lp/claim` — fee collection
- `/v1/lp/approve`, `/v1/lp/check_approval` — token approvals

We wired every one of those into a first-pass `keeper/src/uniswapApi.ts`. They all returned **403 Forbidden**. The same API key authed cleanly against `/v1/quote` for swaps in the same session, on the same gateway host, with the same headers. So the gateway recognized the key — the LP paths were entitlement-gated separately, and there was no public docs path or self-serve flow we could find to request that entitlement for a hackathon project on Base mainnet. We tried both `Authorization: Bearer …` and `x-api-key: …` (the docs disagree across pages); same result either way.

After about half a day of header / path / payload variations we pivoted to the SDKs and deleted `uniswapApi.ts`. That's how we ended up with the integration we shipped: Trading API for swaps, SDK for LP. The reasoning at pivot time is still in our internal notes:

> REST endpoints `/v1/lp/{create,increase,decrease,quote,claim,approve,check_approval}` all return 403 with the gateway key. The gateway recognizes the key — it works on `/v1/quote` — but the LP entitlement isn't there. Rather than chase URL/path/key discovery, swap to the official SDKs. They're typed, they cover V3+V4 hooked pools, and they give us calldata for the V3 NPM and V4 PositionManager directly.

The pivot was the right call for the hackathon. But it has two consequences worth naming:

* **The LP integration ships only in TypeScript.** Anyone building LP tooling in Rust, Go, Python or any other language has to either reimplement the SDK math or stand up a Node sidecar. The Trading API works fine from any language because it's REST. LP work does not.
* **Under the prize criteria, our LP work is functionally invisible as "API integration."** Uniswap's prize structure rewards API usage, and we built real LP infrastructure across V3 and V4 (including the Alphix dynamic-fee hook on ETH/USDC). Because the LP REST surface returned 403, all of that lands on the SDK side of the line, not the API side.

What would have unblocked us:

* A self-serve flow to grant LP entitlements on a Trading-API-issued key, or a clearer error than 403 (something like "this key does not have the LP scope, request via X").
* A documentation note on the Liquidity API page stating which keys can hit it and how to upgrade. Right now both the docs and the gateway treat the swap and LP paths as one product, but the entitlement check splits them.
* If the LP API is intentionally gated to specific partners, saying so on the docs page would save anyone else half a day of "is this me, or them?" debugging.

A working `POST /v1/lp/quote` shaped exactly like the Trading API — pool key, tick range, available amounts, returning optimal `(amount0, amount1)` plus slippage-floored mins plus ready-to-use calldata for the V3 NPM or V4 PositionManager — would let LP tooling get built the same way swap tooling already does. From what we saw, the surface is already designed that way. We just couldn't reach it.

## Smaller things on the Trading API

* The `swapper` and `recipient` fields work as expected. We pass our vault address as both, since the rebalance does the swap from vault custody and keeps the output there.
* `EXACT_INPUT` is the right default for our use case. We have a known input amount (the asymmetric leftover from the `remove`) and we want as much of the other token as the router can find.
* Errors come back as plain text bodies with a meaningful HTTP status. We surface the first 200 chars in our error message in [quoting.ts:83](keeper/src/quoting.ts#L83). Could not ask for less ceremony there.

## Hackathon caveats

* We never used `@uniswap/router-sdk` directly. Trading API is the path of least resistance for one swap per rebalance.
* We are stuck on `@uniswap/v4-sdk` for V4 work because of the Liquidity API gating. If LP entitlements ever open up (or the API moves to the same "key just works" model the Trading API has), we'd switch over for the same reasons we use the Trading API for swaps.
