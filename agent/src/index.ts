/// <reference types="@cloudflare/workers-types" />
import { loadConfig } from "./config.js";
import { KvActivityStore } from "./log.js";
import type { PositionHysteresis } from "./planner.js";
import { runTick } from "./runner.js";

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
}

const HYSTERESIS_KEY = "__hysteresis__";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/agent/activity" && req.method === "GET") {
      return handleActivity(env, url);
    }
    if (url.pathname === "/trigger" && req.method === "POST") {
      return handleTrigger(req, env);
    }
    return new Response("not found", { status: 404 });
  },
};

async function handleTrigger(req: Request, env: Env): Promise<Response> {
  // HMAC auth: caller must include `x-signature` header carrying the
  // hex-encoded HMAC-SHA256 of the raw body keyed by `HMAC_SECRET`.
  const sig = req.headers.get("x-signature");
  const body = await req.text();
  if (!sig || !(await verifyHmac(env.HMAC_SECRET, body, sig))) {
    return new Response("unauthorised", { status: 401 });
  }

  const config = loadConfig(env as unknown as Record<string, string | undefined>);
  const store = new KvActivityStore(env.ACTIVITY_LOG);

  const result = await runTick({
    config,
    store,
    loadHysteresis: async () => loadHysteresis(env.ACTIVITY_LOG),
    saveHysteresis: async (s) => saveHysteresis(env.ACTIVITY_LOG, s),
  });
  return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
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
