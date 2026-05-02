// Agent topic dispatcher. Owns:
// - the in-memory ring of WireMessages (cap 500), tagged with recipient
//   (null = vault-global signal/action; wallet string = private user/reply)
//   and stamped with a monotonic insertion sequence
// - the per-connection subscriber map (cid -> { wallet, deliver })
//
// Routing:
// - kind: "signal" | "action" — broadcast to every agent subscriber
// - kind: "user" | "reply" — delivered only to the bound wallet
//
// Cursor semantics: `since.agent` is matched against an in-memory
// id -> insertion-seq map, so replay tracks insertion order rather than a
// lexicographic id compare (ULIDs and FE clientIds use different alphabets).
// If the cursor isn't in the ring (evicted or unknown), we replay all
// visible entries rather than dropping events.

import type { ActionCategory, ErrorCode, StreamFrame, TokenSymbol, WireChip, WireMessage, WireSource } from "../types";
import { ulid } from "../ulid";
import { primingHistory } from "../mocks/agent-script";
import { subscribeAgentActions, getPoolOrientation, type AgentActionEvent } from "../indexer";
import { tokenDecimals, tokenSymbolForAddress, USDC_BASE_ADDRESS } from "../chain";
import { appendAgentRingEntry, deleteAgentRingEntry, loadAllAgentRing, readSherpaUsage, writeSherpaUsage } from "../db";
import { respondToMessage } from "../agent/sherpa";

type Deliver = (f: StreamFrame) => void;

type RingEntry = {
 seq: number;
 msg: WireMessage;
 recipient: string | null;
};

const RING_CAP = 500;
const ring: RingEntry[] = [];
const idToSeq = new Map<string, number>();
let nextSeq = 1;

const subs = new Map<string, { wallet: string | null; deliver: Deliver }>();

function pushToRing(msg: WireMessage, recipient: string | null): void {
 const seq = nextSeq++;
 ring.push({ seq, msg, recipient });
 idToSeq.set(msg.id, seq);
 // Mirror to sqlite so the ring survives reboot.
 appendAgentRingEntry(seq, msg.id, recipient, JSON.stringify(msg));
 while (ring.length > RING_CAP) {
 const evicted = ring.shift()!;
 // Defensive against duplicate ids leaving a dangling entry.
 if (idToSeq.get(evicted.msg.id) === evicted.seq) {
 idToSeq.delete(evicted.msg.id);
 }
 deleteAgentRingEntry(evicted.seq);
 }
}

// Boot rehydration. Repopulates the in-memory ring + idToSeq + nextSeq
// from sqlite. Idempotent.
let ringLoaded = false;
export function loadAgentRingState(): void {
 if (ringLoaded) return;
 ringLoaded = true;
 const rows = loadAllAgentRing();
 for (const row of rows) {
 let msg: WireMessage;
 try {
 msg = JSON.parse(row.msgJson) as WireMessage;
 } catch (e) {
 console.warn(`[agent] dropping unparsable ring row seq=${row.seq}: ${e instanceof Error ? e.message : String(e)}`);
 continue;
 }
 ring.push({ seq: row.seq, msg, recipient: row.recipient });
 idToSeq.set(row.id, row.seq);
 if (row.seq >= nextSeq) nextSeq = row.seq + 1;
 }
 if (rows.length > 0) {
 console.log(`[agent] loaded ${rows.length} ring entries from sqlite (nextSeq=${nextSeq})`);
 }
}

export function subscribeAgent(cid: string, wallet: string | null, deliver: Deliver): void {
 subs.set(cid, { wallet, deliver });
}

export function unsubscribeAgent(cid: string): void {
 subs.delete(cid);
}

// If the connection re-auths mid-session, update the wallet binding
// without recreating the subscription.
export function bindWallet(cid: string, wallet: string): void {
 const sub = subs.get(cid);
 if (sub) sub.wallet = wallet;
}

