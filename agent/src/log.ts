import type { Plan } from "./planner.js";

export interface ActionStep {
  kind: "remove" | "swap" | "add";
  txHash: `0x${string}`;
  detail?: Record<string, string | number | bigint>;
}

export interface ActivityRow {
  ts: number;
  positionKey: string;
  pool: string;
  currentTick: number;
  range: [number, number];
  inRange: boolean;
  outOfRangeStreak: number;
  action: "hold" | "wait" | "rebalance";
  reason: string;
  newRange?: [number, number];
  steps?: ActionStep[];
}

export interface ActivityStore {
  append(row: ActivityRow): Promise<void>;
  recent(limit: number): Promise<ActivityRow[]>;
}

/** Cloudflare KV-backed activity log. Stores rows under sortable keys so a
 *  prefix-list returns them in chronological order. */
export class KvActivityStore implements ActivityStore {
  constructor(private readonly kv: KVNamespace) {}

  async append(row: ActivityRow): Promise<void> {
    // Sortable key: ts (zero-padded) + position key. Lexical order = time order.
    const key = `${row.ts.toString().padStart(13, "0")}:${row.positionKey}`;
    await this.kv.put(key, JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  }

  async recent(limit: number): Promise<ActivityRow[]> {
    const list = await this.kv.list({ limit });
    const rows = await Promise.all(
      list.keys.map(async (k) => {
        const v = await this.kv.get(k.name);
        return v ? (JSON.parse(v) as ActivityRow) : null;
      }),
    );
    return rows.filter((r): r is ActivityRow => r !== null);
  }
}

/** In-memory store for local testing. Not persistent across restarts. */
export class MemoryActivityStore implements ActivityStore {
  private rows: ActivityRow[] = [];

  async append(row: ActivityRow): Promise<void> {
    this.rows.push(row);
  }

  async recent(limit: number): Promise<ActivityRow[]> {
    return this.rows.slice(-limit);
  }
}

export function planToActivityRow(plan: Plan, steps?: ActionStep[]): ActivityRow {
  return {
    ts: Math.floor(Date.now() / 1000),
    positionKey: plan.prior.positionKey,
    pool: plan.position.pool.label,
    currentTick: plan.position.currentTick,
    range: [plan.position.tickLower, plan.position.tickUpper],
    inRange: plan.position.inRange,
    outOfRangeStreak: plan.prior.outOfRangeStreak,
    action: plan.action.kind,
    reason: plan.action.reason,
    newRange: plan.action.kind === "rebalance" ? [plan.action.newTickLower, plan.action.newTickUpper] : undefined,
    steps,
  };
}
