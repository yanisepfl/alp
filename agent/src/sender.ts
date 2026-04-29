/** Tx-sending abstraction: lets the executor land vault calls via either
 *  viem (local hot key) or KeeperHub's Direct Execution API (KH Turnkey
 *  wallet). Both paths return a tx hash + revert if the receipt failed.
 *
 *  Switching via env var KEEPERHUB_DIRECT_EXEC=true is the qualifying
 *  Best-Integration depth: every rebalance tx (remove + swap + add) lands
 *  with KH's Turnkey EOA as msg.sender; our worker no longer needs
 *  AGENT_PRIVATE_KEY for production. The KH wallet must hold the vault's
 *  `agent` role first — the setup script handles that.
 */

import type { Abi, Address, Hex, PublicClient, WalletClient } from "viem";
import { encodeFunctionData } from "viem";
import { KeeperHubClient } from "./keeperhub.js";

export interface SendCallParams {
  /** Vault (or any callable) address. */
  to: Address;
  /** ABI fragment matching `functionName`. */
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  /** msg.value in wei (for native-ETH paths). */
  value?: bigint;
  /** Gas limit override; senders may use this as-is or as a hint. */
  gas?: bigint;
  /** Optional debug label routed to KH's execution metadata + local logs. */
  label?: string;
}

export interface TxSender {
  /** Lands the call. Returns the on-chain tx hash. Reverts (throws) on
   *  receipt failure or KH execution failure — caller doesn't need to
   *  re-check status. */
  sendCall(params: SendCallParams): Promise<Hex>;
}

/** Local viem signer using AGENT_PRIVATE_KEY. Existing default. */
export class ViemSender implements TxSender {
  constructor(
    private publicClient: PublicClient,
    private walletClient: WalletClient,
    private account: Address,
  ) {}

  async sendCall(p: SendCallParams): Promise<Hex> {
    const hash = await this.walletClient.writeContract({
      account: this.account,
      chain: null,
      address: p.to,
      abi: p.abi,
      functionName: p.functionName,
      args: p.args as readonly unknown[],
      value: p.value,
      gas: p.gas,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`${p.label ?? p.functionName} reverted (tx ${hash})`);
    }
    return hash;
  }
}

/** KeeperHub Direct Execution sender — KH's Turnkey wallet signs and lands. */
export class KeeperHubSender implements TxSender {
  constructor(private kh: KeeperHubClient) {}

  async sendCall(p: SendCallParams): Promise<Hex> {
    // We send both calldata and the structured (functionName, args, abi)
    // form. KH's API accepts the structured form per docs; calldata is a
    // future-proof pre-encode in case they switch to raw-data mode.
    void encodeFunctionData({ abi: p.abi, functionName: p.functionName, args: p.args as readonly unknown[] });
    const result = await this.kh.sendAndWait({
      contractAddress: p.to,
      functionName: p.functionName,
      // KH spec: functionArgs is a JSON-encoded string, not an array.
      functionArgs: JSON.stringify(p.args, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      // Same for ABI — encode as JSON string. We narrow to the matching
      // function to keep the payload small.
      abi: JSON.stringify((p.abi as readonly unknown[]).filter(
        (e) => typeof e === "object" && e !== null && (e as { name?: string }).name === p.functionName
      )),
      value: p.value !== undefined ? p.value.toString() : "0",
      gasLimitMultiplier: "1.5", // generous; vault's per-tx checks can be expensive
    });
    if (result.status !== "completed" || !result.transactionHash) {
      throw new Error(
        `${p.label ?? p.functionName} via KeeperHub failed: ${result.error ?? result.status} (executionId ${result.executionId})`,
      );
    }
    return result.transactionHash;
  }
}
