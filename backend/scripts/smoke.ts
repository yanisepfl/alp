// End-to-end smoke check. Run while `bun run dev` is up:
//   bun run scripts/smoke.ts
//
// Sequential flows, each on a fresh WS:
//   1. Anon — subscribe without auth; expect agent+vault accepted, user
//      rejected with auth_required (recoverable, no close).
//   2. Authed (dev-bypass) — POST /auth/dev-token, subscribe with the JWT;
//      expect all three topics accepted; user.snapshot.wallet matches the
//      test address; user_message echo + canned reply round-trip.
//   3. Bad token — subscribe with a malformed JWT; expect WS close 4001.
//   4. Vault chain reads (B3 + B3b + B4 + B5) — gated on VAULT_ADDRESS being
//      set and not equal to "mock"; assert the priming snapshot has
//      chain-derived headlines, 30d arrays of length 30, address/chainId
//      match, the B3b indexer-derived fields (users, basketEarned30d,
//      basketApr, apr30d) have the right shape and non-negativity, a B4
//      user-topic subscribe primes a snapshot whose wallet matches the
//      dev address (lowercase compare) and whose `position` is either
//      null or contains every CONTRACT.md §4.2 required key, and any B5
//      action events present in the agent history carry a real 66-char
//      0x-prefixed tx hash (count not asserted — chain may be quiet).
//   5. B6 persistence — auth + send a user_message, capture the reply id,
//      close, then open the sqlite db at ALP_DB_PATH (default
//      ./data/alp.sqlite) directly and assert the reply id is present in
//      agent_ring. Exercises write-through end-to-end. Restart-replay is
//      tested manually (see README §"Persistence (B6)").
//   6. B7 ingest API — POST /ingest/signal broadcasts to all agent
//      subscribers; POST /ingest/reply lands only with the target wallet's
//      subscribers; bad secret yields 401 with no broadcast. Skipped if
//      INGEST_SECRET unset on the smoke runner.
//   7. B7 rate limit — 25 user_messages in tight succession, expect ≤20
//      echoed and the rest emit error/rate_limited; connection stays open.
//      Skipped if INGEST_SECRET unset (paired with flow 6).
//
// Requires AUTH_DEV_BYPASS=1 on the server. Flows 6+7 also require
// INGEST_SECRET to be set on BOTH the server and the smoke runner (same
// value). Exits 0 on pass, 1 on fail.

const HTTP_URL = process.env.SMOKE_HTTP_URL ?? "http://localhost:8787";
const WS_URL   = process.env.SMOKE_WS_URL   ?? "ws://localhost:8787/stream";
const TEST_WALLET = "0x1234567890123456789012345678901234567890";

type Frame = Record<string, any>;

let failed = false;
function pass(name: string) { console.log(`  PASS  ${name}`); }
function fail(name: string, detail: string) {
  failed = true;
  console.log(`  FAIL  ${name} — ${detail}`);
}

// Open a fresh WS, send the given subscribe frame on open, and resolve once
// either `windowMs` elapses or the socket closes. Returns the captured
// frames + close info.
function runWs(
  sub: Frame,
  windowMs: number,
  onMessage?: (f: Frame, ws: WebSocket) => void,
): Promise<{ frames: Frame[]; close: { code: number; reason: string } | null }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(WS_URL);
    const frames: Frame[] = [];
    let close: { code: number; reason: string } | null = null;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve({ frames, close });
    };
    ws.addEventListener("open", () => ws.send(JSON.stringify(sub)));
    ws.addEventListener("message", (e) => {
      let f: Frame;
      try { f = JSON.parse(typeof e.data === "string" ? e.data : String(e.data)); }
      catch { return; }
      frames.push(f);
      onMessage?.(f, ws);
    });
    ws.addEventListener("close", (e) => {
      close = { code: e.code, reason: e.reason };
      settle();
    });
    ws.addEventListener("error", () => {});
    setTimeout(settle, windowMs);
  });
}

