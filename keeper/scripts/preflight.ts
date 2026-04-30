// Pre-flight checks before flipping KEEPER_DRY_RUN=false. The VM has no
// `cast` binary, so this script runs the same checks via viem against
// the same drpc URL the keeper uses. Output:
//
//   ✓ derived address matches AGENT_ADDR_EXPECTED
//   ✓ vault.agent() == derived address
//   ✓ signer balance ≥ 0.0005 ETH (gas safety floor)
//   ✓ pending mempool tx count = 0   (or "skipped" if RPC doesn't expose)
//
// Any ✗ → STOP. Don't flip.

import { createPublicClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const VAULT_ADDR = "0x3F0e6cef3a75f52F1E55806Afe40317f51199CaE";
const AGENT_ADDR_EXPECTED = "0x8cf03f65ffC08a514dA09063b5632deC0b11475D";
const GAS_FLOOR_WEI = 500_000_000_000_000n; // 0.0005 ETH

const pk = process.env.AGENT_PRIVATE_KEY!;
const rpc = process.env.BASE_RPC_URL!;
if (!pk || !rpc) {
  console.error("FATAL: AGENT_PRIVATE_KEY and BASE_RPC_URL must be set");
  process.exit(2);
}

const client = createPublicClient({ chain: base, transport: http(rpc) });
const account = privateKeyToAccount(pk as `0x${string}`);

let pass = true;
const line = (mark: string, msg: string) => console.log(`${mark} ${msg}`);

// 1. Derived address vs expected
if (account.address.toLowerCase() === AGENT_ADDR_EXPECTED.toLowerCase()) {
  line("✓", `derived address ${account.address} matches expected agent`);
} else {
  line("✗", `derived address ${account.address} != expected ${AGENT_ADDR_EXPECTED}`);
  pass = false;
}

// 2. vault.agent() == derived
try {
  const onchainAgent = (await client.readContract({
    address: VAULT_ADDR,
    abi: [{ type: "function", name: "agent", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }],
    functionName: "agent",
  })) as `0x${string}`;
  if (onchainAgent.toLowerCase() === account.address.toLowerCase()) {
    line("✓", `vault.agent() == ${onchainAgent} (matches signer)`);
  } else {
    line("✗", `vault.agent() = ${onchainAgent} != signer ${account.address}`);
    pass = false;
  }
} catch (e) {
  line("✗", `vault.agent() read failed: ${(e as Error).message}`);
  pass = false;
}

// 3. Gas balance
try {
  const bal = await client.getBalance({ address: account.address });
  const balEth = formatEther(bal);
  if (bal >= GAS_FLOOR_WEI) {
    line("✓", `signer balance ${balEth} ETH (≥ 0.0005 floor)`);
  } else {
    line("✗", `signer balance ${balEth} ETH < 0.0005 floor`);
    pass = false;
  }
} catch (e) {
  line("✗", `getBalance failed: ${(e as Error).message}`);
  pass = false;
}

// 4. Mempool / pending nonce check. eth_getTransactionCount with "pending"
// vs "latest" — if pending > latest, there are queued txs. drpc supports
// this RPC.
try {
  const latestNonce = await client.getTransactionCount({ address: account.address, blockTag: "latest" });
  const pendingNonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
  if (pendingNonce > latestNonce) {
    line("✗", `pending mempool: ${pendingNonce - latestNonce} unconfirmed tx(s) — pending=${pendingNonce} latest=${latestNonce}`);
    pass = false;
  } else {
    line("✓", `mempool clean (latest nonce = pending nonce = ${latestNonce})`);
  }
} catch (e) {
  line("•", `mempool check skipped: ${(e as Error).message.slice(0, 80)} (not a hard gate)`);
}

console.log();
if (pass) {
  console.log("PRE-FLIGHT: all checks pass. Safe to flip KEEPER_DRY_RUN=false after Carl's go.");
  process.exit(0);
} else {
  console.log("PRE-FLIGHT: FAIL. Do NOT flip.");
  process.exit(1);
}