export function agentHistoryFrame(since: string | undefined, wallet: string | null): StreamFrame {
 // Lookup `since` -> insertion seq. If absent (cursor not in ring), replay
 // everything we still have rather than swallowing post-cursor events.
 const sinceSeq = since !== undefined ? idToSeq.get(since) : undefined;
 const events: WireMessage[] = [];
 for (const entry of ring) {
 if (sinceSeq !== undefined && entry.seq <= sinceSeq) continue;
 if (entry.recipient === null) {
 events.push(entry.msg);
 } else if (wallet !== null && entry.recipient === wallet) {
 events.push(entry.msg);
 }
 }
 const cursor = events.length > 0 ? events[events.length - 1]!.id : undefined;
 return { v: 1, type: "history", topic: "agent", events, ...(cursor !== undefined ? { cursor } : {}) };
}

function broadcastGlobal(msg: WireMessage): void {
 pushToRing(msg, null);
 const frame: StreamFrame = { v: 1, type: "event", topic: "agent", event: msg };
 for (const { deliver } of subs.values()) deliver(frame);
}

function deliverPrivate(cid: string, msg: WireMessage, wallet: string): void {
 pushToRing(msg, wallet);
 const sub = subs.get(cid);
 if (!sub) return;
 sub.deliver({ v: 1, type: "event", topic: "agent", event: msg });
}

// Fan out to ALL connections bound to the target wallet (multiple browser
// tabs). Used by the agent ingest API for replies that aren't tied to a
// specific cid. Pushes to the ring exactly once regardless of how many
// subscribers are bound to the wallet.
export function deliverPrivateToWallet(wallet: string, msg: WireMessage): void {
 pushToRing(msg, wallet);
 const target = wallet.toLowerCase();
 const frame: StreamFrame = { v: 1, type: "event", topic: "agent", event: msg };
 for (const sub of subs.values()) {
 if (sub.wallet !== null && sub.wallet.toLowerCase() === target) {
 sub.deliver(frame);
 }
 }
}

// Agent ingest publish entrypoints. Mint id, build WireMessage, dispatch
// through the ring + broadcast/private plumbing. Returns the id so the
// HTTP handler can echo it back.
export function publishIngestSignal(
 text: string,
 opts: { ts?: string; sources?: WireSource[] } = {},
): string {
 const msg: WireMessage = {
 id: ulid(),
 ts: opts.ts ?? new Date().toISOString(),
 kind: "signal",
 text,
 ...(opts.sources !== undefined ? { sources: opts.sources } : {}),
 };
 broadcastGlobal(msg);
 return msg.id;
}

export function publishIngestReply(
 wallet: string,
 text: string,
 opts: { replyTo?: string; sources?: WireSource[]; ts?: string } = {},
): string {
 const msg: WireMessage = {
 id: ulid(),
 ts: opts.ts ?? new Date().toISOString(),
 kind: "reply",
 text,
 ...(opts.replyTo !== undefined ? { replyTo: opts.replyTo } : {}),
 ...(opts.sources !== undefined ? { sources: opts.sources } : {}),
 };
 deliverPrivateToWallet(wallet, msg);
 return msg.id;
}

// Observability for /health.
export function agentRingSize(): number {
 return ring.length;
}

// Sherpa rate limits, per wallet:
// - 20s cooldown between messages (anti-spam; also lets the LLM finish
//   replying before the next request piles up)
// - 5 messages per UTC day (cost cap on the claude subprocess)
//
// Checked AFTER the user-msg echo so the chat history reads coherently.
// Counters live in sqlite and survive reboot.
const SHERPA_COOLDOWN_MS = 20_000;
const SHERPA_DAILY_CAP = 5;

function todayUtc(): string {
 return new Date().toISOString().slice(0, 10);
}

