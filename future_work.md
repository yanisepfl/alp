# ALP — Post-demo cleanup list

Audit window: branch `feat/frontend-backend-integration` @ `c9695dc`. Demo ships this weekend; nothing in here is blocking. Contracts (`contracts/`) and the Cloudflare worker (`agent/`) are out of scope — Yanis owns those.

---

## 0. Seed entries (operator-known)

### Sherpa `/agent/dryrun` integration
Yanis's worker exposes `https://alp-agent.alphix.workers.dev/agent/dryrun` (read-only, no auth). Fetch it inside `backend/src/agent/sherpa.ts:formatVaultBlock` (or a new `formatAgentBlock`) and surface the keeper's planned next action in Sherpa's prompt block — replaces generic "I'm watching ETH/USDC" with "ETH/USDC ~3% from out-of-range, no action needed". Cost: ~200ms per Sherpa call, one fetch + one prompt-template block. Cache for 30s so a burst of chat doesn't fan out N requests.

### Sherpa pool-profile context
`agent/pools.local.json` tags each pool with `profile: "stable" | "mid"`. Mirror as a hardcoded map in the backend keyed on pool slug/label, append a one-liner per pool to Sherpa's vault block: `USDC/USDT 0.01% — stable profile (±8 ticks)`. Lets Sherpa explain why widths differ across the basket.

---

## 1. 🔧 Quick wins (< 30 min each)