// ---------------------------------------------------------------- Flow 1: anon
async function flowAnon(): Promise<void> {
  console.log("[1/7] anon flow");
  const { frames, close } = await runWs({
    v: 1, type: "subscribe", topics: ["agent", "vault", "user"],
  }, 1500);

  if (close && close.code !== 1000) {
    fail("anon: connection stays open", `closed code=${close.code} reason=${close.reason}`);
    return;
  }
  const ack = frames.find((f) => f.type === "ack");
  if (!ack) { fail("anon: ack received", "no ack"); return; }
  const subs = (ack.subscribed ?? []) as string[];
  if (!(subs.includes("agent") && subs.includes("vault") && !subs.includes("user"))) {
    fail("anon: ack.subscribed = [agent,vault]", `got [${subs.join(",")}]`);
    return;
  }
  const rejected = (ack.rejected ?? []) as Array<{ topic: string; reason: string }>;
  const userRej = rejected.find((r) => r.topic === "user");
  if (!userRej || userRej.reason !== "auth_required") {
    fail("anon: ack.rejected has user/auth_required", JSON.stringify(rejected));
    return;
  }
  const vaultSnap = frames.find((f) => f.type === "snapshot" && f.topic === "vault");
  if (!vaultSnap) { fail("anon: vault.snapshot received", "missing"); return; }
  const agentHist = frames.find((f) => f.type === "history" && f.topic === "agent");
  if (!agentHist) { fail("anon: agent.history received", "missing"); return; }
  const userSnap = frames.find((f) => f.type === "snapshot" && f.topic === "user");
  if (userSnap) { fail("anon: no user.snapshot", "got one"); return; }

  // B5 — mock-mode priming is signal-only (scripted action seeds were
  // stripped because every action WireMessage must carry a real on-chain
  // tx hash). In chain mode the priming may legitimately include real
  // chain actions; the assertion is gated on VAULT_ADDRESS to scope it
  // to mock mode only.
  const inChainMode = !!process.env.VAULT_ADDRESS && process.env.VAULT_ADDRESS !== "mock";
  if (!inChainMode) {
    const events = (agentHist.events ?? []) as Array<{ kind: string }>;
    const actionCount = events.filter((e) => e.kind === "action").length;
    if (actionCount !== 0) {
      fail("anon (B5 mock): priming has zero action events", `got ${actionCount}`);
      return;
    }
  }
  pass("anon: agent+vault primed, user rejected with auth_required, no close");
}

