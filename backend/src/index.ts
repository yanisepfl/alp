// Entrypoint. Bun.serve handles both the WS upgrade on /stream (public,
// auth via subscribe.auth) and on /ingest/stream (private, auth via
// ?secret=), plus HTTP routes via Hono (/health, /auth/*, /ingest/*).

import type { ServerWebSocket, WebSocketHandler } from "bun";
import { Hono } from "hono";
import { cors } from "hono/cors";
// B6 — import db FIRST so the sqlite file is created and migrations run before
// any other module pulls in helpers from "./db".
import { db } from "./db";
import {
  handleClose, handleMessage, handleOpen, newCid,
  connectionCount, broadcastShutdownPing, type WsData,
} from "./ws";
import { setIndexerEnabled, startVaultChainReader, startVaultMockTicker } from "./topics/vault";
import { startComposition } from "./topics/vault-composition";
import { getPublicClient, vaultAddress } from "./chain";
import {
  startAgentScript, startAgentActionBridge, loadAgentRingState, agentRingSize,
} from "./topics/agent";
import { startNonceSweeper, loadAuthState } from "./auth";
import { buildAuthRoutes } from "./routes/auth";
import { buildIngestRoutes } from "./routes/ingest";
import { startIndexer, getLastIndexedBlock } from "./indexer";
import {
  assertIngestSecretConfigured, verifyIngestSecret,
  registerForwardSubscriber, unregisterForwardSubscriber,
  type IngestWsData,
} from "./ingest";

if (!Bun.env.JWT_SECRET || Bun.env.JWT_SECRET.length < 32) {
  console.error("FATAL: JWT_SECRET env var is required (min 32 chars). Generate with: openssl rand -base64 48");
  process.exit(1);
}
assertIngestSecretConfigured();

// B6 — rehydrate state that doesn't depend on the chain client. The indexer
// load runs inside startIndexer() in chain mode; mock mode skips it (mock
// state is meaningless to persist). Agent ring loads regardless so prior
// scripted signals + chain actions replay correctly.
loadAuthState();
loadAgentRingState();

const PORT = Number(Bun.env.PORT ?? 8787);
const CORS_ORIGIN = Bun.env.CORS_ALLOW_ORIGIN ?? "http://localhost:3000";
const VAULT_MODE: "chain" | "mock" =
  vaultAddress() && Bun.env.BASE_RPC_URL ? "chain" : "mock";
const BOOT_TS = Date.now();

const app = new Hono();
app.use(
  "/auth/*",
  cors({
    origin: CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["content-type"],
  }),
);
app.use(
  "/health",
  cors({
    origin: CORS_ORIGIN,
    allowMethods: ["GET", "OPTIONS"],
    allowHeaders: ["content-type"],
  }),
);
// /ingest/* deliberately has NO CORS — agent runs on a private host, not a
// browser. A developer testing from a browser can curl from the VM.

app.get("/health", (c) => {
  const last = getLastIndexedBlock();
  return c.json({
    ok: true,
    mode: VAULT_MODE,
    lastIndexedBlock: last !== null ? last.toString() : null,
    ringSize: agentRingSize(),
    connections: connectionCount(),
    uptimeSec: Math.floor((Date.now() - BOOT_TS) / 1000),
  });
});
app.route("/auth", buildAuthRoutes());
app.route("/ingest", buildIngestRoutes());

// B7 — WS data is a discriminated union: public stream cids vs ingest agents.
// The single Bun.serve websocket handler dispatches by `kind`.
type AnyWsData = WsData | IngestWsData;

let shuttingDown = false;

const websocket: WebSocketHandler<AnyWsData> = {
  open(ws) {
    if (ws.data.kind === "ingest") {
      if (!ws.data.authed) {
        try { ws.close(4001, "auth_invalid"); } catch {}
        return;
      }
      registerForwardSubscriber(ws as ServerWebSocket<IngestWsData>);
      console.log("[ingest] forward subscriber connected");
    } else {
      handleOpen(ws as ServerWebSocket<WsData>);
    }
  },
  async message(ws, message) {
    if (ws.data.kind === "ingest") {
      // Forward stream is server→agent only. Drop anything the agent sends.
      return;
    }
    await handleMessage(ws as ServerWebSocket<WsData>, message);
  },
  close(ws) {
    if (ws.data.kind === "ingest") {
      if (ws.data.authed) {
        unregisterForwardSubscriber(ws as ServerWebSocket<IngestWsData>);
        console.log("[ingest] forward subscriber disconnected");
      }
    } else {
      handleClose(ws as ServerWebSocket<WsData>);
    }
  },
};

