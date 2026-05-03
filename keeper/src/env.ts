import { z } from "zod";

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;

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
  KEEPER_INTERNAL_TICK_MS: z.coerce.number().int().positive().optional(),
  KEEPER_DRY_RUN: BoolFromEnv(true),
  SWAP_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10000).default(50),
  LIQUIDITY_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10000).default(100),
  TRADING_API_BASE: z.string().url().default("https://trade-api.gateway.uniswap.org"),
  TRADING_API_KEY: z.string().optional(),
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
    KEEPER_INTERNAL_TICK_MS: Bun.env.KEEPER_INTERNAL_TICK_MS,
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

export const DRY_RUN = env.KEEPER_DRY_RUN;