// ----------------------------------------------------- Flow 2: authed dev-token
async function flowAuthedDevBypass(): Promise<void> {
  console.log("[2/7] authed dev-bypass flow");
  let token: string;
  try {
    const res = await fetch(`${HTTP_URL}/auth/dev-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: TEST_WALLET }),
    });
    if (!res.ok) {
      fail("authed: /auth/dev-token returns 200",
        `status ${res.status} (is AUTH_DEV_BYPASS=1 set on the server?)`);
      return;
    }
    const body = await res.json() as { token?: string; wallet?: string; exp?: number };
    if (typeof body.token !== "string" || body.wallet !== TEST_WALLET) {
      fail("authed: /auth/dev-token body shape", JSON.stringify(body));
      return;
    }
    token = body.token;
  } catch (e) {
    fail("authed: /auth/dev-token reachable", String(e));
    return;
  }

  // Open WS with auth + subscribe; after we see user.snapshot, send a
  // user_message and wait for echo + canned reply.
  const userClientId = `c_smoke_${Math.random().toString(36).slice(2, 8)}`;
  let sentUserMsg = false;
  const { frames, close } = await runWs(
    {
      v: 1, type: "subscribe",
      topics: ["agent", "vault", "user"],
      auth: token,
    },
    3000,
    (f, ws) => {
      if (!sentUserMsg && f.type === "snapshot" && f.topic === "user") {
        sentUserMsg = true;
        ws.send(JSON.stringify({
          v: 1, type: "user_message", text: "smoke ping", clientId: userClientId,
        }));
      }
    },
  );

  if (close && close.code !== 1000) {
    fail("authed: connection stays open", `closed code=${close.code} reason=${close.reason}`);
    return;
  }
  const ack = frames.find((f) => f.type === "ack");
  if (!ack) { fail("authed: ack received", "no ack"); return; }
  const subs = (ack.subscribed ?? []) as string[];
  if (!(subs.includes("agent") && subs.includes("vault") && subs.includes("user"))) {
    fail("authed: ack.subscribed includes agent+vault+user", `got [${subs.join(",")}]`);
    return;
  }
  if (ack.rejected && ack.rejected.length > 0) {
    fail("authed: no rejected topics", JSON.stringify(ack.rejected));
    return;
  }
  const userSnap = frames.find((f) => f.type === "snapshot" && f.topic === "user");
  if (!userSnap) { fail("authed: user.snapshot received", "missing"); return; }
  if (userSnap.snapshot?.wallet?.toLowerCase() !== TEST_WALLET.toLowerCase()) {
    fail("authed: user.snapshot.wallet matches test wallet",
      `got ${userSnap.snapshot?.wallet}`);
    return;
  }
  const echo = frames.find((f) =>
    f.type === "event" && f.topic === "agent" && f.event?.kind === "user" && f.event?.id === userClientId);
  if (!echo) { fail("authed: user_message echoed back", "missing"); return; }
  const reply = frames.find((f) =>
    f.type === "event" && f.topic === "agent" && f.event?.kind === "reply" && f.event?.replyTo === userClientId);
  if (!reply) { fail("authed: canned reply received", "missing"); return; }
  pass("authed: all topics primed, wallet bound from JWT, user_message round-trip");
}

// --------------------------------------------------------- Flow 3: bad token
async function flowBadToken(): Promise<void> {
  console.log("[3/7] bad-token flow");
  const { frames, close } = await runWs({
    v: 1, type: "subscribe",
    topics: ["agent", "vault"],
    auth: "this.is.not-a-jwt",
  }, 2000);

  if (!close) { fail("bad: connection closes", "still open after window"); return; }
  if (close.code !== 4001) {
    fail("bad: close code 4001", `got ${close.code} reason=${close.reason}`);
    return;
  }
  if (frames.length > 0) {
    fail("bad: no frames before close", `got ${frames.length} frame(s)`);
    return;
  }
  pass("bad: closed with 4001, no frames emitted");
}

// --------------------------------------------------------- Flow 4: vault chain
async function flowVaultChain(): Promise<void> {
  console.log("[4/7] vault chain-read flow");
  const expectedAddr = process.env.VAULT_ADDRESS;
  if (!expectedAddr || expectedAddr === "mock") {
    console.log("  flow 4: skipped (mock mode — VAULT_ADDRESS unset or 'mock')");
    return;
  }

  // 30d sample at boot can take a few seconds; widen the window to 8s.
  const { frames, close } = await runWs({
    v: 1, type: "subscribe", topics: ["vault"],
  }, 8000);

  if (close && close.code !== 1000) {
    fail("chain: connection stays open", `closed code=${close.code} reason=${close.reason}`);
    return;
  }
  const snap = frames.find((f) => f.type === "snapshot" && f.topic === "vault")?.snapshot;
  if (!snap) { fail("chain: vault.snapshot received", "missing"); return; }

  if (typeof snap.sharePrice !== "number" || !(snap.sharePrice > 0)) {
    fail("chain: snapshot.sharePrice > 0", `got ${snap.sharePrice}`); return;
  }
  if (typeof snap.tvl !== "number" || snap.tvl < 0) {
    fail("chain: snapshot.tvl >= 0", `got ${snap.tvl}`); return;
  }
  if (!Array.isArray(snap.sharePrice30d) || snap.sharePrice30d.length !== 30) {
    fail("chain: snapshot.sharePrice30d length === 30", `got length ${snap.sharePrice30d?.length}`); return;
  }
  if (!Array.isArray(snap.tvl30d) || snap.tvl30d.length !== 30) {
    fail("chain: snapshot.tvl30d length === 30", `got length ${snap.tvl30d?.length}`); return;
  }
  if (typeof snap.address !== "string" || snap.address.toLowerCase() !== expectedAddr.toLowerCase()) {
    fail("chain: snapshot.address matches VAULT_ADDRESS", `got ${snap.address}`); return;
  }
  if (snap.chainId !== 8453) {
    fail("chain: snapshot.chainId === 8453", `got ${snap.chainId}`); return;
  }
  // B3b: indexer-derived fields. Don't assert exact values — they're
  // chain-state-dependent. Just shape + non-negativity.
  if (typeof snap.users !== "number" || !(snap.users >= 0)) {
    fail("chain (B3b): snapshot.users is a non-negative number", `got ${snap.users}`); return;
  }
  if (typeof snap.basketEarned30d !== "number" || !(snap.basketEarned30d >= 0)) {
    fail("chain (B3b): snapshot.basketEarned30d is a non-negative number", `got ${snap.basketEarned30d}`); return;
  }
  if (typeof snap.basketApr !== "number" || !(snap.basketApr >= 0)) {
    fail("chain (B3b): snapshot.basketApr is a non-negative number", `got ${snap.basketApr}`); return;
  }
  if (!Array.isArray(snap.apr30d) || snap.apr30d.length !== 30) {
    fail("chain (B3b): snapshot.apr30d length === 30", `got length ${snap.apr30d?.length}`); return;
  }
  pass("chain: snapshot has chain-derived sharePrice/tvl + B3b users/earned/apr/apr30d, address+chainId match");

  // B4: user-topic subscribe under chain mode. Mint a dev token, subscribe
  // ["user"], assert the priming snapshot's wallet matches and `position`
  // is either null (no deposits) or has every required key.
  let userToken: string;
  try {
    const res = await fetch(`${HTTP_URL}/auth/dev-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: TEST_WALLET }),
    });
    if (!res.ok) {
      fail("chain (B4): /auth/dev-token returns 200",
        `status ${res.status} (is AUTH_DEV_BYPASS=1 set on the server?)`);
      return;
    }
    const body = await res.json() as { token?: string };
    if (typeof body.token !== "string") {
      fail("chain (B4): /auth/dev-token body shape", JSON.stringify(body));
      return;
    }
    userToken = body.token;
  } catch (e) {
    fail("chain (B4): /auth/dev-token reachable", String(e));
    return;
  }
  const userResult = await runWs({
    v: 1, type: "subscribe", topics: ["user"], auth: userToken,
  }, 3000);
  const userSnap = userResult.frames.find((f) => f.type === "snapshot" && f.topic === "user")?.snapshot;
  if (!userSnap) { fail("chain (B4): user.snapshot received", "missing"); return; }
  if (typeof userSnap.wallet !== "string" || userSnap.wallet.toLowerCase() !== TEST_WALLET.toLowerCase()) {
    fail("chain (B4): user.snapshot.wallet matches dev address (lowercase)",
      `got ${userSnap.wallet}`); return;
  }
  if (!Array.isArray(userSnap.activity)) {
    fail("chain (B4): user.snapshot.activity is an array", typeof userSnap.activity); return;
  }
  if (typeof userSnap.ts !== "string") {
    fail("chain (B4): user.snapshot.ts is an ISO string", typeof userSnap.ts); return;
  }
  if (userSnap.position !== null) {
    const required = [
      "shares", "valueUsd", "costBasisSharePrice", "totalDepositedUsd",
      "firstDepositTs", "pnlUsd", "pnlPct", "realizedApyPct",
    ];
    const missing = required.filter((k) => !(k in userSnap.position));
    if (missing.length > 0) {
      fail("chain (B4): user.snapshot.position has all required keys",
        `missing [${missing.join(",")}]`); return;
    }
    if (typeof userSnap.position.shares !== "string") {
      fail("chain (B4): position.shares is a string (precision-preserving)",
        typeof userSnap.position.shares); return;
    }
  }
  pass("chain (B4): user.snapshot wallet matches, position is null-or-fully-shaped");

  // B5 — agent topic in chain mode. Subscribe to agent and inspect the
  // priming history: any action events MUST carry a real 66-char tx hash
  // (the FE composes basescan URLs by prefix, so fabricated hashes break
  // clickthrough). Don't assert non-zero count — a quiet chain may produce
  // zero between boot and now.
  const agentResult = await runWs({
    v: 1, type: "subscribe", topics: ["agent"],
  }, 2000);
  const agentHist = agentResult.frames.find((f) => f.type === "history" && f.topic === "agent");
  if (!agentHist) { fail("chain (B5): agent.history received", "missing"); return; }
  const events = (agentHist.events ?? []) as Array<{ kind: string; tx?: string; id?: string }>;
  const actions = events.filter((e) => e.kind === "action");
  for (const a of actions) {
    if (typeof a.tx !== "string" || a.tx.length !== 66 || !a.tx.startsWith("0x")) {
      fail("chain (B5): action.tx is a 66-char 0x-prefixed hash", `id=${a.id} tx=${a.tx}`);
      return;
    }
  }
  pass(`chain (B5): agent.history actions all carry real 66-char tx hashes (count=${actions.length})`);
}