const server = Bun.serve<AnyWsData, never>({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname === "/stream") {
      if (shuttingDown) return new Response("server shutting down", { status: 503 });
      const data: WsData = { kind: "public", cid: newCid() };
      const upgraded = server.upgrade(req, { data });
      if (upgraded) return undefined;
      return new Response("websocket upgrade failed", { status: 400 });
    }
    if (url.pathname === "/ingest/stream") {
      if (shuttingDown) return new Response("server shutting down", { status: 503 });
      const presented = url.searchParams.get("secret") ?? "";
      const authed = verifyIngestSecret(presented);
      // Always accept the upgrade — the ws handler's `open` immediately
      // closes the socket with 4001 if `authed` is false. This surfaces
      // the rejection as a WS close event rather than an HTTP error, which
      // some WS clients can't introspect.
      const data: IngestWsData = { kind: "ingest", authed };
      const upgraded = server.upgrade(req, { data });
      if (!upgraded) return new Response("websocket upgrade failed", { status: 400 });
      return undefined;
    }
    return app.fetch(req);
  },
  websocket,
});

if (VAULT_MODE === "chain") {
  const addr = vaultAddress()!;
  console.log(`[vault] chain mode: ${addr} via ${Bun.env.BASE_RPC_URL}`);
  // B3b: backfill the event indexer first so the FIRST vault.snapshot
  // served already includes chain-derived users / basketEarned30d /
  // basketApr / apr30d. Falls back gracefully on indexer failure — the B3
  // headlines (sharePrice, tvl) still come up.
  void (async () => {
    const client = getPublicClient();
    let indexerOk = false;
    if (client) {
      try {
        await startIndexer(client, addr);
        indexerOk = true;
      } catch (e) {
        console.warn(`[indexer] startup failed (${e instanceof Error ? e.message : String(e)}) — chain headlines only, indexer fields fall back to mock`);
      }
    }
    setIndexerEnabled(indexerOk);
    // B5 — register the chain-action bridge AFTER startIndexer() returns.
    // The backfill itself is intentionally not bridged (would flood the
    // priming ring on boot); the bridge picks up incremental events from
    // every subsequent indexUpToHead tick.
    if (indexerOk) startAgentActionBridge();
    // B3c — composition reader (allocations + pools). Subscribes to the
    // same agent-action stream for cache invalidation, so it must come up
    // after the indexer (and hence after the action-bridge) is wired.
    if (client && indexerOk) startComposition(client, addr);
    await startVaultChainReader();
  })();
} else {
  console.warn("[vault] mock mode: VAULT_ADDRESS or BASE_RPC_URL unset, using random-walk ticker");
  startVaultMockTicker();
}
startAgentScript();
startNonceSweeper();

console.log(`[alp-backend] listening on http://localhost:${server.port}`);
console.log(`  ws://localhost:${server.port}/stream`);
console.log(`  ws://localhost:${server.port}/ingest/stream`);
console.log(`  http://localhost:${server.port}/health`);
console.log(`  http://localhost:${server.port}/auth/{nonce,verify${(Bun.env.AUTH_DEV_BYPASS ?? "0") === "1" ? ",dev-token" : ""}}`);
console.log(`  http://localhost:${server.port}/ingest/{signal,reply}`);

// B7 — graceful shutdown. SIGTERM is what systemd sends on `systemctl stop`;
// SIGINT is Ctrl-C. On signal: stop accepting new upgrades, send a final
// ping best-effort, close the db (flushes WAL), exit 0 after a 2s drain
// (or immediately if no connections). systemd's Restart=on-failure won't
// re-trigger on exit 0.
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[alp-backend] ${signal} received — draining`);
  // Best-effort ping to nudge public clients toward reconnect.
  try { broadcastShutdownPing(); } catch { /* closing anyway */ }
  const drainMs = connectionCount() === 0 ? 0 : 2_000;
  setTimeout(() => {
    try { db.close(); } catch (e) {
      console.warn(`[alp-backend] db.close failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    process.exit(0);
  }, drainMs);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
