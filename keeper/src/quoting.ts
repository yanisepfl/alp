// Swap calldata builder. Mirrors ~/alp/agent/src/quoting.ts. Two paths:
//
//   - quoteAndBuildMultiHop: call Uniswap Trading API, get methodParameters,
//     strip the UniversalRouter.execute selector to recover the
//     (commands, inputs, deadline) tuple, return as `extra`.
//   - buildSingleHopV3Swap: encode a UR V3_SWAP_EXACT_IN command directly
//     against a known V3 pool. Used as a fallback when Trading API errors.
//
// The vault's executeSwap forwards `extra` to URAdapter, which decodes it
// and dispatches to UniversalRouter.execute against the URAdapter's own
// contract balance (URAdapter pulls funds from the vault first).

import { encodeAbiParameters, encodePacked, type Address, type Hex } from "viem";

const V3_SWAP_EXACT_IN: Hex = "0x00";
const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";

export interface SwapCalldata {
  amountOut: bigint;
  amountOutMin: bigint;
  extra: Hex;
}

export function buildSingleHopV3Swap(args: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
  expectedAmountOut: bigint;
  slippageBps: number;
  deadlineSeconds: number;
}): SwapCalldata {
  const computed = (args.expectedAmountOut * BigInt(10_000 - args.slippageBps)) / 10_000n;
  const amountOutMin = computed > 0n ? computed : 1n;
  const path = encodePacked(
    ["address", "uint24", "address"],
    [args.tokenIn, args.fee, args.tokenOut],
  );
  const inputs = [
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes" },
        { type: "bool" },
      ],
      [MSG_SENDER, args.amountIn, amountOutMin, path, true],
    ),
  ];
  const extra = encodeAbiParameters(
    [{ type: "bytes" }, { type: "bytes[]" }, { type: "uint256" }],
    [V3_SWAP_EXACT_IN, inputs, BigInt(Math.floor(Date.now() / 1000) + args.deadlineSeconds)],
  );
  return { amountOut: args.expectedAmountOut, amountOutMin, extra };
}

interface TradingApiQuoteResponse {
  quote: { output: { amount: string } };
  methodParameters?: { calldata: Hex; to: Address; value: string };
}

export async function quoteAndBuildMultiHop(args: {
  apiBase: string;
  apiKey?: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
  /** Account that holds tokenIn and will sign the Permit2 grant. For the
   *  ALP keeper this is the vault — URAdapter pulls funds from the vault
   *  and forwards `payerIsUser=true` to UR. The Trading API requires
   *  this field as of 2024+; without it the API rejects with
   *  RequestValidationError ("swapper" is required). */
  swapper: Address;
  /** Final destination of the swap output. Same as `swapper` for the
   *  vault flow — URAdapter forwards the output back to the vault. */
  recipient: Address;
}): Promise<SwapCalldata> {
  const body = {
    type: "EXACT_INPUT",
    tokenInChainId: 8453,
    tokenOutChainId: 8453,
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    amount: args.amountIn.toString(),
    slippageTolerance: (args.slippageBps / 100).toString(),
    swapper: args.swapper,
    recipient: args.recipient,
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (args.apiKey) headers["x-api-key"] = args.apiKey;

  const res = await fetch(`${args.apiBase}/v1/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Trading API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as TradingApiQuoteResponse;
  const amountOut = BigInt(data.quote.output.amount);
  const amountOutMin = (amountOut * BigInt(10_000 - args.slippageBps)) / 10_000n;
  if (!data.methodParameters) throw new Error("Trading API did not return methodParameters");
  // Strip 4-byte function selector from `UniversalRouter.execute(...)` to
  // recover the abi-encoded (commands, inputs, deadline) tuple that the
  // URAdapter expects to receive in `extra`.
  const calldataNoSelector = ("0x" + data.methodParameters.calldata.slice(10)) as Hex;
  return { amountOut, amountOutMin, extra: calldataNoSelector };
}