// ---------------------------------------------------- Flow 5: B6 persistence
async function flowPersistence(): Promise<void> {
  console.log("[5/7] persistence (B6) flow");

  let token: string;
  try {
    const res = await fetch(`${HTTP_URL}/auth/dev-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: TEST_WALLET }),
    });
    if (!res.ok) {
      fail("persist (B6): /auth/dev-token returns 200",
        `status ${res.status} (is AUTH_DEV_BYPASS=1 set on the server?)`);
      return;
    }
    const body = await res.json() as { token?: string };
    if (typeof body.token !== "string") {
      fail("persist (B6): /auth/dev-token body shape", JSON.stringify(body));
      return;
    }
    token = body.token;
  } catch (e) {
    fail("persist (B6): /auth/dev-token reachable", String(e));
    return;
  }

  const userClientId = `c_persist_${Math.random().toString(36).slice(2, 8)}`;
  let sentUserMsg = false;
  let capturedReplyId: string | null = null;
  const { frames, close } = await runWs(
    {
      v: 1, type: "subscribe",
      topics: ["agent", "user"],
      auth: token,
    },
    3000,
    (f, ws) => {
      if (!sentUserMsg && f.type === "snapshot" && f.topic === "user") {
        sentUserMsg = true;
        ws.send(JSON.stringify({
          v: 1, type: "user_message", text: "persist ping", clientId: userClientId,
        }));
      }
      if (f.type === "event" && f.topic === "agent" && f.event?.kind === "reply" && f.event?.replyTo === userClientId) {
        capturedReplyId = f.event.id as string;
      }
    },
  );

  if (close && close.code !== 1000) {
    fail("persist (B6): connection stays open", `closed code=${close.code} reason=${close.reason}`);
    return;
  }
  if (capturedReplyId === null) {
    fail("persist (B6): captured reply id from canned reply", `no reply event for clientId=${userClientId}; got ${frames.length} frames`);
    return;
  }

  // Open the sqlite store the server is writing to and verify the reply id
  // landed in agent_ring. ALP_DB_PATH may be unset on the smoke runner side —
  // we honour the same default the server uses (./data/alp.sqlite resolved
  // against the current working directory of the server, which is the backend
  // folder). The smoke is run from the backend folder per README, so this
  // resolves to the same file.
  const { Database } = await import("bun:sqlite");
  const dbPath = process.env.ALP_DB_PATH ?? "./data/alp.sqlite";
  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    fail("persist (B6): sqlite db at ALP_DB_PATH opens",
      `path=${dbPath} err=${e instanceof Error ? e.message : String(e)} (run smoke from alp/backend so the relative path resolves)`);
    return;
  }
  try {
    const row = db.query<{ n: number }, [string]>(
      "SELECT count(*) AS n FROM agent_ring WHERE id = ?",
    ).get(capturedReplyId);
    const count = row?.n ?? 0;
    if (count !== 1) {
      fail("persist (B6): captured reply id present in agent_ring",
        `count=${count} for id=${capturedReplyId} in ${dbPath}`);
      return;
    }
  } finally {
    db.close();
  }
  pass(`persist (B6): reply id=${capturedReplyId} present in agent_ring at ${dbPath}`);
}

// ---------------------------------------------------- Flow 6: ingest API (B7)
async function flowIngest(): Promise<void> {
  console.log("[6/7] ingest API (B7) flow");
  const secret = process.env.INGEST_SECRET;
  if (!secret) {
    console.log("  flow 6: skipped (INGEST_SECRET unset on smoke runner)");
    return;
  }

  // Mint a token for the canonical test wallet AND a different wallet so
  // we can verify reply isolation.
  const OTHER_WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
  let tokenSelf: string;
  let tokenOther: string;
  try {
    const a = await fetch(`${HTTP_URL}/auth/dev-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: TEST_WALLET }),
    });
    const b = await fetch(`${HTTP_URL}/auth/dev-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: OTHER_WALLET }),
    });
    if (!a.ok || !b.ok) {
      fail("ingest (B7): /auth/dev-token returns 200 for both wallets",
        `self=${a.status} other=${b.status} (is AUTH_DEV_BYPASS=1?)`);
      return;
    }
    tokenSelf = (await a.json() as { token?: string }).token!;
    tokenOther = (await b.json() as { token?: string }).token!;
    if (typeof tokenSelf !== "string" || typeof tokenOther !== "string") {
      fail("ingest (B7): token strings", `self=${tokenSelf} other=${tokenOther}`);
      return;
    }
  } catch (e) {
    fail("ingest (B7): /auth/dev-token reachable", String(e));
    return;
  }

  // Subscribe two WS clients (self + other) and watch for events; concurrently
  // POST a /ingest/signal and assert both see it; then POST /ingest/reply for
  // self's wallet and assert only self sees it.
  const selfFrames: Frame[] = [];
  const otherFrames: Frame[] = [];
  const wsSelf = new WebSocket(WS_URL);
  const wsOther = new WebSocket(WS_URL);
  await new Promise<void>((resolve) => {
    let opened = 0;
    const onOpen = () => { opened++; if (opened === 2) resolve(); };
    wsSelf.addEventListener("open", () => {
      wsSelf.send(JSON.stringify({ v: 1, type: "subscribe", topics: ["agent"], auth: tokenSelf }));
      onOpen();
    });
    wsOther.addEventListener("open", () => {
      wsOther.send(JSON.stringify({ v: 1, type: "subscribe", topics: ["agent"], auth: tokenOther }));
      onOpen();
    });
    wsSelf.addEventListener("message", (e) => {
      try { selfFrames.push(JSON.parse(typeof e.data === "string" ? e.data : String(e.data))); } catch {}
    });
    wsOther.addEventListener("message", (e) => {
      try { otherFrames.push(JSON.parse(typeof e.data === "string" ? e.data : String(e.data))); } catch {}
    });
  });

  // Wait briefly for the priming history to settle so we can distinguish new
  // events from history.
  await new Promise((r) => setTimeout(r, 300));
  const selfBefore = selfFrames.length;
  const otherBefore = otherFrames.length;

  // 6a: signal — both subscribers should see it.
  let signalRes: Response;
  try {
    signalRes = await fetch(`${HTTP_URL}/ingest/signal`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${secret}`,
      },
      body: JSON.stringify({ text: "smoke ingest signal" }),
    });
  } catch (e) {
    try { wsSelf.close(); wsOther.close(); } catch {}
    fail("ingest (B7) 6a: POST /ingest/signal reachable", String(e));
    return;
  }
  if (!signalRes.ok) {
    try { wsSelf.close(); wsOther.close(); } catch {}
    fail("ingest (B7) 6a: POST /ingest/signal returns 200", `status ${signalRes.status}`);
    return;
  }
  const signalBody = await signalRes.json() as { id?: string };
  if (typeof signalBody.id !== "string") {
    try { wsSelf.close(); wsOther.close(); } catch {}
    fail("ingest (B7) 6a: response carries id", JSON.stringify(signalBody));
    return;
  }

  await new Promise((r) => setTimeout(r, 1500));

  const sigInSelf = selfFrames.slice(selfBefore).find(
    (f) => f.type === "event" && f.topic === "agent"
      && f.event?.kind === "signal" && f.event?.id === signalBody.id);
  const sigInOther = otherFrames.slice(otherBefore).find(
    (f) => f.type === "event" && f.topic === "agent"
      && f.event?.kind === "signal" && f.event?.id === signalBody.id);
  if (!sigInSelf || !sigInOther) {
    try { wsSelf.close(); wsOther.close(); } catch {}
    fail("ingest (B7) 6a: signal broadcast to both subscribers",
      `self=${!!sigInSelf} other=${!!sigInOther}`);
    return;
  }
  pass("ingest (B7) 6a: POST /ingest/signal broadcasts to all agent subscribers");

  // 6b: reply — only self should see it.
  const replyMark = selfFrames.length;
  const otherMark = otherFrames.length;
  let replyRes: Response;
  try {
    replyRes = await fetch(`${HTTP_URL}/ingest/reply`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${secret}`,
      },
      body: JSON.stringify({
        wallet: TEST_WALLET,
        text: "smoke ingest reply",
      }),
    });
  } catch (e) {
    try { wsSelf.close(); wsOther.close(); } catch {}
    fail("ingest (B7) 6b: POST /ingest/reply reachable", String(e));
    return;
  }
  if (!replyRes.ok) {
    try { wsSelf.close(); wsOther.close(); } catch {}
    fail("ingest (B7) 6b: POST /ingest/reply returns 200", `status ${replyRes.status}`);
    return;
  }
  const replyBody = await replyRes.json() as { id?: string };
  if (typeof replyBody.id !== "string") {
    try { wsSelf.close(); wsOther.close(); } catch {}
    fail("ingest (B7) 6b: response carries id", JSON.stringify(replyBody));
    return;
  }
  await new Promise((r) => setTimeout(r, 1500));
  const replyInSelf = selfFrames.slice(replyMark).find(
    (f) => f.type === "event" && f.topic === "agent"
      && f.event?.kind === "reply" && f.event?.id === replyBody.id);
  const replyInOther = otherFrames.slice(otherMark).find(
    (f) => f.type === "event" && f.topic === "agent"
      && f.event?.kind === "reply" && f.event?.id === replyBody.id);
  if (!replyInSelf) {
    try { wsSelf.close(); wsOther.close(); } catch {}
    fail("ingest (B7) 6b: reply delivered to bound wallet", `id=${replyBody.id}`);
    return;
  }
  if (replyInOther) {
    try { wsSelf.close(); wsOther.close(); } catch {}
    fail("ingest (B7) 6b: reply NOT delivered to other wallet",
      `other received id=${replyBody.id}`);
    return;
  }
  pass("ingest (B7) 6b: POST /ingest/reply delivered to target wallet only");

  // 6c: bad secret — 401, no broadcast.
  const beforeBad = selfFrames.length;
  let badRes: Response;
  try {
    badRes = await fetch(`${HTTP_URL}/ingest/signal`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer not-the-real-secret`,
      },
      body: JSON.stringify({ text: "should be rejected" }),
    });
  } catch (e) {
    try { wsSelf.close(); wsOther.close(); } catch {}
    fail("ingest (B7) 6c: POST /ingest/signal with bad secret reachable", String(e));
    return;
  }
  if (badRes.status !== 401) {
    try { wsSelf.close(); wsOther.close(); } catch {}
    fail("ingest (B7) 6c: bad secret returns 401", `status ${badRes.status}`);
    return;
  }
  await new Promise((r) => setTimeout(r, 600));
  const ghost = selfFrames.slice(beforeBad).find(
    (f) => f.type === "event" && f.topic === "agent"
      && f.event?.kind === "signal" && f.event?.text === "should be rejected");
  if (ghost) {
    try { wsSelf.close(); wsOther.close(); } catch {}
    fail("ingest (B7) 6c: bad-secret signal NOT broadcast", `got ghost id=${ghost.event?.id}`);
    return;
  }
  pass("ingest (B7) 6c: bad secret returns 401 with no broadcast");

  try { wsSelf.close(); wsOther.close(); } catch {}
}

