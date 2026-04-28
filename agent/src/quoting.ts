import { encodeAbiParameters, encodePacked, type Address, type Hex } from "viem";

/** Universal Router command bytes. */
const V3_SWAP_EXACT_IN: Hex = "0x00";
/** Reserved UR recipient address that maps to msg.sender (= our adapter). */
const MSG_SENDER: Address = "0x0000000000000000000000000000000000000001";

export interface SwapCalldata {
  amountOut: bigint;
  amountOutMin: bigint;
  /** Encoded `bytes` payload for `vault.executeSwap(extra)` — exactly what
   *  `UniversalRouterAdapter.swapExactIn` expects. */
  extra: Hex;
}

/** Build the calldata for a single-hop V3 swap through the Universal Router.
 *
 *  We don't call the Uniswap Trading API for single-hop quotes because the
 *  on-chain V3 pool already gives us the exact spot price. For multi-hop we
 *  call the API (see `quoteAndBuildMultiHop` below).
 */
export function buildSingleHopV3Swap(args: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: bigint;
  expectedAmountOut: bigint;
  slippageBps: number;
  deadlineSeconds: number;
}): SwapCalldata {
  // Vault rejects amountOutMin = 0 (SlippageMinRequired). When the caller
  // hasn't supplied a real expected-out (passes 1n as sentinel), floor at 1
  // so the vault accepts and the URAdapter's balance-delta assertion enforces
  // the actual safety. Real quotes get the proper percentage haircut.
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

/** Trading API quote response shape (subset we read).
 *  See https://docs.uniswap.org/api/trading
 */
interface TradingApiQuoteResponse {
  quote: {
    output: { amount: string };
  };
  permitData?: unknown; // unused: adapter manages its own Permit2 grants
  methodParameters?: { calldata: Hex; to: Address; value: string };
}

/** Call the Uniswap Trading API to quote + build a multi-hop swap.
 *
 *  Falls back to throwing if the API returns no methodParameters. The agent
 *  catches that and decides whether to skip or use the single-hop fallback.
 */
export async function quoteAndBuildMultiHop(args: {
  apiBase: string;
  apiKey?: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
  recipient: Address;
}): Promise<SwapCalldata> {
  const body = {
    type: "EXACT_INPUT",
    tokenInChainId: 8453,
    tokenOutChainId: 8453,
    tokenIn: args.tokenIn,
    tokenOut: args.tokenOut,
    amount: args.amountIn.toString(),
    slippageTolerance: (args.slippageBps / 100).toString(), // API takes percentage
    recipient: args.recipient,
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (args.apiKey) headers["x-api-key"] = args.apiKey;

  const res = await fetch(`${args.apiBase}/v1/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Trading API ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as TradingApiQuoteResponse;

  const amountOut = BigInt(data.quote.output.amount);
  const amountOutMin = (amountOut * BigInt(10_000 - args.slippageBps)) / 10_000n;

  // The Trading API's methodParameters.calldata is a UniversalRouter.execute
  // call: function selector + abi.encode(commands, inputs, deadline). We
  // strip the selector (4 bytes) to recover (commands, inputs, deadline) for
  // re-encoding into the adapter's `extra` payload.
  if (!data.methodParameters) throw new Error("Trading API did not return methodParameters");
  const calldataNoSelector = ("0x" + data.methodParameters.calldata.slice(10)) as Hex;
  return { amountOut, amountOutMin, extra: calldataNoSelector };
}
