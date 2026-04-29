/** KeeperHub REST client for the Best Integration prize-tier path.
 *
 *  Two surfaces wrapped here:
 *  1. Direct Execution API — KH's Turnkey-backed execution wallet signs and
 *     lands a contract call on Base. Used to replace the agent's local viem
 *     signer for rebalance txs (executeRemoveLiquidity / executeSwap /
 *     executeAddLiquidity).
 *  2. Workflow CRUD — POST /api/workflows/create + PATCH for nodes/edges.
 *     Used by `scripts/setup-keeperhub.ts` to deploy the rebalance workflow
 *     idempotently from CI / local dev (there is no `kh workflow apply` —
 *     this is the documented round-trip pattern).
 *
 *  Auth header: docs disagree between `Authorization: Bearer kh_…` (auth page)
 *  and `X-API-Key: keeper_…` (direct-execution page). We send BOTH headers so
 *  whichever KH actually validates wins. Cheap belt-and-suspenders.
 */

const KH_BASE_URL = "https://app.keeperhub.com";

export interface KeeperHubConfig {
  apiKey: string;
  /** Optional override; defaults to https://app.keeperhub.com */
  baseUrl?: string;
  /** Network identifier accepted by /api/execute/contract-call.
   *  Direct-execution docs use a NAME ("base", "ethereum", "polygon"),
   *  while CLI / MCP use the chainId. We use the name here. */
  network?: "base" | "ethereum" | "polygon" | "arbitrum" | "optimism";
}

export interface ContractCallParams {
  contractAddress: `0x${string}`;
  /** Solidity function name, e.g. "executeAddLiquidity". */
  functionName: string;
  /** Args as a JSON-encoded string per KH spec. */
  functionArgs: string;
  /** ABI fragment as a JSON-encoded string. Optional — KH auto-fetches from
   *  the explorer when missing, but we always supply it for our own contracts
   *  so the call doesn't depend on Basescan being indexed for the address. */
  abi?: string;
  /** msg.value in wei, as a decimal string. */
  value?: string;
  /** e.g. "1.2" for 20% headroom over simulated gas. */
  gasLimitMultiplier?: string;
}

export interface ExecutionResult {
  executionId: string;
  status: "pending" | "running" | "completed" | "failed";
  transactionHash?: `0x${string}`;
  transactionLink?: string;
  gasUsedWei?: string;
  error?: string;
}

export class KeeperHubClient {
  constructor(private config: KeeperHubConfig) {
    if (!config.apiKey) throw new Error("KeeperHubClient: apiKey required");
  }

  private url(path: string): string {
    return (this.config.baseUrl ?? KH_BASE_URL) + path;
  }

  private headers(): HeadersInit {
    // Send both header formats — docs disagree; the unused one is ignored.
    return {
      "Authorization": `Bearer ${this.config.apiKey}`,
      "X-API-Key": this.config.apiKey,
      "Content-Type": "application/json",
    };
  }

  /** Fire a contract call on KH's execution wallet. Returns synchronously
   *  with an executionId; poll `pollExecution` until status != "running" to
   *  get the txHash. */
  async executeContractCall(params: ContractCallParams): Promise<ExecutionResult> {
    const body = {
      contractAddress: params.contractAddress,
      network: this.config.network ?? "base",
      functionName: params.functionName,
      functionArgs: params.functionArgs,
      ...(params.abi ? { abi: params.abi } : {}),
      value: params.value ?? "0",
      gasLimitMultiplier: params.gasLimitMultiplier ?? "1.2",
    };
    const res = await fetch(this.url("/api/execute/contract-call"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`KH contract-call failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<ExecutionResult>;
  }

  /** Poll an execution to completion (or until `timeoutMs`). */
  async waitForExecution(executionId: string, timeoutMs = 60_000, pollMs = 2_000): Promise<ExecutionResult> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await fetch(this.url(`/api/execute/${executionId}/status`), {
        headers: this.headers(),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`KH status poll failed (${res.status}): ${text}`);
      }
      const result = (await res.json()) as ExecutionResult;
      if (result.status === "completed" || result.status === "failed") return result;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`KH execution ${executionId} did not complete within ${timeoutMs}ms`);
  }

  /** One-shot helper: fire + wait + return the final result. */
  async sendAndWait(params: ContractCallParams, timeoutMs?: number): Promise<ExecutionResult> {
    const fired = await this.executeContractCall(params);
    if (fired.status === "completed" || fired.status === "failed") return fired;
    return this.waitForExecution(fired.executionId, timeoutMs);
  }

  // ---------- Workflow CRUD (used by scripts/setup-keeperhub.ts) ----------

  /** Create a new workflow shell (no nodes). Returns the workflow id. */
  async createWorkflow(name: string, description?: string): Promise<{ id: string }> {
    const res = await fetch(this.url("/api/workflows/create"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ name, description }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`KH createWorkflow failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<{ id: string }>;
  }

  /** Replace the workflow's full nodes/edges/triggers definition. */
  async updateWorkflow(id: string, definition: unknown): Promise<void> {
    const res = await fetch(this.url(`/api/workflows/${id}`), {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(definition),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`KH updateWorkflow ${id} failed (${res.status}): ${text}`);
    }
  }

  async getWorkflow(id: string): Promise<unknown> {
    const res = await fetch(this.url(`/api/workflows/${id}/download`), {
      headers: this.headers(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`KH getWorkflow ${id} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  async listWorkflows(): Promise<Array<{ id: string; name: string; status: string }>> {
    const res = await fetch(this.url("/api/workflows"), { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`KH listWorkflows failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { workflows?: Array<{ id: string; name: string; status: string }> };
    return json.workflows ?? [];
  }

  /** Activate a workflow that's currently in draft (`paused`) state. */
  async goLive(id: string): Promise<void> {
    const res = await fetch(this.url(`/api/workflows/${id}/go-live`), {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`KH goLive ${id} failed (${res.status}): ${text}`);
    }
  }
}