// ---------------------------------------------------- Flow 7: rate limit (B7)
async function flowRateLimit(): Promise<void> {
  console.log("[7/7] rate limit (B7) flow");
  if (!process.env.INGEST_SECRET) {
    // The rate limit flow doesn't strictly need INGEST_SECRET, but B7 spec
    // skips both extension flows together when the secret isn't configured
    // (matches "the server isn't running B7-mode" intuition).
    console.log("  flow 7: skipped (INGEST_SECRET unset on smoke runner)");
    return;
  }

  let token: string;
  try {
    const res = await fetch(`${HTTP_URL}/auth/dev-token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wallet: TEST_WALLET }),
    });
    if (!res.ok) {
      fail("rate (B7): /auth/dev-token returns 200",
        `status ${res.status} (is AUTH_DEV_BYPASS=1?)`);
      return;
    }
    token = (await res.json() as { token?: string }).token!;
    if (typeof token !== "string") {
      fail("rate (B7): token string", String(token));
      return;
    }
  } catch (e) {
    fail("rate (B7): /auth/dev-token reachable", String(e));
    return;
  }

  // Open auth'd WS, subscribe agent, fire 25 user_messages back-to-back.
  // Expect ≤20 echoed back as `event/user`, the rest as `error/rate_limited`.
  const N = 25;
  const frames: Frame[] = [];
  const idsSent: string[] = [];
  for (let i = 0; i < N; i++) idsSent.push(`c_rate_${i}_${Math.random().toString(36).slice(2, 6)}`);
  let closeInfo: { code: number; reason: string } | null = null;

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(WS_URL);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve();
    };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ v: 1, type: "subscribe", topics: ["agent"], auth: token }));
    });
    ws.addEventListener("message", (e) => {
      let f: Frame;
      try { f = JSON.parse(typeof e.data === "string" ? e.data : String(e.data)); } catch { return; }
      frames.push(f);
      // After ack lands, fire all 25 in a tight loop.
      if (f.type === "ack" && idsSent.length > 0) {
        for (const cid of idsSent) {
          ws.send(JSON.stringify({ v: 1, type: "user_message", text: "rate burst", clientId: cid }));
        }
      }
    });
    ws.addEventListener("close", (e) => { closeInfo = { code: e.code, reason: e.reason }; settle(); });
    ws.addEventListener("error", () => {});
    setTimeout(settle, 4000);
  });

  if (closeInfo && (closeInfo as { code: number }).code !== 1000) {
    fail("rate (B7): connection stays open", `closed code=${(closeInfo as { code: number; reason: string }).code} reason=${(closeInfo as { code: number; reason: string }).reason}`);
    return;
  }
  const echoes = frames.filter(
    (f) => f.type === "event" && f.topic === "agent"
      && f.event?.kind === "user" && idsSent.includes(f.event.id));
  const limited = frames.filter(
    (f) => f.type === "error" && f.code === "rate_limited");
  if (echoes.length > 20) {
    fail("rate (B7): ≤20 echoed (bucket capacity)", `got ${echoes.length}`);
    return;
  }
  if (echoes.length === 0) {
    fail("rate (B7): some user_messages still echo (bucket isn't 0)", `got 0 echoes`);
    return;
  }
  if (limited.length === 0) {
    fail("rate (B7): excess emits rate_limited error", `got 0 rate_limited frames`);
    return;
  }
  if (echoes.length + limited.length < N) {
    fail("rate (B7): every send accounted for as echo or rate_limited",
      `echoes=${echoes.length} limited=${limited.length} sent=${N}`);
    return;
  }
  pass(`rate (B7): ${echoes.length}/${N} echoed, ${limited.length}/${N} rate_limited, no close`);
}

// ---------------------------------------------------------------------- main
(async () => {
  console.log(`smoke target: ${HTTP_URL}  ${WS_URL}`);
  console.log("");
  await flowAnon();
  await flowAuthedDevBypass();
  await flowBadToken();
  await flowVaultChain();
  await flowPersistence();
  await flowIngest();
  await flowRateLimit();
  console.log("");
  console.log(failed ? "--- summary: FAIL ---" : "--- summary: PASS ---");
  process.exit(failed ? 1 : 0);
})();
