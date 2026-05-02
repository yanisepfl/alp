// Mock UserSnapshot used in mock mode (when VAULT_ADDRESS is unset).

import type { UserSnapshot } from "../types";
import { ulid } from "../ulid";

// 66-char placeholder tx hash for the seeded deposit.
const SEED_DEPOSIT_TX = "0x82a3" + "0".repeat(56) + "4d91";

export function demoUserSnapshot(wallet: string): UserSnapshot {
 return {
 wallet,
 position: {
 shares: "4909663934393314000000",
 valueUsd: 5119.21,
 costBasisSharePrice: 1.0184,
 totalDepositedUsd: 5000,
 firstDepositTs: "2026-02-27T10:14:00.000Z",
 pnlUsd: 119.21,
 pnlPct: 2.38,
 realizedApyPct: 14.69,
 },
 activity: [
 {
 id: ulid(new Date("2026-02-27T10:14:00.000Z").getTime()),
 kind: "deposit",
 amount: 5000,
 token: "USDC",
 ts: "2026-02-27T10:14:00.000Z",
 tx: SEED_DEPOSIT_TX,
 },
 ],
 ts: new Date().toISOString(),
 };
}