- **Drop `getDevToken` from public exports** — `frontend/lib/api/index.ts` only re-exports `getAuthSession`, but `frontend/lib/api/auth.ts:193` still ships `getDevToken`. Either re-export or strip — right now it's a public symbol no caller uses.
- **Magic number `30_000` in Sherpa thinking timeout** — [page.tsx:2917](alp/frontend/app/app/page.tsx#L2917) hardcodes the 30s spinner timeout. Backend sets `SUBPROCESS_TIMEOUT_MS = 25_000` ([sherpa.ts:23](alp/backend/src/agent/sherpa.ts#L23)). Pull into a shared constant or at least wire the FE off backend's value via a `/health` field.
- **`Vault: 0xA1b2…f9c8` placeholder in footer** — [page.tsx:3405](alp/frontend/app/app/page.tsx#L3405) ships a hardcoded fake address in the footer link. Should read `VAULT_ADDRESS` and link to basescan.
- **Footer vault link `href="#"`** — same line, no real href. Click does nothing.
- **Hardcoded `TX_BASE_URL`** — [page.tsx:1921](alp/frontend/app/app/page.tsx#L1921) literal `"https://basescan.org/tx/"`. One-liner to env-var.
- **Strip `/auth/dev-token` from FE auth.ts** — pre-SIWE artefact at [auth.ts:193-213](alp/frontend/lib/api/auth.ts#L193). The bridge no longer calls it; comment says "scripts only" but it lives in the FE bundle.
- **Hardcoded `chainId: 8453` in SIWE builder** — [auth.ts:115](alp/frontend/lib/api/auth.ts#L115). Should pull from wagmi config so a Sepolia rebuild doesn't silently mint mainnet-bound JWTs.
- **Prune `console.log` boot banner** — [index.ts:183-188](alp/backend/src/index.ts#L183) logs `localhost:${port}` even on the GCP VM where users will see `localhost:8787` in logs. Cosmetic, noisy in journalctl.
- **Toast `transform: translateY(1px)` baseline fudge** — [toast.tsx:118](alp/frontend/lib/toast.tsx#L118). Documented as Inter-baseline compensation. Audit if Inter font swaps; if it ever does, the dot will visibly drift.

## 2. 🐛 Latent bugs

- **Same-block deposit→redeem reverts unprompted** — `ALPVault._lastMintBlock` ([ALPVault.sol:92](alp/contracts/src/ALPVault.sol#L92)) refuses a redeem in the same block as a mint. UI doesn't surface this; user who deposits and immediately tries to withdraw sees "Withdrawal failed, try again" with no hint. Detect via `useReadContract` on `_lastMintBlock`, or just toast a guidance message.
- **Withdraw quote ignores `entryExitFeeBps`** — [page.tsx:1461](alp/frontend/app/app/page.tsx#L1461) computes `usdcOut = num * sharePrice`. Contract has `previewRedeem(shares)` returning `gross - fee` ([ALPVault.sol:937](alp/contracts/src/ALPVault.sol#L937)). Owner can flip `entryExitFeeBps` ≤200bps; the displayed receive-amount will diverge from the actual settlement. Same on the deposit side (`previewDeposit`).
- **Multi-tab Sherpa daily-cap race** — backend cap enforced server-side per wallet/day (sqlite, [agent.ts:222](alp/backend/src/topics/agent.ts#L222)), but FE tracks usage in `localStorage` per tab/origin ([page.tsx:2836](alp/frontend/app/app/page.tsx#L2836)). Two tabs on the same wallet desync until the server emits `rate_limited`. Use sessionStorage→state plumbing that picks up the count from a backend snapshot or from the WS history rather than local-only.
- **Midnight UTC tab-rollover poll uses 60s interval** — [page.tsx:2935-2946](alp/frontend/app/app/page.tsx#L2935). At 23:59:30 the user has 30s of stale "0 left" or stale "5 left" depending on which side of midnight they sit. Compute the next midnight and `setTimeout` to it instead of polling.
- **`handleUserMessage` counter is double-spend safe but never refunds** — [agent.ts:237](alp/backend/src/topics/agent.ts#L237) increments before the LLM call; on subprocess failure the canned fallback fires but the count stays incremented. Documented as intentional, but the FE shows "1 message left" while the only response was the dumb canned one. Either refund on `cannedReply` path or surface "fallback response" as a different reply kind.
- **`subs.get(cid)` in `sendErrorToCid` silently no-ops on stale cid** — [agent.ts:280-283](alp/backend/src/topics/agent.ts#L280). If the user disconnects between `handleUserMessage` and the rate-limit dispatch, the rate-limit error vanishes. Acceptable, but worth a debug log.
- **`dropping unparsable ring row` increments seq counter without backfilling** — [agent.ts:77](alp/backend/src/topics/agent.ts#L77). After eviction-by-parse-failure on boot, `nextSeq` is set from the last *successful* row but the dropped seq slot is gone forever. Cursor replay of the dropped seq is treated as "evicted" (replay all) which is fine, but logs the warning every reboot until the row is manually deleted.
- **`agentMessages.some(m => m.id === e.id)` is O(N) per event** — [client.ts:159](alp/frontend/lib/api/client.ts#L159) and [hooks.ts:158-164](alp/frontend/lib/api/hooks.ts#L158) both linear-scan a 500-entry buffer per inbound frame. Once the live signal cadence picks up this is wasted CPU on every Now bar tick. `Set<id>` mirror is a one-line fix.
- **`forceReconnect()` race with in-flight subscribe** — [client.ts:275](alp/frontend/lib/api/client.ts#L275) closes the socket without awaiting any pending `issueSubscribe`; if a subscribe was sent but not yet ack'd, FE may treat the next ack as a fresh subscribe response when it's actually an artefact of the previous connection. Low risk in practice but possible during wallet swap.
- **`signal === "SIGINT"` branch on Windows** — [index.ts:209-210](alp/backend/src/index.ts#L209). Backend runs on a Linux VM so this is fine for prod, but if anyone tries `bun dev` on Windows the signal never fires and db never closes cleanly.
- **`useAuthBridge` dep-array pins on `signMessageAsync`** — [auth-bridge.ts:106](alp/frontend/lib/api/auth-bridge.ts#L106). wagmi rebinds this on every render, so the address-change effect re-evaluates more than necessary. Functional today (the `prev === cur` guard makes it idempotent) but wasteful.
- **`ws://` mixed-content if FE ever ships over HTTPS** — `.env.local` ships `ws://34.56.237.168:8787/stream`. The FE is currently localhost:3000 (also http) so this works. The moment frontend goes to a Vercel preview the browser blocks the WSS upgrade.

## 3. 🧹 Polish

- **`page.tsx` is 3,839 lines** — split into `app/app/components/{VaultCard,UserPositionCard,UserAprCard,UserActivityCard,WithdrawModal,AgentChatPanel,DashboardPanel,FloatingNav,FooterStrip,SidebarTabs}.tsx`, plus `agent-message.ts` for the wire→view adapter.
- **Duplicated dot-grid background** — `radial-gradient(circle, rgba(255,255,255,0.10) 0.7px, transparent 1.1px) / 9px 9px` appears 6+ times across `VaultCard`, `WithdrawModal`, `UserActivityCard`, `MessageView` action bubbles, etc. Pull into a CSS class or styled wrapper.
- **`isUserRejection` is reimplemented twice** — [auth.ts:76](alp/frontend/lib/api/auth.ts#L76) and [page.tsx:46](alp/frontend/app/app/page.tsx#L46). Subtly different (auth.ts checks 2 levels, page.tsx walks 10 levels and regex-matches). Pick one.
- **Stale phase comments** — [hooks.ts:188](alp/frontend/lib/api/hooks.ts#L188) "Phase 7c implementation" inside `setApiAuthToken`. Phase comments litter the codebase (`Phase 7a/b/c/d/e`, `B1`/`B3`/`B3b`/`B5`/`B6`/`B7`). Once the demo ships these reference an internal milestone schema no future maintainer will care about. Sweep.
- **`fmtNum` vs `fmtUsd2` vs `formatAmount` vs `trimSig`** — three different number formatters in FE and one in backend. Centralise.
- **Inline `<style>{`...`}</style>` blocks** — animations + scrollbar styles dumped into JSX strings. Move to globals.css or a CSS module.
- **`scriptStarted`, `actionBridgeStarted`, `chainReaderStarted`, `mockTickerStarted`, `ringLoaded`, `nonceSweeperStarted` flags** — six different module-level idempotence flags across `topics/agent.ts`, `topics/vault.ts`, `auth.ts`. One generic `once()` wrapper would do.
- **`TODO` density** — backend has zero TODOs (good). FE has zero TODOs (good). But "phase X limitation" comments effectively serve the same role and should either become real TODOs or be deleted.
- **`agentRingSize()` used only for /health** — single-export function on agent topic, low value. Inline.

## 4. 🔒 Security / hygiene

- **🚨 Owner private key may have been pasted into chat history** — operator (Carl) self-flagged this at one point during the project. Whichever wallet currently owns ALPVault should be **rotated to a fresh keypair before public traffic** via Ownable2Step's `transferOwnership`. The committed code does NOT contain this key — it lives in chat scrollback / shell history / a paste buffer. Action: `cast wallet new`, transfer ownership, then `revoke approve` any allowances the old EOA still holds.
- **`NEXT_PUBLIC_VAULT_ADDRESS` is the zero address in `.env.local`** — [.env.local:3](alp/frontend/.env.local#L3) ships `0x0000…0000`, but the operator says vault is deployed at `0x3F0e6cef3a75f52F1E55806Afe40317f51199CaE`. **If demo runs from this file, every deposit/redeem write will target the zero address and fail/burn USDC.** Fix before demo.
- **`AGENT_PRIVATE_KEY` in `scripts/local-fork.sh`** — `0x59c6995e998f97a5a…` is anvil's deterministic dev account #1 (well-known, no real funds). Fine, but flag in the commit message so a reader doesn't panic-rotate it.
- **`AUTH_DEV_BYPASS=1` mode mints unsigned JWTs** — [routes/auth.ts logic, .env.example:23]. Production guard relies on the env var being `0` or unset. Add a startup assert that refuses to boot with `AUTH_DEV_BYPASS=1` AND `BASE_RPC_URL` pointing at mainnet.
- **`JWT_SECRET` only validated for length, not entropy** — backend [index.ts:30](alp/backend/src/index.ts#L30) requires ≥32 chars. A user could legally set `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (32 a's). Not worth fixing for the demo, but document.
- **`/ingest/*` has no CORS but also no IP allowlist** — comment at [index.ts:66](alp/backend/src/index.ts#L66) says "agent runs on a private host". The VM's port 8787 is publicly reachable on `34.56.237.168`; only the `INGEST_SECRET` gate stops anyone from publishing fake `signal`/`reply` frames into every connected user's chat. Acceptable for the demo with a strong secret; flag for prod.
- **No rate limit on `/auth/nonce`** — anyone can spray nonces and pollute the `auth_nonces` sqlite table. Sweeper exists ([startNonceSweeper](alp/backend/src/auth.ts)) but pre-sweep memory pressure is real. Add an IP-based bucket.
- **WS frame size unbounded** — FE can send arbitrarily large `user_message` text. Sherpa subprocess shell-quotes it via Bun's `spawn` argv (safe from injection), but the prompt window itself isn't capped. Add a max-length check before invoking `claude`.
- **localStorage `alp:sherpa-usage` is trivially editable** — [page.tsx:2836](alp/frontend/app/app/page.tsx#L2836). Server is the source of truth so no exploit, but if anyone ever reuses this counter for actual gating, treat as untrusted.

## 5. ♻️ Architectural debt

- **Cross-track constant drift** — `SHERPA_DAILY_CAP=5` and `SHERPA_COOLDOWN_MS=20_000` are duplicated in [agent.ts:194-195](alp/backend/src/topics/agent.ts#L194) and [page.tsx:2834-2835](alp/frontend/app/app/page.tsx#L2834). `RING_CAP=500` (backend [agent.ts:39](alp/backend/src/topics/agent.ts#L39)) and `AGENT_RING_CAP=500` (FE [client.ts:63](alp/frontend/lib/api/client.ts#L63)). Send these in the priming `ack` frame so FE picks them up at runtime.
- **`vaultAbi` is hand-rolled and minimal** — [contracts.ts:36-72](alp/frontend/lib/contracts.ts#L36) only exposes `deposit`/`redeem`/`convertToShares`/`convertToAssets`. Missing `previewDeposit`, `previewRedeem`, `previewWithdraw`, `previewMint`, `entryExitFeeBps`, `paused`, `_lastMintBlock`, `redeemInKind`, `withdrawWithMax`, `redeemWithMin`. Either generate the ABI from the contract artefact or curate as features need it. (Not "ABI drift" today — events the indexer reads match exactly.)
- **`UserSnapshot` carries no preview fields** — backend computes `valueUsd` as `shares * sharePrice`, FE can't distinguish "would-redeem-receive" from "raw value". Adding a `previewRedeemUsd` field on the user snapshot decouples FE from the contract preview math.
- **Subprocess-based Sherpa** — [sherpa.ts:7-12](alp/backend/src/agent/sherpa.ts#L7) is honest about this: spawn `claude -p` because the operator has a logged-in seat. Post-demo, switch to the Anthropic SDK with `ANTHROPIC_API_KEY`, prompt caching on the system prompt + vault block, and a real streaming reply path. Frees up the 25s subprocess timeout for streaming and removes the "is `claude --allowed-tools \"\"` valid syntax for THIS Claude Code version on the VM" question entirely.
- **Stub client and live client share no test surface** — `frontend/lib/api/stub.ts` is hand-maintained next to `client.ts`. They've already drifted (e.g. stub doesn't model `error`-frame routing). Either delete the stub (set `NEXT_PUBLIC_SHERPA_WSS_URL` and run against a local backend) or generate it from the same wire types.
- **`sherpa_usage` table grows without bound** — [db.ts:108](alp/backend/src/db.ts#L108). One row per (wallet, day). Six months of daily users will accumulate quietly. Either prune rows older than 30 days or include `sherpa_usage` in the existing fee-events prune sweep.
- **`block_ts` cache also grows without bound** — every block timestamp the indexer touches gets a row, never evicted. Slow burn but real.
- **`useEffect` dependency on `agentError` retriggers on every error frame** — [page.tsx:2953-2969](alp/frontend/app/app/page.tsx#L2953). React strict mode in dev fires this twice; once errors are "live" rather than rare, every frame causes a state update plus a toast. Convert to a callback-passed `onError` on the agent subscription instead of the snapshotted error state.
- **Single 3000+ line page tightly couples wagmi state, WSS state, layout primitives, and animation choreography** — splitting this is a real refactor, not a quick win.

---

## Audit notes

### ⚠️ DEMO-RISK

- **⚠️ DEMO-RISK: `frontend/.env.local` ships zero-address vault.** `NEXT_PUBLIC_VAULT_ADDRESS=0x0000…0000` ([.env.local:3](alp/frontend/.env.local#L3)). Real deployed vault is `0x3F0e6cef3a75f52F1E55806Afe40317f51199CaE` per operator. Update before booting the FE for the demo or the deposit CTA approves USDC against the zero address. Also note that `lib/contracts.ts` will *boot* with this value (the regex passes) but every write call will revert at the chain.
- **⚠️ DEMO-RISK: Sherpa relies on `claude` CLI being on `$PATH` of the unix user running bun on the VM.** No fallback if the binary is absent — `respondToMessage` throws, the `cannedReply` fallback fires. If the demo flow includes "ask Sherpa a question", verify the binary is reachable as the bun-process owner and the model alias `claude-sonnet-4-6` is valid for the installed Claude Code version. Worth `ssh ... -- claude --version` before going on stage.
- **⚠️ DEMO-RISK: `claude --allowed-tools ""` syntax may not be honored.** [sherpa.ts:142](alp/backend/src/agent/sherpa.ts#L142). If passing an empty string isn't recognised, Sherpa could inadvertently have full Claude Code tool access — including running bash on the VM. The system prompt instructs "never call any tools" but that's a prompt-level mitigation, not a sandbox. Verify with `claude -p test --allowed-tools ""` on the VM and inspect.
- **⚠️ DEMO-RISK: same-block deposit→redeem reverts.** Documented latent bug above. If the demo script includes "deposit, then immediately withdraw to show it works", it'll fail. Either insert a 2s pause / wait-for-receipt+block-1 in the flow, or accept the toast.
- **⚠️ DEMO-RISK: WSS endpoint `ws://34.56.237.168:8787/stream` is plain ws.** Localhost FE on http is fine. If anyone demos through a `https://` FE deployment (Vercel preview share), the browser blocks the upgrade and the entire dashboard reads as disconnected.

### Working better than expected

- **Phase 7a transport audit** — `client.ts` is honest about the three-doctrine error model (`ack.rejected[]` vs `error` frame vs WS close code) and correctly distinguishes fatal codes (4001/4003/4400) from recoverable ones. Rare for hackathon WS plumbing.
- **SIWE bridge** — `auth-bridge.ts` covers the four address-state transitions (none↔none / none→addr / addr→none / addr→addr) explicitly, with a single re-mint-on-4001 listener that reads addresses through refs to avoid stale closures. Solid.
- **Agent ring sqlite persistence (B6)** — survives reboot, idempotent boot rehydration, eviction is mirrored to disk. Comment density on `idToSeq` is exactly right.
- **ALPVault preview math with fee direction baked in** — `previewDeposit`/`previewRedeem`/`previewMint`/`previewWithdraw` overrides ([ALPVault.sol:906-940](alp/contracts/src/ALPVault.sol#L906)) all gross-up correctly. The FE just never reads them.
- **Recoverable-error doctrine documented in CONTRACT** — even though the doc isn't open in this branch, the `client.ts` header captures it well enough to onboard a new FE engineer in 5 minutes.
- **Indexer's `applyLogs` block ordering** — guaranteeing `PoolTracked` runs before any same-block `LiquidityAdded`/`Swapped` via natural sort order is the kind of subtle invariant that's easy to get wrong; it's correct here.
- **`isUserRejection` walks the cause chain** — the FE version walks 10 levels deep with a regex fallback ([page.tsx:46](alp/frontend/app/app/page.tsx#L46)). Wallet vendors wrap rejections inconsistently and this catches them all.

### Open questions for the team

1. **Is `claude --allowed-tools ""` (empty string) the right sandbox flag for the Claude Code version installed on the VM?** Or should it be `--allowed-tools none`, or should we use `--disallowed-tools "*"` instead? Verify from `claude --help` on the deployed instance.
2. **Does `claude-sonnet-4-6` resolve correctly from the operator's `claude` CLI**, or is there a separate alias they prefer? The model string is in `Bun.env.SHERPA_MODEL ?? "claude-sonnet-4-6"`, override is possible but the default needs to actually resolve.
3. **Should `sherpa_usage` rows be pruned after N days?** No prune sweep exists; the table will grow forever. What's the retention policy?
4. **Should the FE display `previewRedeem` from the contract instead of `shares * sharePrice`?** Once `entryExitFeeBps` is non-zero this matters; for the demo it's zero.
5. **Is the agent's `/agent/dryrun` endpoint stable enough to surface in Sherpa context, or does it have failure modes that could leak into chat replies?** A 5xx during a Sherpa call should fall through to the existing format silently; needs verification.
6. **Wallet rotation for the contract owner — has it happened post-key-leak, or is this still a demo-day TODO?** If still pending, who's holding the new private key and on what hardware?
7. **Multi-tab Sherpa cap — is per-wallet-per-day acceptable, or should it be per-wallet across all tabs in real-time?** The current design already enforces backend-side, but the UX is a touch incoherent across tabs.
8. **Is the agent ring's 500-entry cap going to hold up over a multi-day demo window?** A 30s signal cadence puts ~2,880 events/day; the ring will roll over inside 4 hours of agent activity. Acceptable, but the cursor-replay UX after a tab being closed for >4h is "you missed everything".
