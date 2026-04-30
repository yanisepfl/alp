// Boot-time environment loading. Parsed once and exported as a frozen
// object — everywhere else imports `env` instead of touching Bun.env.
//
// Required keys cause a hard exit on boot. Constraints (min length, hex
// shape, http URL) are validated here so a malformed .env never reaches
// the engine and surfaces only on first chain write.

import { z } from "zod";

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

// zod's `z.coerce.boolean()` coerces via `Boolean(v)` — every non-empty
// string is truthy, so `"false"` becomes true. That's the wrong shape
// for an env-var gate: we'd silently leave KEEPER_DRY_RUN=true even
// after flipping the .env. This explicit parser accepts the strings the
// .env actually carries and rejects everything else.
const BoolFromEnv = (defaultValue: boolean) =>
  z.string().optional().transform((v, ctx) => {
    if (v === undefined || v === "") return defaultValue;
    const s = v.toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected true/false, got "${v}"` });
    return z.NEVER;
  });

const Schema = z.object({
  AGENT_PRIVATE_KEY: z.string().regex(HEX_KEY, "AGENT_PRIVATE_KEY must be 0x-prefixed 32-byte hex"),
  BASE_RPC_URL: z.string().url(),
  // Optional secondary RPC. When set, viem's fallback() transport tries
  // primary first and falls through on transport errors. Mirrors the
  // backend's pattern (~/alp/backend/.env). Empirically, Alchemy as
  // primary + drpc as fallback gives the best mix of consistency
  // (single node, no load-balancer staleness across consecutive calls)
  // and availability (drpc takes over on Alchemy hiccups).
  BASE_RPC_URL_FALLBACK: z.string().url().optional(),
  VAULT_ADDRESS: z.string().regex(ADDR),
  POOL_REGISTRY_ADDRESS: z.string().regex(ADDR),
  KEEPER_PORT: z.coerce.number().int().positive().default(8788),
  KEEPER_INBOUND_BEARER: z.string().min(32, "KEEPER_INBOUND_BEARER must be ≥32 chars"),
  INGEST_SECRET: z.string().min(32, "INGEST_SECRET must be ≥32 chars (matches backend)"),
  BACKEND_INGEST_URL: z.string().url(),
  KEEPER_DB_PATH: z.string().default("./data/keeper.sqlite"),
  KEEPER_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(1800),
  SHERPA_NARRATE_HOLDS: BoolFromEnv(false),
  CLAUDE_NARRATOR_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  // 2b: real chain-write gate. Defaults to true so a stray boot during 2b
  // dev never lands a tx — flip to false explicitly and only after the
  // pre-flight protocol clears.
  KEEPER_DRY_RUN: BoolFromEnv(true),
  // Slippage knobs sourced from ~/alp/agent/.env.example. Yanis's tested
  // defaults — don't reinvent.
  SWAP_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10000).default(50),
  LIQUIDITY_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10000).default(100),
  TRADING_API_BASE: z.string().url().default("https://trade-api.gateway.uniswap.org"),
  TRADING_API_KEY: z.string().optional(),
  // NOTE: the Uniswap Liquidity API (REST) was previously wired here as
  // UNISWAP_LIQUIDITY_API_BASE / _KEY. After the gateway returned 403
  // for /v1/lp/* even with a valid dashboard key (entitlement gap), we
  // switched to @uniswap/v3-sdk + v4-sdk + sdk-core, which compute
  // Position math locally — no API auth required. See uniswapSdk.ts.
});

function loadEnv() {
  const parsed = Schema.safeParse({
    AGENT_PRIVATE_KEY: Bun.env.AGENT_PRIVATE_KEY,
    BASE_RPC_URL: Bun.env.BASE_RPC_URL,
    BASE_RPC_URL_FALLBACK: Bun.env.BASE_RPC_URL_FALLBACK,
    VAULT_ADDRESS: Bun.env.VAULT_ADDRESS,
    POOL_REGISTRY_ADDRESS: Bun.env.POOL_REGISTRY_ADDRESS,
    KEEPER_PORT: Bun.env.KEEPER_PORT,
    KEEPER_INBOUND_BEARER: Bun.env.KEEPER_INBOUND_BEARER,
    INGEST_SECRET: Bun.env.INGEST_SECRET,
    BACKEND_INGEST_URL: Bun.env.BACKEND_INGEST_URL,
    KEEPER_DB_PATH: Bun.env.KEEPER_DB_PATH,
    KEEPER_COOLDOWN_SECONDS: Bun.env.KEEPER_COOLDOWN_SECONDS,
    SHERPA_NARRATE_HOLDS: Bun.env.SHERPA_NARRATE_HOLDS,
    CLAUDE_NARRATOR_TIMEOUT_MS: Bun.env.CLAUDE_NARRATOR_TIMEOUT_MS,
    KEEPER_DRY_RUN: Bun.env.KEEPER_DRY_RUN,
    SWAP_SLIPPAGE_BPS: Bun.env.SWAP_SLIPPAGE_BPS,
    LIQUIDITY_SLIPPAGE_BPS: Bun.env.LIQUIDITY_SLIPPAGE_BPS,
    TRADING_API_BASE: Bun.env.TRADING_API_BASE,
    TRADING_API_KEY: Bun.env.TRADING_API_KEY,
  });
  if (!parsed.success) {
    console.error("FATAL: keeper .env validation failed");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const env = loadEnv();

// Chain-write gate. Read from env so we can flip without recompiling.
// 2b ships with KEEPER_DRY_RUN=true (default). Flip via .env after the
// pre-flight protocol clears, restart the keeper, then fire /force.
export const DRY_RUN = env.KEEPER_DRY_RUN;

// V0 narrating mode: when true, range emits action="hold" for in-range
// positions and idle/cap/vol are skipped. 2b flips this off so range
// narrates "thought" for in-range, the engine runs all 5 policies, and
// the antiwhip per-pool emitter contributes its own narration.
export const V0_MODE = false;