// Echo the user's message + invoke Sherpa for a real reply. If the claude
// subprocess fails (missing binary, transient error, timeout) we emit a
// single short apology rather than scripted prose.
export function handleUserMessage(cid: string, wallet: string, text: string, clientId: string): void {
 const userMsg: WireMessage = {
 id: clientId,
 ts: new Date().toISOString(),
 kind: "user",
 text,
 };
 deliverPrivate(cid, userMsg, wallet);

 // Per-wallet rate limit. Hits emit an `error` frame on the same cid;
 // the connection stays open per the recoverable-error doctrine.
 const walletKey = wallet.toLowerCase();
 const day = todayUtc();
 const usage = readSherpaUsage(walletKey, day);
 const now = Date.now();
 if (usage) {
 if (usage.count >= SHERPA_DAILY_CAP) {
 sendErrorToCid(cid, "rate_limited", "Daily Sherpa limit reached (5/day). Try again tomorrow.");
 return;
 }
 const sinceLastMs = now - usage.lastMsgMs;
 if (sinceLastMs < SHERPA_COOLDOWN_MS) {
 const waitS = Math.ceil((SHERPA_COOLDOWN_MS - sinceLastMs) / 1000);
 sendErrorToCid(cid, "rate_limited", `Sherpa is still thinking. Wait ${waitS}s.`);
 return;
 }
 }
 // Increment optimistically: a failed LLM call still counts (user clicked
 // send), and this closes the double-spend window where two parallel sends
 // both pass the pre-check.
 const nextCount = (usage?.count ?? 0) + 1;
 writeSherpaUsage(walletKey, day, nextCount, now);

 // Pull the last few action events out of the ring as context for Sherpa.
 // Vault-global only (recipient null), most-recent-N.
 const recentActions = ring
 .filter((e) => e.recipient === null && e.msg.kind === "action")
 .slice(-8)
 .map((e) => {
 const m = e.msg as Extract<WireMessage, { kind: "action" }>;
 return `${m.ts} ${m.title}: ${m.text}`;
 });

 // Reply id is a fresh ULID; replyTo points at the user's clientId so
 // the FE can render the reply-thread relationship.
 void respondToMessage(walletKey, text, recentActions)
 .then((replyText) => {
 const reply: WireMessage = {
 id: ulid(),
 ts: new Date().toISOString(),
 kind: "reply",
 text: replyText,
 replyTo: clientId,
 };
 deliverPrivate(cid, reply, wallet);
 })
 .catch((err) => {
 console.warn(`[sherpa] subprocess failed: ${err instanceof Error ? err.message : String(err)}`);
 // Daily counter is not refunded on failure.
 const reply: WireMessage = {
 id: ulid(),
 ts: new Date().toISOString(),
 kind: "reply",
 text: "Sorry, I'm not available right now.",
 replyTo: clientId,
 };
 deliverPrivate(cid, reply, wallet);
 });
}

function sendErrorToCid(cid: string, code: ErrorCode, message: string): void {
 const sub = subs.get(cid);
 if (!sub) return;
 sub.deliver({ v: 1, type: "error", code, message });
}

// Chain-action bridge. Subscribes to the indexer's agent-action stream,
// translates each event into a WireMessage carrying the real tx hash, and
// pushes through the ring + broadcast plumbing. Action WireMessages are
// never fabricated: every dispatch corresponds to a log the indexer folded.
let actionBridgeStarted = false;
export function startAgentActionBridge(): void {
 if (actionBridgeStarted) return;
 actionBridgeStarted = true;
 subscribeAgentActions((evt) => {
 const msg = buildActionMessage(evt);
 if (!msg) return;
 broadcastGlobal(msg);
 });
}

