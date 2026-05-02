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

/** Multi-hop swap calldata via Uniswap's Trading API. Returns the
 *  abi-encoded (commands, inputs, deadline) tuple URAdapter forwards
 *  to UniversalRouter.execute. */
export async function quoteAndBuildMultiHop(args: {
  apiBase: string;
  apiKey?: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
  swapper: Address;
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
  // Strip the 4-byte UniversalRouter.execute selector to recover the
  // (commands, inputs, deadline) tuple URAdapter expects in `extra`.
  const calldataNoSelector = ("0x" + data.methodParameters.calldata.slice(10)) as Hex;
  return { amountOut, amountOutMin, extra: calldataNoSelector };
}
