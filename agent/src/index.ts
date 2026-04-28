/// <reference types="@cloudflare/workers-types" />
import { loadConfig } from "./config.js";
import { KvActivityStore } from "./log.js";
import type { PositionHysteresis } from "./planner.js";
import { runTick, type RunOptions } from "./runner.js";

interface Env {
  ACTIVITY_LOG: KVNamespace;
  AGENT_PRIVATE_KEY: string;
  HMAC_SECRET: string;
  BASE_RPC_URL: string;
  VAULT_ADDRESS: string;
  REGISTRY_ADDRESS: string;
  V3_ADAPTER_ADDRESS: string;
  UR_ADAPTER_ADDRESS: string;
  SWAP_SLIPPAGE_BPS?: string;
  LIQUIDITY_SLIPPAGE_BPS?: string;
  HYSTERESIS_N?: string;
  HYSTERESIS_CLOSER_FRACTION?: string;
  TRADING_API_BASE?: string;
  TRADING_API_KEY?: string;
}

const HYSTERESIS_KEY = "__hysteresis__";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/agent/activity" && req.method === "GET") {
      return handleActivity(env, url);
    }
    if (url.pathname === "/agent/dryrun" && req.method === "GET") {
      // Dry-run is read-only and safe to expose unauthenticated. Returns the
      // plan the agent would execute against current chain state. Useful for
      // the demo to verify the agent reads chain state correctly without
      // spending gas.
      return runAndRespond(env, { dryRun: true });
    }
    if (url.pathname === "/trigger" && req.method === "POST") {
      return handleAuthedRun(req, env, () => ({}));
    }
    if (url.pathname === "/force-rebalance" && req.method === "POST") {
      return handleAuthedRun(req, env, (body) => ({
        force: true,
        positionKey: body.positionKey,
      }));
    }
    return new Response("not found", { status: 404 });
  },
};

async function handleAuthedRun(
  req: Request,
  env: Env,
  optionsFromBody: (body: { positionKey?: string }) => RunOptions,
): Promise<Response> {
  const sig = req.headers.get("x-signature");
  const body = await req.text();
  if (!sig || !(await verifyHmac(env.HMAC_SECRET, body, sig))) {
    return new Response("unauthorised", { status: 401 });
  }
  let parsed: { positionKey?: string } = {};
  if (body.length > 0) {
    try {
      parsed = JSON.parse(body) as { positionKey?: string };
    } catch {
      return new Response("invalid json", { status: 400 });
    }
  }
  return runAndRespond(env, optionsFromBody(parsed));
}

async function runAndRespond(env: Env, options: RunOptions): Promise<Response> {
  const config = loadConfig(env as unknown as Record<string, string | undefined>);
  const store = new KvActivityStore(env.ACTIVITY_LOG);
  const result = await runTick({
    config,
    store,
    loadHysteresis: async () => loadHysteresis(env.ACTIVITY_LOG),
    saveHysteresis: async (s) => saveHysteresis(env.ACTIVITY_LOG, s),
    options,
  });
  return new Response(JSON.stringify(result), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

async function handleActivity(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
  const store = new KvActivityStore(env.ACTIVITY_LOG);
  const rows = await store.recent(limit);
  return new Response(JSON.stringify(rows), {
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

async function loadHysteresis(kv: KVNamespace): Promise<Map<string, PositionHysteresis>> {
  const raw = await kv.get(HYSTERESIS_KEY);
  if (!raw) return new Map();
  const arr = JSON.parse(raw) as PositionHysteresis[];
  return new Map(arr.map((h) => [h.positionKey, h]));
}

async function saveHysteresis(kv: KVNamespace, state: Map<string, PositionHysteresis>): Promise<void> {
  await kv.put(HYSTERESIS_KEY, JSON.stringify(Array.from(state.values())));
}

async function verifyHmac(secret: string, body: string, signature: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Constant-time-ish compare. CF Workers don't expose a timingSafeEqual.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
