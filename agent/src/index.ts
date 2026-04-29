/// <reference types="@cloudflare/workers-types" />
import { loadConfig } from "./config.js";
import { KvActivityStore } from "./log.js";
import type { PositionHysteresis } from "./planner.js";
import { runTick, type RunOptions } from "./runner.js";

interface Env {
  ACTIVITY_LOG: KVNamespace;
  AGENT_PRIVATE_KEY: string;
  HMAC_SECRET: string;
  /** Optional: shared bearer token for KeeperHub-style webhook callers that
   *  can't compute HMAC over the request body. Either HMAC or this token
   *  is sufficient on its own. */
  KEEPERHUB_API_KEY?: string;
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
    if (url.pathname === "/agent/health" && req.method === "GET") {
      // Liveness + config snapshot for KeeperHub uptime monitoring. No
      // secrets — only the public side of the agent's identity. Works as a
      // KeeperHub workflow's "Check before acting" precondition step.
      return new Response(
        JSON.stringify({
          ok: true,
          vault: env.VAULT_ADDRESS,
          registry: env.REGISTRY_ADDRESS,
          chain: "base",
          ts: Date.now(),
        }),
        { headers: { "content-type": "application/json", "access-control-allow-origin": "*" } },
      );
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
  const body = await req.text();
  const authed = await isAuthorized(req, env, body);
  if (!authed) return new Response("unauthorised", { status: 401 });
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

/** Two-track auth so KeeperHub-style webhook callers can use a static
 *  bearer token while the legacy CLI / admin-script callers can keep their
 *  HMAC-over-body flow. Either alone is sufficient. */
async function isAuthorized(req: Request, env: Env, body: string): Promise<boolean> {
  const sig = req.headers.get("x-signature");
  if (sig && (await verifyHmac(env.HMAC_SECRET, body, sig))) return true;
  const auth = req.headers.get("authorization");
  if (auth && env.KEEPERHUB_API_KEY && auth === `Bearer ${env.KEEPERHUB_API_KEY}`) return true;
  return false;
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