function buildActionMessage(evt: AgentActionEvent): WireMessage | null {
 const id = `chain_${evt.blockNumber.toString().padStart(10, "0")}_${evt.logIndex.toString().padStart(4, "0")}`;
 const ts = new Date(evt.blockTs * 1000).toISOString();
 const tx = evt.tx;

 if (evt.kind === "swapped") {
 const tokenInSym = tokenSymbolForAddress(evt.tokenIn);
 // ALPVault always swaps between USDC and the pool's non-base token.
 // If orientation is missing, fall back to USDC for the unknown side.
 const orient = getPoolOrientation(evt.poolKey);
 let tokenOutAddr: string;
 if (evt.tokenIn === USDC_BASE_ADDRESS) {
 tokenOutAddr = orient ? orient.nonBaseToken : USDC_BASE_ADDRESS;
 } else {
 tokenOutAddr = USDC_BASE_ADDRESS;
 }
 const tokenOutSym = tokenSymbolForAddress(tokenOutAddr);
 const inAmt = formatAmount(evt.amountIn, tokenDecimals(tokenInSym));
 const outAmt = formatAmount(evt.amountOut, tokenDecimals(tokenOutSym));
 return {
 id, ts, kind: "action",
 title: "Swapped",
 category: "swap" satisfies ActionCategory,
 chip: { type: "pair", left: tokenInSym, right: tokenOutSym },
 tx,
 text: `Swapped ${inAmt} ${tokenInSym} → ${outAmt} ${tokenOutSym}`,
 };
 }

 // Liquidity / fee / position-tracking events share USDC-paired chip
 // construction off the pool's orientation.
 const orient = getPoolOrientation(evt.poolKey);
 let token0Sym: TokenSymbol;
 let token1Sym: TokenSymbol;
 let nonBaseSym: TokenSymbol;
 if (orient) {
 nonBaseSym = tokenSymbolForAddress(orient.nonBaseToken);
 token0Sym = orient.usdcIsToken0 ? "USDC" : nonBaseSym;
 token1Sym = orient.usdcIsToken0 ? nonBaseSym : "USDC";
 } else {
 // PoolTracked precedes any action event for the pool, and applyLogs
 // sorts by (block, logIndex), so this should not happen in practice.
 console.warn(`[agent] action event for untracked pool ${evt.poolKey} — chip falls back to USDC/USDC`);
 nonBaseSym = "USDC";
 token0Sym = "USDC";
 token1Sym = "USDC";
 }
 const chip: WireChip = { type: "pair", left: token0Sym, right: token1Sym };
 const pairLabel = `${nonBaseSym}/USDC`;

 if (evt.kind === "liquidity_added") {
 const a0 = formatAmount(evt.amount0, tokenDecimals(token0Sym));
 const a1 = formatAmount(evt.amount1, tokenDecimals(token1Sym));
 return {
 id, ts, kind: "action",
 title: "Added liquidity",
 category: "edit_position",
 chip, tx,
 text: `Added ${a0} ${token0Sym} + ${a1} ${token1Sym} to ${pairLabel}`,
 };
 }
 if (evt.kind === "liquidity_removed") {
 const a0 = formatAmount(evt.amount0, tokenDecimals(token0Sym));
 const a1 = formatAmount(evt.amount1, tokenDecimals(token1Sym));
 return {
 id, ts, kind: "action",
 title: "Removed liquidity",
 category: "edit_position",
 chip, tx,
 text: `Removed ${a0} ${token0Sym} + ${a1} ${token1Sym} from ${pairLabel}`,
 };
 }
 if (evt.kind === "fees_collected") {
 const a0 = formatAmount(evt.amount0, tokenDecimals(token0Sym));
 const a1 = formatAmount(evt.amount1, tokenDecimals(token1Sym));
 return {
 id, ts, kind: "action",
 title: "Collected fees",
 category: "claim_fees",
 chip, tx,
 text: `Collected ${a0} ${token0Sym} + ${a1} ${token1Sym} from ${pairLabel}`,
 };
 }
 if (evt.kind === "position_tracked") {
 return {
 id, ts, kind: "action",
 title: "Tracked position",
 category: "edit_position",
 chip, tx,
 text: `Started tracking position #${evt.positionId.toString()} in ${pairLabel}`,
 };
 }
 if (evt.kind === "position_untracked") {
 return {
 id, ts, kind: "action",
 title: "Untracked position",
 category: "edit_position",
 chip, tx,
 text: `Stopped tracking position #${evt.positionId.toString()} in ${pairLabel}`,
 };
 }
 return null;
}

// 4 sig-fig humanised formatter with K/M/B suffixes, no trailing zeros, no
// scientific. e.g. 1.234567M → "1.235M"; 12.345K → "12.35K".
function formatAmount(raw: bigint, decimals: number): string {
 if (raw === 0n) return "0";
 const human = Number(raw) / Math.pow(10, decimals);
 const abs = Math.abs(human);
 if (abs >= 1e9) return `${trimSig(human / 1e9, 4)}B`;
 if (abs >= 1e6) return `${trimSig(human / 1e6, 4)}M`;
 if (abs >= 1e3) return `${trimSig(human / 1e3, 4)}K`;
 return trimSig(human, 4);
}

function trimSig(n: number, sig: number): string {
 if (n === 0) return "0";
 return Number(n.toPrecision(sig)).toString();
}

let scriptStarted = false;
export function startAgentScript(): void {
 if (scriptStarted) return;
 scriptStarted = true;

 // primingHistory() currently returns []; the seed loop stays as the splice
 // point if a scripted source ever wants to reseed the ring on a fresh
 // boot. Chain action events flow through startAgentActionBridge; agent
 // narration arrives via /ingest/{signal,reply}.
 if (ring.length === 0) {
 for (const msg of primingHistory()) pushToRing(msg, null);
 }
}
